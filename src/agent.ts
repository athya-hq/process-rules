import type { Sys } from './types.ts';

/** The adopting repo's settings file, written by `onboard`. */
export const SETTINGS_PATH = '.github/process-rules.json';
/** The keychain item holding the agent account's token: service, account = login. */
export const KEYCHAIN_SERVICE = 'process-rules';
/** What GH_TOKEN holds when the keychain has no token, so nothing falls back to the owner. */
export const NO_TOKEN = 'process-rules-no-agent-token';
const SECURITY = '/usr/bin/security';
export const API = 'https://api.github.com';
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** The classic-token scopes an agent account needs (docs/decisions.md). */
export const TOKEN_SCOPES = ['repo', 'workflow', 'read:org', 'project', 'write:ssh_signing_key'];
/** Broader scopes that include a needed one. */
const INCLUDED_BY: Record<string, string[]> = {
  'read:org': ['write:org', 'admin:org'],
  'write:ssh_signing_key': ['admin:ssh_signing_key'],
};
/** Days before a token ends that `doctor` warns and `machine` offers a new one. */
export const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;
/** What a session runs instead of ssh: GitHub goes over HTTPS, so no SSH key of the owner's is used. */
export const NO_SSH = `echo 'process-rules: SSH is off in agent sessions; GitHub goes over HTTPS' >&2; false`;

