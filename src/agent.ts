import type { Sys } from './types.ts';

/** The adopting repo's settings file, written by `setup`. */
export const SETTINGS_PATH = '.github/process-rules.json';
/** The keychain item holding the agent account's token: service, account = login. */
export const KEYCHAIN_SERVICE = 'process-rules';
/** What GH_TOKEN holds when the keychain has no token, so nothing falls back to the owner. */
export const NO_TOKEN = 'process-rules-no-agent-token';
const SECURITY = '/usr/bin/security';
export const API = 'https://api.github.com';
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** The GitHub remotes `repoAt` accepts: HTTPS, scp-like SSH, or SSH URLs, on github.com only. */
const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@(?:ssh\.)?github\.com(?::\d+)?\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/;
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
    throw new Error(`${SETTINGS_PATH} not found in ${root}; run process-rules setup`);
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

/** The git repository containing the working directory, and its GitHub slug. */
export function repoAt(sys: Sys): { root: string; slug: string } {
  const top = sys.exec('git', ['rev-parse', '--show-toplevel'], { cwd: sys.cwd });
  if (top.code !== 0) throw new Error('not inside a git repository');
  const root = top.stdout.trim();
  const url = sys.exec('git', ['remote', 'get-url', 'origin'], { cwd: root }).stdout.trim();
  const match = GITHUB_REMOTE.exec(url);
  if (!match?.[1]) throw new Error(`origin is not a GitHub repository: "${url}"`);
  return { root, slug: match[1] };
}

export interface Paths {
  key: string;
  dir: string;
  session: string;
  gh: string;
}

/** Where `machine` keeps the agent's files on this machine. */
export function pathsFor(home: string, agent: string): Paths {
  const dir = `${home}/.config/process-rules`;
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

/** The variables an agent session gets, except GH_TOKEN. */
function identityVars(agent: string, id: number, paths: Paths): [string, string][] {
  const email = noreplyEmail(id, agent);
  const helper = `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' ${agent} "$GH_TOKEN"; }; f`;
  const config: [string, string][] = [
    ['gpg.format', 'ssh'],
    ['user.signingkey', `${paths.key}.pub`],
    ['commit.gpgsign', 'true'],
    ['tag.gpgsign', 'true'],
    // An empty helper drops every helper configured before it (the keychain's,
    // gh's); the agent's token then goes to github.com only.
    ['credential.helper', ''],
    ['credential.https://github.com.helper', helper],
    ['url.https://github.com/.insteadOf', 'git@github.com:'],
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com:22/'],
    ['url.https://github.com/.insteadOf', 'ssh://git@ssh.github.com:443/'],
  ];
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
    ['GIT_CONFIG_COUNT', String(config.length)],
    ...config.flatMap(([key, value], i): [string, string][] => [
      [`GIT_CONFIG_KEY_${i}`, key],
      [`GIT_CONFIG_VALUE_${i}`, value],
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
    'unset GITHUB_TOKEN',
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
    GH_TOKEN: token,
    GITHUB_TOKEN: undefined,
  };
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

/** An account's numeric id, from GitHub's public API. */
export async function accountId(sys: Sys, login: string): Promise<number> {
  const { status, json } = await sys.http(`${API}/users/${login}`);
  const id = (json as { id?: unknown } | null)?.id;
  if (status !== 200 || typeof id !== 'number') {
    throw new Error(`GitHub has no account "${login}" (HTTP ${status})`);
  }
  return id;
}

/** The login a token acts as, or undefined when GitHub refuses it. */
export async function tokenLogin(sys: Sys, token: string): Promise<string | undefined> {
  const { status, json } = await sys.http(`${API}/user`, { token });
  const login = (json as { login?: unknown } | null)?.login;
  return status === 200 && typeof login === 'string' ? login : undefined;
}

/** The signing keys GitHub lists publicly for an account, as "type body". */
export async function signingKeys(sys: Sys, login: string): Promise<string[]> {
  const { status, json } = await sys.http(`${API}/users/${login}/ssh_signing_keys`);
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
