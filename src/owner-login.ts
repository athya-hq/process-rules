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

/**
 * Signs the owner in to GitHub for this run alone: one browser approval
 * through `gh auth login --web`, into a fresh temporary gh folder with no
 * token from the environment, and the token read back from that folder.
 * The folder is deleted before this returns, whatever happens, so the
 * owner's own gh config and keychain are never read or written, and
 * nothing is left signed in. Returns why it failed instead of a token.
 */
export async function signInOnce(sys: Sys, scopes: readonly string[]): Promise<OwnerToken | { problem: string }> {
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
    const signed = sys.exec('gh', [...args, ...(scopes.length > 0 ? ['-s', scopes.join(',')] : [])], { env, interactive: true });
    if (signed.code !== 0) return { problem: 'the GitHub sign-in in the browser did not finish' };
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
