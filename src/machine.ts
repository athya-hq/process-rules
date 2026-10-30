import {
  API,
  accountId,
  keyBody,
  loadSettings,
  pathsFor,
  readToken,
  repoAt,
  sessionEnv,
  sessionScript,
  signingKeys,
  storeToken,
  tokenLogin,
  type Paths,
} from './agent.ts';
import type { Output, Sys } from './types.ts';

const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new';
const KEY_PAGE = 'https://github.com/settings/ssh/new';

/** The token settings to tick: GitHub's token page cannot be filled from a link. */
export function tokenInstructions(agent: string, slug: string): string[] {
  const [org, repo] = slug.split('/');
  return [
    `Create ${agent}'s token. In a private window signed in as ${agent}, on the page this opens:`,
    `  Name: ${repo} agent · Resource owner: ${org} · Expiration: up to a year`,
    `  Repository access: Only select repositories → ${slug}`,
    '  Repository permissions: Contents, Issues, Pull requests, Workflows, Actions: Read and write;',
    '    Checks, Commit statuses, Metadata: Read',
    '  Organization permissions: Projects: Read and write',
    `If GitHub says it needs approval, approve it as an ${org} owner (${org} → Settings → Personal access tokens → Pending requests).`,
  ];
}

/**
 * Sets up this machine so agent sessions work as the agent account: its
 * signing key, its token in the keychain, the key registered on GitHub, the
 * session file, and one signed test commit GitHub must show as Verified.
 * Every change waits for a yes.
 */
export async function machine(sys: Sys, io: Output): Promise<number> {
  const { root, slug } = repoAt(sys);
  const { agent } = loadSettings(sys, root);
  const paths = pathsFor(sys.home, agent);
  const id = await accountId(sys, agent);
  io.out(`Setting up this machine so agent sessions in ${slug} work as ${agent}. Each change asks first.`);

  const confirm = async (question: string): Promise<boolean> =>
    /^y(es)?$/i.test((await sys.ask(`${question} [y/N] `)).trim());
  const stop = (step: string): number => {
    io.err(`machine: stopped at "${step}"; nothing after it was changed`);
    return 1;
  };

  if (!sys.exists(paths.key)) {
    if (!(await confirm(`Create ${agent}'s signing key at ${paths.key}, with no passphrase so sessions can sign?`))) {
      return stop('signing key');
    }
    const made = sys.exec('ssh-keygen', ['-q', '-t', 'ed25519', '-C', `${agent} signing`, '-N', '', '-f', paths.key]);
    if (made.code !== 0) {
      io.err(`machine: ssh-keygen failed: ${made.stderr.trim()}`);
      return 1;
    }
  }
  io.out(`✓ signing key ${paths.key}`);

  let token = readToken(sys, agent);
  if (token && (await tokenLogin(sys, token)) !== agent) {
    io.out(`The stored token is refused or is not ${agent}'s; replacing it.`);
    token = undefined;
  }
  if (!token) {
    for (const line of tokenInstructions(agent, slug)) io.out(line);
    sys.open(TOKEN_PAGE);
    const entered = (await sys.askSecret(`Paste ${agent}'s new token (hidden): `)).trim();
    const login = entered ? await tokenLogin(sys, entered) : undefined;
    if (login !== agent) {
      io.err(
        login === undefined
          ? 'machine: GitHub refuses that token'
          : `machine: that token acts as ${login}; create it signed in as ${agent}`,
      );
      return 1;
    }
    if (!(await confirm(`Store it in this machine's keychain (service process-rules, account ${agent})?`))) {
      return stop('token');
    }
    if (!storeToken(sys, agent, entered)) {
      io.err('machine: the keychain did not take the token');
      return 1;
    }
    token = entered;
  }
  io.out(`✓ token for ${agent} in the keychain`);

  const publicKey = sys.read(`${paths.key}.pub`).trim();
  if (!(await signingKeys(sys, agent)).includes(keyBody(publicKey))) {
    if (!(await confirm(`Register ${paths.key}.pub as a signing key on ${agent}?`))) {
      return stop('register key');
    }
    const posted = await sys.http(`${API}/user/ssh_signing_keys`, {
      method: 'POST',
      token,
      body: { title: `process-rules ${slug}`, key: publicKey },
    });
    if (posted.status !== 201) {
      // A token whose resource owner is an organization cannot touch the account's keys.
      io.out(`GitHub's API refused (HTTP ${posted.status}). Add it in the browser, signed in as ${agent}:`);
      io.out('  New SSH key → Key type: Signing Key, and paste:');
      io.out(`  ${publicKey}`);
      sys.open(KEY_PAGE);
      await sys.ask('Press Enter once it is added. ');
    }
    if (!(await signingKeys(sys, agent)).includes(keyBody(publicKey))) {
      io.err(`machine: GitHub still does not list the key as ${agent}'s signing key`);
      return 1;
    }
  }
  io.out(`✓ key registered as ${agent}'s signing key`);

  const script = sessionScript(agent, id, paths);
  if (!sys.exists(paths.session) || sys.read(paths.session) !== script) {
    if (!(await confirm(`Write ${paths.session}, which agent sessions source to act as ${agent}?`))) {
      return stop('session file');
    }
    sys.mkdir(paths.gh);
    sys.write(paths.session, script, 0o600);
  }
  io.out(`✓ session file ${paths.session}`);

  if (!(await confirm(`Push one signed test commit to a throwaway branch of ${slug}, check it is Verified, then delete the branch?`))) {
    return stop('test commit');
  }
  return testCommit(sys, io, { agent, id, token, paths, slug });
}

