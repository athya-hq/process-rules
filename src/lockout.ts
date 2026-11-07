import { pathsFor, sameLogin } from './agent.ts';
import { type Finding, tilde } from './layout.ts';
import type { Sys } from './types.ts';
import { GITHUB_HOST, GITHUB_HOST_RE, GITHUB_SSH, GITHUB_WEB } from './host.ts';

/**
 * What of the owner's on this Mac an agent session could reach if it ignored
 * session-start's lock: `gh` accounts other than the agent's (active or
 * not), a git password for GitHub saved in the macOS keychain, SSH
 * keys with no passphrase, and the account SSH reaches GitHub as. Only removing them closes that; the lock lives in
 * the session's environment, which a session can change.
 */
export interface Exposure {
  /** The accounts `gh` is signed in to on GitHub, other than the agent. */
  ghLogins: string[];
  gitPassword: boolean;
  /** Private keys in ~/.ssh that open with no passphrase, other than agents' signing keys. */
  openKeys: string[];
  /** The account other than the agent that SSH to GitHub reaches without asking: a key loaded or open. */
  sshLogin: string | undefined;
}

/**
 * The environment of the owner's own shell: without the tokens and the `gh`
 * folder an agent session sets, which would hide the owner's stored logins.
 */
function ownerEnv(sys: Sys): Record<string, string | undefined> {
  return { ...sys.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: undefined };
}

const KEYCHAIN_QUERY = ['find-internet-password', '-s', GITHUB_HOST];
/** How `gh auth status` names each account, whether its token still works or not. */
const GH_ACCOUNT = new RegExp(`(?:Logged in to|log in to) ${GITHUB_HOST_RE} account ([A-Za-z0-9-]+)`, 'g');

export function exposure(sys: Sys, agent: string): Exposure {
  const status = sys.exec('gh', ['auth', 'status', '-h', GITHUB_HOST], { env: ownerEnv(sys) });
  const ghLogins = [...new Set([...`${status.stdout}\n${status.stderr}`.matchAll(GH_ACCOUNT)].map((match) => match[1] as string))].filter(
    (login) => !sameLogin(login, agent),
  );
  const gitPassword = sys.exec('/usr/bin/security', KEYCHAIN_QUERY).code === 0;
  // Every agent machine set up here keeps its signing key, passphrase-free on purpose.
  const agentKeys = new Set([agent, ...sys.list(`${sys.home}/.config/process-rules`)].map((name) => `${name.toLowerCase()}_signing`));
  const ssh = `${sys.home}/.ssh`;
  const openKeys = sys
    .list(ssh)
    .filter((name) => !name.endsWith('.pub') && !agentKeys.has(name))
    .map((name) => `${ssh}/${name}`)
    .filter((key) => sys.exec('ssh-keygen', ['-y', '-P', '', '-f', key]).code === 0);
  return { ghLogins, gitPassword, openKeys, sshLogin: sshLogin(sys, agent) };
}

/**
 * Who GitHub greets over SSH with this Mac's keys, asking for nothing: a key
 * in the SSH agent or the macOS keychain, or one with no passphrase. Undefined
 * when that is nobody, the agent, or GitHub cannot be reached. It writes
 * nothing: StrictHostKeyChecking=yes refuses a host not yet known instead of
 * adding it, even where the owner's SSH config says accept-new or no, and
 * UpdateHostKeys=no stops OpenSSH's default rewrite of ~/.ssh/known_hosts with
 * the host keys GitHub offers after a key signs in, so doctor only reads.
 */
function sshLogin(sys: Sys, agent: string): string | undefined {
  const tried = sys.exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=5', GITHUB_SSH], { env: ownerEnv(sys), timeoutMs: 15_000 });
  const login = /^Hi ([A-Za-z0-9-]+)!/m.exec(`${tried.stdout}\n${tried.stderr}`)?.[1];
  return login && !sameLogin(login, agent) ? login : undefined;
}

