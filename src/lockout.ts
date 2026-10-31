import { sameLogin } from './agent.ts';
import type { Output, Sys } from './types.ts';

/**
 * What of the owner's on this Mac an agent session could reach if it ignored
 * session-start's lock: `gh` accounts other than the agent's (active or
 * not), a git password for github.com saved in the macOS keychain, SSH
 * keys with no passphrase, and the account SSH reaches GitHub as. Only removing them closes that; the lock lives in
 * the session's environment, which a session can change.
 */
export interface Exposure {
  /** The accounts `gh` is signed in to on github.com, other than the agent. */
  ghLogins: string[];
  gitPassword: boolean;
  /** Private keys in ~/.ssh that open with no passphrase, other than agents' signing keys. */
  openKeys: string[];
  /** The account other than the agent that `ssh git@github.com` reaches without asking: a key loaded or open. */
  sshLogin: string | undefined;
}

/**
 * The environment of the owner's own shell: without the tokens and the `gh`
 * folder an agent session sets, which would hide the owner's stored logins.
 */
function ownerEnv(sys: Sys): Record<string, string | undefined> {
  return { ...sys.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_CONFIG_DIR: undefined };
}

const KEYCHAIN_QUERY = ['find-internet-password', '-s', 'github.com'];
/** How `gh auth status` names each account, whether its token still works or not. */
const GH_ACCOUNT = /(?:Logged in to|log in to) github\.com account ([A-Za-z0-9-]+)/g;

export function exposure(sys: Sys, agent: string): Exposure {
  const status = sys.exec('gh', ['auth', 'status', '-h', 'github.com'], { env: ownerEnv(sys) });
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
 * when that is nobody, the agent, or GitHub cannot be reached.
 */
function sshLogin(sys: Sys, agent: string): string | undefined {
  const tried = sys.exec('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'git@github.com'], { env: ownerEnv(sys), timeoutMs: 15_000 });
  const login = /^Hi ([A-Za-z0-9-]+)!/m.exec(`${tried.stdout}\n${tried.stderr}`)?.[1];
  return login && !sameLogin(login, agent) ? login : undefined;
}

/**
 * Why process-rules leaves the owner's SSH route to GitHub in place, and what
 * covers it in agent sessions (docs/decisions.md).
 */
export function sshLine(login: string): string {
  return (
    `ssh reaches GitHub as ${login} with this Mac's keys; process-rules leaves your SSH access alone. ` +
    'Agent sessions send GitHub over HTTPS and refuse SSH, and the pre-push hook refuses their pushes over SSH'
  );
}

/** One line per exposure, for `doctor` and `machine`. */
export function exposureLines(found: Exposure): string[] {
  return [
    ...found.ghLogins.map((login) => `gh is signed in as ${login}; an agent session that ignores the lock could use it`),
    ...(found.gitPassword ? ["the macOS keychain holds a saved git password for github.com; an agent session could use it"] : []),
    ...found.openKeys.map((key) => `${key} has no passphrase; add one with: ssh-keygen -p -f ${key}`),
    ...(found.sshLogin ? [sshLine(found.sshLogin)] : []),
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
  const found = exposure(sys, agent);
  for (const login of found.ghLogins) {
    if (await confirm(`gh is signed in as ${login}. Sign it out, so agent sessions cannot use it?`)) {
      const out = sys.exec('gh', ['auth', 'logout', '-h', 'github.com', '-u', login], { env: ownerEnv(sys) });
      io.out(out.code === 0 ? `✓ gh signed out of ${login}` : `! gh could not sign out of ${login}: ${out.stderr.trim()}`);
    } else {
      io.out(`! gh stays signed in as ${login}`);
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
  if (found.sshLogin) io.out(`! ${sshLine(found.sshLogin)}`);
  if (found.ghLogins.length === 0 && !found.gitPassword && found.openKeys.length === 0 && !found.sshLogin) {
    io.out('✓ nothing of the owner here for an agent session to reach');
  }
}
