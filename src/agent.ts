import { KEYCHAIN, type TokenStore, tokenStore } from './token-store.ts';
import type { Sys } from './types.ts';
import { GITHUB_API, GITHUB_HOST_RE, GITHUB_NOREPLY, GITHUB_SSH, GITHUB_SSH_443, GITHUB_WEB } from './host.ts';
import { AGENT_VAR, CLI, CONFIG_DIR } from './names.ts';

/** The adopting repo's settings file, written by `onboard`. */
export const SETTINGS_PATH = '.github/niyam.json';

/** Whether a repo at `root` has a settings file. */
export function hasSettings(sys: Sys, root: string): boolean {
  return sys.exists(`${root}/${SETTINGS_PATH}`);
}
/** What GH_TOKEN holds when the token store has none, so nothing falls back to the owner. */
export const NO_TOKEN = 'niyam-no-agent-token';

/** Whether `token` is a lock's placeholder: no token at all. */
export function isNoToken(token: string | undefined): boolean {
  return token === NO_TOKEN;
}

/** The agent an agent session's environment names, or undefined in anyone else's shell. */
export function agentIn(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return env[AGENT_VAR] || undefined;
}
export const API = GITHUB_API;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** The GitHub remotes `repoAt` accepts: HTTPS, scp-like SSH, or SSH URLs, on GitHub's host only. */
const GITHUB_REMOTE = new RegExp(
  `^(?:https://(?:[^@/\\s]+@)?${GITHUB_HOST_RE}/|git@${GITHUB_HOST_RE}:|ssh://git@(?:ssh\\.)?${GITHUB_HOST_RE}(?::\\d+)?/)([^/\\s]+/[^/\\s]+?)(?:\\.git)?/?$`,
);
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
export const NO_SSH = `echo '${CLI}: SSH is off in agent sessions; GitHub goes over HTTPS' >&2; false`;

/** GitHub logins are case-insensitive. */
export function sameLogin(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Whether `login` is one of `logins`. */
export function anyLogin(logins: readonly string[], login: string | undefined): boolean {
  return logins.some((one) => sameLogin(login, one));
}

/** Logins for a message: "A", "A or B", "A, B or C". */
export function either(logins: readonly string[]): string {
  return logins.length < 2 ? (logins[0] ?? '') : `${logins.slice(0, -1).join(', ')} or ${logins.at(-1) as string}`;
}

/** The settings' accounts: each a login or a list of them in the file, always a list here. */
export interface Settings {
  owners: string[];
  agents: string[];
  /** The repository's standing Approvals issue, where one owner comment answers a batch; none when the settings name none. */
  approvals?: number;
}

/** Reads and checks the settings file at `root`; throws with the reason. */
export function loadSettings(sys: Sys, root: string): Settings {
  const name = SETTINGS_PATH;
  const path = `${root}/${name}`;
  if (!sys.exists(path)) {
    throw new Error(`${SETTINGS_PATH} not found in ${root}`);
  }
  const raw: unknown = JSON.parse(sys.read(path));
  const owners = logins(raw, 'owner', name);
  const agents = logins(raw, 'agent', name);
  const both = owners.find((owner) => anyLogin(agents, owner));
  if (both) {
    throw new Error(`${name}: ${both} is named as both owner and agent; they must be different accounts`);
  }
  const approvals = approvalsIn(raw, name);
  return { owners, agents, ...(approvals === undefined ? {} : { approvals }) };
}

/** The Approvals issue the settings name as `"approvals": N`, or undefined when they name none; anything but an issue number is refused. */
function approvalsIn(raw: unknown, file: string): number | undefined {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).approvals : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${file}: "approvals" must be the number of the repository's Approvals issue, such as 42`);
  }
  return value;
}

function logins(raw: unknown, name: string, file: string): string[] {
  const value =
    typeof raw === 'object' && raw !== null && name in raw
      ? (raw as Record<string, unknown>)[name]
      : undefined;
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  if (list.length === 0 || !list.every((login) => typeof login === 'string' && LOGIN.test(login))) {
    throw new Error(`${file}: "${name}" must be a GitHub login or a non-empty list of them`);
  }
  // A login listed twice, in any case, is one account.
  return (list as string[]).filter((login, i) => list.findIndex((other) => sameLogin(login, other as string)) === i);
}

/** The agent accounts `machine` has set up on this machine, as their session files spell them, once each. */
export function agentsSetUp(sys: Sys): string[] {
  const dir = configDir(sys.home);
  const found = sys.list(dir).flatMap((name) => {
    const session = `${dir}/${name}/session.sh`;
    const agent = sys.exists(session) ? sessionNames(sys.read(session))?.agent : undefined;
    return agent ? [agent] : [];
  });
  return found.filter((agent, i) => found.findIndex((other) => sameLogin(agent, other)) === i);
}

/** What the config folder holds beside the agents' folders: the launcher's, the session records' and the locked gh folder's. */
export const NOT_AGENTS: readonly string[] = ['bin', 'sessions', 'locked'];