interface Target {
  agent: string;
  id: number;
  token: string;
  paths: Paths;
  slug: string;
}

/** Signs an empty commit on the repo's tip as the agent, pushes it, and asks GitHub whether it is Verified. */
async function testCommit(sys: Sys, io: Output, target: Target): Promise<number> {
  const { agent, id, token, paths, slug } = target;
  const dir = sys.exec('mktemp', ['-d']).stdout.trim();
  const env = sessionEnv(sys.env, agent, id, token, paths);
  const git = (...args: string[]) => sys.exec('git', args, { cwd: dir, env });
  const url = `https://github.com/${slug}.git`;
  const branch = `process-rules/verify-${agent.toLowerCase()}-${sys.now().getTime()}`;
  try {
    for (const args of [
      ['init', '-q'],
      ['fetch', '-q', '--depth=1', '--filter=blob:none', url, 'HEAD'],
    ]) {
      const step = git(...args);
      if (step.code !== 0) {
        io.err(`machine: git ${args[0]} failed: ${step.stderr.trim()}`);
        return 1;
      }
    }
    const made = git('commit-tree', '-S', 'FETCH_HEAD^{tree}', '-p', 'FETCH_HEAD', '-m', `process-rules: signing check for ${agent}`);
    const sha = made.stdout.trim();
    if (made.code !== 0 || !sha) {
      io.err(`machine: signing the test commit failed: ${made.stderr.trim()}`);
      return 1;
    }
    const pushed = git('push', '-q', url, `${sha}:refs/heads/${branch}`);
    if (pushed.code !== 0) {
      io.err(`machine: pushing as ${agent} failed: ${pushed.stderr.trim()}`);
      return 1;
    }
    const { json } = await sys.http(`${API}/repos/${slug}/commits/${sha}`, { token });
    git('push', '-q', url, `:refs/heads/${branch}`);
    const commit = json as {
      committer?: { login?: string } | null;
      commit?: { verification?: { verified?: boolean; reason?: string } };
    } | null;
    const verification = commit?.commit?.verification;
    const committer = commit?.committer?.login;
    io.out(`Test commit https://github.com/${slug}/commit/${sha}`);
    io.out(`  committer: ${committer ?? 'none'}; verified: ${String(verification?.verified)} (${verification?.reason ?? 'no reason'})`);
    if (verification?.verified !== true || committer !== agent) {
      io.err(`machine: GitHub does not show the commit Verified by ${agent}`);
      return 1;
    }
    io.out(`✓ GitHub shows the test commit Verified by ${agent}; branch ${branch} deleted`);
    io.out(`machine: done. Agent sessions act as ${agent} once they source ${paths.session}.`);
    return 0;
  } finally {
    sys.exec('rm', ['-rf', dir]);
  }
}
