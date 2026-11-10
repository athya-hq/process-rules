import { API, sameLogin } from './agent.ts';
import type { Feature } from './features.ts';
import type { Sys } from './types.ts';
import { GITHUB_HOST } from './host.ts';

/** The owner's GitHub token for one run, held in memory only. */
export interface OwnerToken {
  login: string;
  token: string;
  /** The scopes GitHub reports the token has. */
  scopes: string[];
}

/**
 * The scopes beyond gh's own (repo, read:org, gist) that a run turning
 * `features` on needs from the owner: projects for the board, and issue
 * types, an organisation setting, when the repository is an organisation's.
 */
export function ownerScopes(features: readonly Feature[], organisation: boolean): string[] {
  if (!features.includes('board')) return [];
  return organisation ? ['project', 'admin:org'] : ['project'];
}

/** Whether GitHub names the account an organisation; throws when GitHub will not say. */
export async function isOrganisation(sys: Sys, login: string): Promise<boolean> {
  const { status, json } = await sys.http(`${API}/users/${login}`);
  const type = (json as { type?: unknown } | null)?.type;
  if (status !== 200 || typeof type !== 'string') throw new Error(`cannot tell whether ${login} is an organisation (HTTP ${status})`);
  return type === 'Organization';
}

/** gh's lines from a sign-in that tell the owner nothing they need: its sign-in tips and the setup it did in the temporary folder. */
const GH_CHATTER = [/Authentication complete/i, /git_protocol/, /Configured git protocol/i, /plain text/i, /Logged in as/i, /^Did you know/i, /^Tip\b/i];
/** A device flow's one-time code, as gh prints it: "XXXX-XXXX". */
const ONE_TIME_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;

/**
 * What to do with each line gh prints during a browser sign-in, its output
 * not a terminal: the one-time code and the link go to `show`, the link also
 * opens in the browser, gh's tips and notes on its own setup are dropped, and
 * any other line, its errors included, is shown as gh wrote it.
 */
export function signInLines(sys: Sys, show: (line: string) => void): (raw: string) => void {
  return (raw) => {
    const line = raw.trim();
    const oneTime = ONE_TIME_CODE.exec(line)?.[0];
    const url = /https:\/\/\S+/.exec(line)?.[0];
    if (oneTime) show(`one-time code ${oneTime}${/clipboard/i.test(line) ? ' (copied)' : ''}`);
    else if (url && /browser/i.test(line)) {
      show(`approve it at ${url}`);
      sys.open(url);
    } else if (line && !GH_CHATTER.some((chatter) => chatter.test(line))) show(line);
  };
}

/**
 * Signs the owner in to GitHub for this run alone: one browser approval
 * through `gh auth login --web`, into a fresh temporary gh folder with no
 * token from the environment, and the token read back from that folder.
 * The folder is deleted before this returns, whatever happens, so the
 * owner's own gh config and keychain are never read or written, and
 * nothing is left signed in. Returns why it failed instead of a token.
 *
 * gh's output is read rather than shown: with it not a terminal, gh prints
 * the one-time code and the link instead of asking for Enter, so `show` gets
 * the code, and the link, which this opens in the browser; gh's tips and
 * notes about its own setup are dropped, and any other line, its errors
 * included, is shown as gh wrote it.
 */
export async function signInOnce(sys: Sys, scopes: readonly string[], show: (line: string) => void = () => {}): Promise<OwnerToken | { problem: string }> {
  const dir = sys.tempDir();
  try {
    const env = {
      ...sys.env,
      GH_CONFIG_DIR: dir,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_ENTERPRISE_TOKEN: undefined,
      GITHUB_ENTERPRISE_TOKEN: undefined,
      GH_HOST: undefined,
      // Should gh offer to set up git, it would change this file, not the owner's.
      GIT_CONFIG_GLOBAL: `${dir}/gitconfig`,
    };
    // SSH as the protocol, with no key, keeps gh from asking to set up git's credentials.
    const args = ['auth', 'login', '--web', '-h', GITHUB_HOST, '-p', 'ssh', '--skip-ssh-key', '--insecure-storage'];
    const code = await sys.converse('gh', [...args, ...(scopes.length > 0 ? ['-s', scopes.join(',')] : [])], { env }, signInLines(sys, show));
    if (code !== 0) return { problem: 'the GitHub sign-in in the browser did not finish' };
    const read = sys.exec('gh', ['auth', 'token', '-h', GITHUB_HOST], { env });
    const token = read.stdout.trim();
    if (read.code !== 0 || !token) return { problem: 'gh did not hand over the token from the sign-in' };
    const me = await sys.http(`${API}/user`, { token });
    const login = (me.json as { login?: unknown } | null)?.login;
    if (me.status !== 200 || typeof login !== 'string') return { problem: `GitHub did not accept the token from the sign-in (HTTP ${me.status})` };
    const granted = (me.headers?.['x-oauth-scopes'] ?? '').split(',').map((scope) => scope.trim()).filter(Boolean);
    return { login, token, scopes: granted };
  } finally {
    sys.remove(dir);
  }
}

/** The token when the sign-in was the owner's and has every scope, else why not. */
export function asOwner(signed: OwnerToken | { problem: string }, owner: string, scopes: readonly string[]): string | { problem: string } {
  if ('problem' in signed) return signed;
  if (!sameLogin(signed.login, owner)) {
    return { problem: `the browser signed in to GitHub as ${signed.login}, not the owner ${owner}; sign in to ${GITHUB_HOST} there as ${owner} and run it again` };
  }
  const missing = scopes.filter((scope) => !signed.scopes.includes(scope));
  if (missing.length > 0) return { problem: `the GitHub sign-in did not grant ${missing.join(', ')}` };
  return signed.token;
}