/**
 * What `doctor` says of what `exposure` found: each finding ▲ with its fix,
 * and the owner's SSH route ✓, since process-rules leaves it in place on
 * purpose: agent sessions send GitHub over HTTPS and refuse SSH, and the
 * pre-push hook refuses their pushes over SSH (docs/decisions.md).
 */
export function exposureFindings(found: Exposure, home: string): Finding[] {
  return [
    ...found.ghLogins.map((login): Finding => ({ mark: '▲', text: `gh is signed in as ${login}`, fix: 'process-rules machine' })),
    ...(found.gitPassword ? [{ mark: '▲', text: `a saved git password for ${GITHUB_HOST}`, fix: 'process-rules machine' } as const] : []),
    ...keyFindings(found, home),
    ...(found.sshLogin ? [{ mark: '✓', text: `ssh reaches GitHub as ${found.sshLogin}; agent sessions refuse SSH` } as const] : []),
  ];
}

/** Each private key with no passphrase, ▲ with the command that adds one. */
export function keyFindings(found: Exposure, home: string): Finding[] {
  return found.openKeys.map((key) => ({ mark: '▲', text: `${tilde(home, key)} has no passphrase`, fix: `ssh-keygen -p -f ${tilde(home, key)}` }));
}

/**
 * What the owner declined to lock away when `machine` last offered, before
 * it asked once for its whole plan: the `gh` logins it named and the saved
 * git password. `doctor` reports these as chosen instead of warning; an
 * account signed in later is a new finding. `machine` removes the record
 * once it locks them away.
 */
export interface Declined {
  ghLogins: string[];
  gitPassword: boolean;
}

/** Where `machine` keeps what was declined, in the agent's folder beside its session file. */
export function declinedPath(home: string, agent: string): string {
  return `${pathsFor(home, agent).dir}/lockout-declined.json`;
}

/** What was declined on this Mac; nothing when there is no record or it cannot be read. */
export function readDeclined(sys: Sys, agent: string): Declined {
  const path = declinedPath(sys.home, agent);
  const none: Declined = { ghLogins: [], gitPassword: false };
  if (!sys.exists(path)) return none;
  try {
    const record = JSON.parse(sys.read(path)) as Partial<Declined>;
    return {
      ghLogins: Array.isArray(record.ghLogins) ? record.ghLogins.filter((login): login is string => typeof login === 'string') : [],
      gitPassword: record.gitPassword === true,
    };
  } catch {
    return none;
  }
}

/**
 * Splits what `exposure` found into what is left to warn about and one line
 * for each finding the owner declined to lock away.
 */
export function setAside(found: Exposure, declined: Declined): { left: Exposure; kept: string[] } {
  const isDeclined = (login: string) => declined.ghLogins.some((other) => sameLogin(other, login));
  const keptPassword = found.gitPassword && declined.gitPassword;
  return {
    left: { ...found, ghLogins: found.ghLogins.filter((login) => !isDeclined(login)), gitPassword: found.gitPassword && !keptPassword },
    kept: [
      ...found.ghLogins.filter(isDeclined).map((login) => `gh stays signed in as ${login}, as you chose`),
      ...(keptPassword ? [`the saved git password for ${GITHUB_HOST} stays, as you chose`] : []),
    ],
  };
}

/**
 * When `machine` last signed owner accounts out of `gh`, and which: the
 * desktop app started before then still holds a token it read from them.
 */
export interface Moved {
  at: string;
  logins: string[];
}

/** Where `machine` records the move, beside the session file. */
export function movedPath(home: string, agent: string): string {
  return `${pathsFor(home, agent).dir}/gh-moved.json`;
}