/** The folder this Mac's files are in. */
export function configDir(home: string): string {
  return `${home}/${CONFIG_DIR}`;
}

/**
 * The one agent of `agents` sessions on this machine work as: with one in
 * the list, that one; with more, the one `machine` set up here. None set up,
 * or more than one, is a problem: never a guess.
 */
export function agentHere(sys: Sys, agents: readonly string[]): { agent: string } | { problem: string } {
  if (agents.length === 1) return { agent: agents[0] as string };
  const here = agents.filter((agent) => anyLogin(agentsSetUp(sys), agent));
  if (here.length === 1) return { agent: here[0] as string };
  return {
    problem: here.length === 0
      ? `${SETTINGS_PATH} names the agents ${either(agents)}, and niyam machine has set up none of them on this machine`
      : `${SETTINGS_PATH} names the agents ${either(agents)}, and niyam machine has set up ${here.join(' and ')} on this machine, so which one this session works as cannot be told; remove the others' folders under ~/${CONFIG_DIR}`,
  };
}

/**
 * The agent account a command acts for: the login named after it, else the
 * one of the agents the settings file of the repo around the working
 * directory names that sessions here work as (`agentHere`).
 */
export function agentFrom(sys: Sys, named: string | undefined): string {
  if (named !== undefined) {
    if (!LOGIN.test(named)) throw new Error(`"${named}" is not a GitHub login`);
    return named;
  }
  const top = sys.exec('git', ['rev-parse', '--show-toplevel'], { cwd: sys.cwd });
  const root = top.stdout.trim();
  if (top.code !== 0 || !hasSettings(sys, root)) {
    throw new Error(`name the agent account after the command, or run it in a repo whose ${SETTINGS_PATH} names one`);
  }
  const here = agentHere(sys, loadSettings(sys, root).agents);
  if ('problem' in here) throw new Error(`${here.problem}; name the agent account after the command`);
  return here.agent;
}

/** Whether `value` can be a GitHub login. */
export function isLogin(value: string): boolean {
  return LOGIN.test(value);
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

/** Where `machine` keeps an agent account's files on this machine: one folder per account, in the config folder. */
export function pathsFor(home: string, agent: string): Paths {
  const dir = `${configDir(home)}/${agent.toLowerCase()}`;
  return {
    key: `${home}/.ssh/${agent.toLowerCase()}_signing`,
    dir,
    session: `${dir}/session.sh`,
    gh: `${dir}/gh`,
  };
}

/** GitHub's no-reply address for an account: always verified on it. */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@${GITHUB_NOREPLY}`;
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
  [`url.${GITHUB_WEB}/.insteadOf`, `${GITHUB_SSH}:`],
  [`url.${GITHUB_WEB}/.insteadOf`, `ssh://${GITHUB_SSH}/`],
  [`url.${GITHUB_WEB}/.insteadOf`, `ssh://${GITHUB_SSH}:22/`],
  [`url.${GITHUB_WEB}/.insteadOf`, `ssh://${GITHUB_SSH_443}:443/`],
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

/**
 * The variables naming the agent in the session file machine 0.6.10 wrote:
 * NIYAM_AGENT, and beside it the name before P-55 for older readers. Data a
 * session file is compared against, as onboard's OLDER_ hook texts are; no
 * release since sets or reads that name (P-57).
 */
const AGENT_VARS_0610 = [AGENT_VAR, 'PROCESS_RULES_AGENT'];

/** The variables an agent session gets, except GH_TOKEN. */
function identityVars(agent: string, id: number, paths: Paths, agentVars: readonly string[] = [AGENT_VAR]): [string, string][] {
  const email = noreplyEmail(id, agent);
  const helper = `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' ${agent} "$GH_TOKEN"; }; f`;
  const [reset, askpass, ...https] = LOCKED_CONFIG as [[string, string], [string, string], ...[string, string][]];
  return [
    ...agentVars.map((name): [string, string] => [name, agent]),
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
      // After the reset, the agent's token goes to GitHub's host only.
      reset,
      [`credential.${GITHUB_WEB}.helper`, helper],
      askpass,
      ...https,
    ]),
  ];
}

/**
 * The lock as plain values, for the `env` of a client's Claude Code
 * settings: every session there starts locked out of GitHub before any hook
 * runs, so a session whose hook never ran or failed reaches GitHub as nobody.
 * The settings file is shared by every machine, so nothing in it names a
 * home folder; GH_TOKEN alone keeps gh off its stored logins. Cloud sessions
 * get it too, and their SessionStart hook unsets it (`onboard`'s HOOK_COMMAND).
 */
export const BASE_ENV: Record<string, string> = Object.fromEntries([
  ['GH_TOKEN', NO_TOKEN],
  ['GITHUB_TOKEN', NO_TOKEN],
  // Settings cannot unset a variable; empty, these bring back no helper and ask no program.
  ['GIT_CONFIG_PARAMETERS', ''],
  ['GIT_ASKPASS', ''],
  ['SSH_ASKPASS', ''],
  ['GIT_TERMINAL_PROMPT', '0'],
  ['GIT_SSH_COMMAND', NO_SSH],
  ...configVars(LOCKED_CONFIG),
]);

