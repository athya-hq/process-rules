import { API, sameLogin } from './agent.ts';
import type { Output, Sys } from './types.ts';

/**
 * What of the owner's on this Mac an agent session could reach if it ignored
 * session-start's lock: a `gh` login that is not the agent's, a git password
 * for github.com saved in the macOS keychain, and SSH keys with no
 * passphrase. Only removing them closes that; the lock lives in the
 * session's environment, which a session can change.
 */
export interface Exposure {
  /** The account `gh` is signed in as, when it is not the agent. */
  ghLogin: string | undefined;
  gitPassword: boolean;
  /** Private keys in ~/.ssh that open with no passphrase, other than agents' signing keys. */
  openKeys: string[];
}

/** The environment of the owner's own shell, without tokens that would hide the stored `gh` login. */
function ownerEnv(sys: Sys): Record<string, string | undefined> {
  return { ...sys.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined };
}

const KEYCHAIN_QUERY = ['find-internet-password', '-s', 'github.com'];

export async function exposure(sys: Sys, agent: string): Promise<Exposure> {
  let ghLogin: string | undefined;
  const token = sys.exec('gh', ['auth', 'token', '-h', 'github.com'], { env: ownerEnv(sys) });
  if (token.code === 0 && token.stdout.trim()) {
    const reply = await sys.http(`${API}/user`, { token: token.stdout.trim() }).catch(() => undefined);
    const login = (reply?.json as { login?: unknown } | null | undefined)?.login;
    ghLogin = reply?.status === 200 && typeof login === 'string' ? login : 'an account GitHub could not name';
    if (sameLogin(ghLogin, agent)) ghLogin = undefined;
  }
  const gitPassword = sys.exec('/usr/bin/security', KEYCHAIN_QUERY).code === 0;
  const ssh = `${sys.home}/.ssh`;
  const openKeys = sys
    .list(ssh)
    .filter((name) => !name.endsWith('_signing') && sys.list(ssh).includes(`${name}.pub`))
    .map((name) => `${ssh}/${name}`)
    .filter((key) => sys.exec('ssh-keygen', ['-y', '-P', '', '-f', key]).code === 0);
  return { ghLogin, gitPassword, openKeys };
}

/** One line per exposure, for `doctor` and `machine`. */
export function exposureLines(found: Exposure): string[] {
  return [
    ...(found.ghLogin ? [`gh is signed in as ${found.ghLogin}; an agent session that ignores the lock could use it`] : []),
    ...(found.gitPassword ? ["the macOS keychain holds a saved git password for github.com; an agent session could use it"] : []),
    ...found.openKeys.map((key) => `${key} has no passphrase; add one with: ssh-keygen -p -f ${key}`),
  ];
}

/**
 * `machine`'s last step: offers to sign `gh` out and to remove the saved git
 * password, and warns about keys with no passphrase. Declining leaves them
 * in place, and `doctor` keeps naming them.
 */
export async function lockOwnerAway(
  sys: Sys,
  io: Output,
  confirm: (question: string) => Promise<boolean>,
  agent: string,
): Promise<void> {
  const found = await exposure(sys, agent);
  if (found.ghLogin) {
    if (await confirm(`gh is signed in as ${found.ghLogin}. Sign it out, so agent sessions cannot use it? (gh auth login brings it back)`)) {
      const out = sys.exec('gh', ['auth', 'logout', '-h', 'github.com', '-u', found.ghLogin], { env: ownerEnv(sys) });
      io.out(out.code === 0 ? `✓ gh signed out of ${found.ghLogin}` : `! gh could not sign out: ${out.stderr.trim()}`);
    } else {
      io.out(`! gh stays signed in as ${found.ghLogin}`);
    }
  }
  if (found.gitPassword) {
    if (await confirm('The macOS keychain holds a saved git password for github.com. Remove it?')) {
      sys.exec('git', ['credential-osxkeychain', 'erase'], { input: 'protocol=https\nhost=github.com\n\n' });
      const left = sys.exec('/usr/bin/security', KEYCHAIN_QUERY).code === 0;
      io.out(left ? '! the saved git password for github.com is still in the keychain' : '✓ removed the saved git password for github.com');
    } else {
      io.out('! the saved git password for github.com stays in the keychain');
    }
  }
  for (const key of found.openKeys) io.out(`! ${key} has no passphrase; add one with: ssh-keygen -p -f ${key}`);
  if (!found.ghLogin && !found.gitPassword && found.openKeys.length === 0) {
    io.out('✓ nothing of the owner here for an agent session to reach');
  }
}