/** GitHub logins are case-insensitive. */
export function sameLogin(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

export interface Settings {
  owner: string;
  agent: string;
}

/** Reads and checks the settings file at `root`; throws with the reason. */
export function loadSettings(sys: Sys, root: string): Settings {
  const path = `${root}/${SETTINGS_PATH}`;
  if (!sys.exists(path)) {
    throw new Error(`${SETTINGS_PATH} not found in ${root}`);
  }
  const raw: unknown = JSON.parse(sys.read(path));
  const owner = field(raw, 'owner');
  const agent = field(raw, 'agent');
  if (sameLogin(owner, agent)) {
    throw new Error(`${SETTINGS_PATH}: owner and agent must be different accounts`);
  }
  return { owner, agent };
}

function field(raw: unknown, name: string): string {
  const value =
    typeof raw === 'object' && raw !== null && name in raw
      ? (raw as Record<string, unknown>)[name]
      : undefined;
  if (typeof value !== 'string' || !LOGIN.test(value)) {
    throw new Error(`${SETTINGS_PATH}: "${name}" must be a GitHub login`);
  }
  return value;
}

/**
 * The agent account a command acts for: the login named after it, else the
 * one the settings file of the repo around the working directory names.
 */
export function agentFrom(sys: Sys, named: string | undefined): string {
  if (named !== undefined) {
    if (!LOGIN.test(named)) throw new Error(`"${named}" is not a GitHub login`);
    return named;
  }
  const top = sys.exec('git', ['rev-parse', '--show-toplevel'], { cwd: sys.cwd });
  const root = top.stdout.trim();
  if (top.code !== 0 || !sys.exists(`${root}/${SETTINGS_PATH}`)) {
    throw new Error(`name the agent account after the command, or run it in a repo whose ${SETTINGS_PATH} names one`);
  }
  return loadSettings(sys, root).agent;
}

export interface Paths {
  key: string;
  dir: string;
  session: string;
  gh: string;
}

/** Where `machine` keeps an agent account's files on this machine: one folder per account. */
export function pathsFor(home: string, agent: string): Paths {
  const dir = `${home}/.config/process-rules/${agent.toLowerCase()}`;
  return {
    key: `${home}/.ssh/${agent.toLowerCase()}_signing`,
    dir,
    session: `${dir}/session.sh`,
    gh: `${dir}/gh`,
  };
}

/** GitHub's no-reply address for an account: always verified on it. */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/** What an agent session must not inherit from the owner's shell. */
const UNSET = ['GITHUB_TOKEN', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_ASKPASS', 'SSH_ASKPASS'];

/**
 * Git config that keeps GitHub on HTTPS, drops every credential helper
 * configured before it (the keychain's, gh's) and any configured askpass
 * program, so git has no login to give.
 */
const LOCKED_CONFIG: [string, string][] = [
  ['credential.helper', ''],
  // Empty, git asks no program; GIT_TERMINAL_PROMPT=0 then fails the prompt.
  ['core.askpass', ''],
  ['url.https://github.com/.insteadOf', 'git@github.com:'],
  ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
  ['url.https://github.com/.insteadOf', 'ssh://git@github.com:22/'],
  ['url.https://github.com/.insteadOf', 'ssh://git@ssh.github.com:443/'],
];

function configVars(config: [string, string][]): [string, string][] {
  return [
    ['GIT_CONFIG_COUNT', String(config.length)],
    ...config.flatMap(([key, value], i): [string, string][] => [
      [`GIT_CONFIG_KEY_${i}`, key],
      [`GIT_CONFIG_VALUE_${i}`, value],
    ]),
  ];
}

/** The variables an agent session gets, except GH_TOKEN. */
function identityVars(agent: string, id: number, paths: Paths): [string, string][] {
  const email = noreplyEmail(id, agent);
  const helper = `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' ${agent} "$GH_TOKEN"; }; f`;
  const [reset, askpass, ...https] = LOCKED_CONFIG as [[string, string], [string, string], ...[string, string][]];
  return [
    ['PROCESS_RULES_AGENT', agent],
    ['GH_CONFIG_DIR', paths.gh],
    ['GIT_AUTHOR_NAME', agent],
    ['GIT_COMMITTER_NAME', agent],
    ['GIT_AUTHOR_EMAIL', email],
    ['GIT_COMMITTER_EMAIL', email],
    ['GIT_TERMINAL_PROMPT', '0'],
    // Any SSH remote left (a host alias in ~/.ssh/config) fails instead of using the owner's key.
    ['GIT_SSH_COMMAND', NO_SSH],
    ...configVars([
      ['gpg.format', 'ssh'],
      ['user.signingkey', `${paths.key}.pub`],
      ['commit.gpgsign', 'true'],
      ['tag.gpgsign', 'true'],
      // After the reset, the agent's token goes to github.com only.
      reset,
      ['credential.https://github.com.helper', helper],
      askpass,
      ...https,
    ]),
  ];
}

/**
 * The shell lines an agent session sources at start. They hold no secret:
 * the token is read from the keychain each time, and when it is missing
 * GH_TOKEN is a value GitHub refuses, so gh and git fail instead of using
 * the owner's login. GH_CONFIG_DIR is empty for the same reason.
 */
export function sessionScript(agent: string, id: number, paths: Paths): string {
  return [
    `# Written by process-rules machine. Makes this shell act as ${agent} on GitHub.`,
    `export GH_TOKEN="$(${SECURITY} find-generic-password -s ${KEYCHAIN_SERVICE} -a ${agent} -w 2>/dev/null)"`,
    `[ -n "$GH_TOKEN" ] || export GH_TOKEN=${NO_TOKEN}`,
    // Inherited `git -c` and config-file injection could bring back a helper; askpass could prompt.
    `unset ${UNSET.join(' ')}`,
    ...identityVars(agent, id, paths).map(([name, value]) => `export ${name}=${quote(value)}`),
    '',
  ].join('\n');
}

/** The environment `sessionScript` gives a shell, for running git as the agent from here. */
export function sessionEnv(
  base: Readonly<Record<string, string | undefined>>,
  agent: string,
  id: number,
  token: string,
  paths: Paths,
): Record<string, string | undefined> {
  return {
    ...base,
    ...Object.fromEntries(identityVars(agent, id, paths)),
    ...Object.fromEntries(UNSET.map((name) => [name, undefined])),
    GH_TOKEN: token,
  };
}

/**
 * The shell lines that lock GitHub out of a session: a token GitHub refuses,
 * no credential helper, nothing inherited that could bring one back, GitHub
 * remotes on HTTPS and SSH off. gh and git then reach GitHub as nobody.
 */
export function lockScript(home: string): string {
  const vars: [string, string][] = [
    ['GH_CONFIG_DIR', `${home}/.config/process-rules/locked/gh`],
    ['GIT_TERMINAL_PROMPT', '0'],
    ['GIT_SSH_COMMAND', NO_SSH],
    ...configVars(LOCKED_CONFIG),
  ];
  return [
    '# Written by process-rules session-start. GitHub is locked out unless an agent identity below replaces this.',
    `export GH_TOKEN=${NO_TOKEN}`,
    `unset ${UNSET.join(' ')}`,
    ...vars.map(([name, value]) => `export ${name}=${quote(value)}`),
    '',
  ].join('\n');
}

/** The agent and account id a session file names, or undefined when it names none. */
export function sessionNames(script: string): { agent: string; id: number } | undefined {
  const agent = /^export PROCESS_RULES_AGENT='([^']*)'$/m.exec(script)?.[1];
  const id = /^export GIT_AUTHOR_EMAIL='(\d+)\+/m.exec(script)?.[1];
  return agent && id ? { agent, id: Number(id) } : undefined;
}