/** The last move on this Mac; undefined when there is none or it cannot be read. */
export function readMoved(sys: Sys, agent: string): Moved | undefined {
  const path = movedPath(sys.home, agent);
  if (!sys.exists(path)) return undefined;
  try {
    const record = JSON.parse(sys.read(path)) as Partial<Moved>;
    const logins = Array.isArray(record.logins) ? record.logins.filter((login): login is string => typeof login === 'string') : [];
    return typeof record.at === 'string' && !Number.isNaN(Date.parse(record.at)) && logins.length > 0 ? { at: record.at, logins } : undefined;
  } catch {
    return undefined;
  }
}

const DESKTOP_APP = '/Claude.app/Contents/MacOS/Claude';

/** When the Claude desktop app started; undefined when it is not running or `ps` cannot say. */
export function desktopAppStarted(sys: Sys): Date | undefined {
  const listed = sys.exec('ps', ['-axo', 'lstart=,comm='], { env: { ...sys.env, LC_ALL: 'C' } });
  if (listed.code !== 0) return undefined;
  const starts = listed.stdout
    .split('\n')
    .filter((line) => line.trimEnd().endsWith(DESKTOP_APP))
    .map((line) => new Date(line.trim().slice(0, 24)))
    .filter((date) => !Number.isNaN(date.getTime()));
  return starts.length > 0 ? new Date(Math.min(...starts.map((date) => date.getTime()))) : undefined;
}

/**
 * The two steps only the owner can take once `gh` works as the agent: the
 * desktop app keeps the token it read before until it restarts, and
 * `gh auth logout` deletes the token from this Mac without revoking it.
 */
export function ownerFixes(logins: string[]): Finding[] {
  const as = logins.join(' or ');
  return [
    { mark: '▲', text: `the Claude desktop app still holds ${as}'s gh token`, fix: 'restart the app' },
    { mark: '▲', text: `GitHub still accepts ${as}'s old gh token`, fix: `revoke GitHub CLI at ${GITHUB_WEB}/settings/applications` },
  ];
}

/**
 * `doctor`'s findings for a move the desktop app has not caught up with: the
 * owner's steps while the app runs and started before the move, else none.
 */
export function movedFindings(sys: Sys, agent: string): Finding[] {
  const moved = readMoved(sys, agent);
  const started = moved && desktopAppStarted(sys);
  return moved && started && started.getTime() < Date.parse(moved.at) ? ownerFixes(moved.logins) : [];
}

/** Signs `gh` out of the owner's `login`; what went wrong, or undefined. */
export function signOut(sys: Sys, login: string): string | undefined {
  const out = sys.exec('gh', ['auth', 'logout', '-h', GITHUB_HOST, '-u', login], { env: ownerEnv(sys) });
  return out.code === 0 ? undefined : out.stderr.trim() || `exit ${out.code}`;
}

/** Removes the saved git password for GitHub from the macOS keychain; whether it is gone. */
export function removeGitPassword(sys: Sys): boolean {
  sys.exec('git', ['credential-osxkeychain', 'erase'], { input: `protocol=https\nhost=${GITHUB_HOST}\n\n` });
  return sys.exec('/usr/bin/security', KEYCHAIN_QUERY).code !== 0;
}

/**
 * After `machine` signed `signedOut` out of `gh`: records the move, with the
 * accounts of an earlier one the desktop app has not restarted since, and
 * returns the owner's steps for them all. A record of what was declined
 * before goes, as the owner has now said yes.
 */
export function recordMove(sys: Sys, agent: string, signedOut: string[]): Finding[] {
  if (sys.exists(declinedPath(sys.home, agent))) sys.remove(declinedPath(sys.home, agent));
  if (signedOut.length === 0) return [];
  const pending = movedFindings(sys, agent).length > 0 ? (readMoved(sys, agent)?.logins ?? []) : [];
  const logins = [...pending.filter((login) => !signedOut.some((other) => sameLogin(other, login))), ...signedOut];
  sys.mkdir(pathsFor(sys.home, agent).dir);
  sys.write(movedPath(sys.home, agent), `${JSON.stringify({ at: sys.now().toISOString(), logins }, null, 2)}\n`, 0o600);
  return ownerFixes(logins);
}