/** Where session-start records how it left one Claude Code session, for the guard to read; undefined for an id that is not one. */
export function sessionRecord(home: string, sessionId: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? `${configDir(home)}/sessions/${sessionId}.json` : undefined;
}

/** The launcher `machine` writes, which hooks run, so they need no node on PATH. */
export function launcherPath(home: string): string {
  return `${configDir(home)}/bin/${CLI}`;
}

/**
 * The launcher's lines: the CLI run with the node that ran `machine`, found
 * by its real path, not a per-shell one such as a version manager's. With the
 * package manager's command for the CLI it runs that, which stays put across
 * upgrades, with that node first on PATH; else the CLI's own script.
 */
export function launcherScript(node: string, cli: string, command?: string): string {
  const dir = node.slice(0, node.lastIndexOf('/'));
  return [
    '#!/bin/sh',
    `# Written by ${CLI} machine: the CLI for hooks, with the node that ran machine, so they need no node on PATH.`,
    `PATH=${quote(dir)}:"$PATH"`,
    'export PATH',
    command ? `exec ${quote(command)} "$@"` : `exec ${quote(node)} ${quote(cli)} "$@"`,
    '',
  ].join('\n');
}

/**
 * The shell lines an agent session sources at start. They hold no secret:
 * the token is read from the token store (the macOS keychain unless named)
 * each time, and when it is missing GH_TOKEN is a value GitHub refuses, so
 * gh and git fail instead of using the owner's login. GH_CONFIG_DIR is empty
 * for the same reason.
 */
export function sessionScript(agent: string, id: number, paths: Paths, store: TokenStore = KEYCHAIN, read: string = store.readCommand(agent)): string {
  return sessionText(agent, id, paths, read);
}

function sessionText(agent: string, id: number, paths: Paths, read: string, agentVars: readonly string[] = [AGENT_VAR]): string {
  return [
    `# Written by ${CLI} machine. Makes this shell act as ${agent} on GitHub.`,
    `export GH_TOKEN="$(${read})"`,
    `[ -n "$GH_TOKEN" ] || export GH_TOKEN=${NO_TOKEN}`,
    // Inherited `git -c` and config-file injection could bring back a helper; askpass could prompt.
    `unset ${UNSET.join(' ')}`,
    ...identityVars(agent, id, paths, agentVars).map(([name, value]) => `export ${name}=${quote(value)}`),
    '',
  ].join('\n');
}

/**
 * Whether `script`, in the agent's folder `paths`, is a session file
 * `machine` writes for the agent: this release's, or the one 0.6.10 wrote
 * there, which also set the agent's variable under its name before P-55
 * and read the token from the keychain's entry before niyam where the
 * `niyam` one is missing (`olderReadCommands`). That one still works, so a
 * session started between the upgrade and `machine` is not locked out;
 * `doctor` says so, and `machine` writes this release's.
 */
export function sessionFileIs(script: string, agent: string, id: number, paths: Paths, store: TokenStore = KEYCHAIN): 'current' | 'older' | undefined {
  if (script === sessionScript(agent, id, paths, store)) return 'current';
  const older = (store.olderReadCommands?.(agent) ?? []).some((read) => script === sessionText(agent, id, paths, read, AGENT_VARS_0610));
  return older ? 'older' : undefined;
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
    ['GH_CONFIG_DIR', `${configDir(home)}/locked/gh`],
    ['GIT_TERMINAL_PROMPT', '0'],
    ['GIT_SSH_COMMAND', NO_SSH],
    ...configVars(LOCKED_CONFIG),
  ];
  return [
    `# Written by ${CLI} session-start. GitHub is locked out unless an agent identity below replaces this.`,
    `export GH_TOKEN=${NO_TOKEN}`,
    `unset ${UNSET.join(' ')}`,
    ...vars.map(([name, value]) => `export ${name}=${quote(value)}`),
    '',
  ].join('\n');
}

/** The agent and account id a session file names, or undefined when it names none. */
export function sessionNames(script: string): { agent: string; id: number } | undefined {
  const agent = new RegExp(`^export ${AGENT_VAR}='([^']*)'$`, 'm').exec(script)?.[1];
  const id = /^export GIT_AUTHOR_EMAIL='(\d+)\+/m.exec(script)?.[1];
  return agent && id ? { agent, id: Number(id) } : undefined;
}

function quote(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`;
}

/** The agent's token from this machine's token store, or undefined, as on a platform with none. */
export function readToken(sys: Sys, agent: string): string | undefined {
  return tokenStore(sys)?.read(sys, agent);
}

/**
 * An account's numeric id and its login as GitHub spells it, from the public
 * API. Logins are case-insensitive; the stored token's item, the session file and
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
    return { problem: 'it is not a classic token, which niyam needs (see its docs/decisions.md)' };
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