function quote(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`;
}

/** The agent's token from this machine's keychain, or undefined. */
export function readToken(sys: Sys, agent: string): string | undefined {
  const result = sys.exec(SECURITY, [
    'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', agent, '-w',
  ]);
  const token = result.stdout.trim();
  return result.code === 0 && token ? token : undefined;
}

/** Stores the token without putting it on any command line. */
export function storeToken(sys: Sys, agent: string, token: string): boolean {
  if (!/^[A-Za-z0-9_]+$/.test(token)) return false;
  const result = sys.exec(SECURITY, ['-i'], {
    input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${agent} -w ${token}\n`,
  });
  return result.code === 0 && readToken(sys, agent) === token;
}

/**
 * An account's numeric id and its login as GitHub spells it, from the public
 * API. Logins are case-insensitive; the keychain item, the session file and
 * commits all use GitHub's spelling, whatever case the login was typed in.
 */
export async function account(sys: Sys, login: string): Promise<{ id: number; login: string }> {
  const { status, json } = await sys.http(`${API}/users/${login}`);
  const found = json as { id?: unknown; login?: unknown } | null;
  if (status !== 200 || typeof found?.id !== 'number' || typeof found.login !== 'string') {
    throw new Error(`GitHub has no account "${login}" (HTTP ${status})`);
  }
  return { id: found.id, login: found.login };
}

export interface TokenInfo {
  login: string;
  /** Undefined when GitHub reports none: not a classic token. */
  scopes: readonly string[] | undefined;
  /** Undefined when the token never expires. */
  expires: Date | undefined;
}

/** What GitHub says about a token, or undefined when it refuses it. */
export async function tokenInfo(sys: Sys, token: string): Promise<TokenInfo | undefined> {
  const { status, json, headers = {} } = await sys.http(`${API}/user`, { token });
  const login = (json as { login?: unknown } | null)?.login;
  if (status !== 200 || typeof login !== 'string') return undefined;
  const scopes = headers['x-oauth-scopes'];
  const expiry = headers['github-authentication-token-expiration'];
  const expires = expiry === undefined ? undefined : new Date(expiry);
  return {
    login,
    scopes: scopes === undefined ? undefined : scopes.split(',').map((scope) => scope.trim()).filter(Boolean),
    expires: expires && !Number.isNaN(expires.getTime()) ? expires : undefined,
  };
}

/** Why a token cannot be the agent's, or the whole days it has left when it can. */
export type TokenCheck = { problem: string } | { problem: undefined; days: number };

export function checkToken(token: string, info: TokenInfo | undefined, agent: string, now: Date): TokenCheck {
  if (!info) return { problem: 'GitHub refuses the token (expired or revoked?)' };
  if (!sameLogin(info.login, agent)) return { problem: `the token acts as ${info.login}, not ${agent}` };
  if (!token.startsWith('ghp_') || !info.scopes) {
    return { problem: 'it is not a classic token, which process-rules needs (see its docs/decisions.md)' };
  }
  const { scopes } = info;
  const missing = TOKEN_SCOPES.filter(
    (scope) => !scopes.includes(scope) && !(INCLUDED_BY[scope] ?? []).some((wider) => scopes.includes(wider)),
  );
  if (missing.length > 0) return { problem: `the token lacks the scopes ${missing.join(', ')}` };
  if (!info.expires) return { problem: 'the token never expires; create one with an expiry (90 days recommended)' };
  return { problem: undefined, days: Math.floor((info.expires.getTime() - now.getTime()) / DAY_MS) };
}

/**
 * The signing keys GitHub lists for an account, as "type body". With the
 * account's own token the list is read fresh; GitHub's public list is cached
 * for up to a minute, so a key just added may not show there yet.
 */
export async function signingKeys(sys: Sys, login: string, token?: string): Promise<string[]> {
  const { status, json } = await sys.http(
    token ? `${API}/user/ssh_signing_keys` : `${API}/users/${login}/ssh_signing_keys`,
    token ? { token } : {},
  );
  if (status !== 200 || !Array.isArray(json)) {
    throw new Error(`cannot list ${login}'s signing keys (HTTP ${status})`);
  }
  return json.flatMap((entry: unknown) => {
    const key = (entry as { key?: unknown } | null)?.key;
    return typeof key === 'string' ? [keyBody(key)] : [];
  });
}

/** "type body" of an OpenSSH public key line, without its comment. */
export function keyBody(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(' ');
}

/** What is wrong with the signing key pair at `key`, or undefined when its halves match. */
export function keyPairProblem(sys: Sys, key: string): string | undefined {
  if (!sys.exists(key)) return `${key} is missing`;
  const derived = sys.exec('ssh-keygen', ['-y', '-f', key]);
  if (derived.code !== 0) return `${key} is not a usable private key`;
  if (!sys.exists(`${key}.pub`)) return `${key}.pub is missing`;
  if (keyBody(sys.read(`${key}.pub`)) !== keyBody(derived.stdout)) {
    return `${key}.pub does not match ${key}`;
  }
  return undefined;
}
