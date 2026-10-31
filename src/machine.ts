import {
  API,
  EXPIRY_WARNING_DAYS,
  TOKEN_SCOPES,
  account,
  agentFrom,
  checkToken,
  keyBody,
  keyPairProblem,
  launcherPath,
  launcherScript,
  pathsFor,
  readToken,
  sessionScript,
  signingKeys,
  storeToken,
  tokenInfo,
} from './agent.ts';
import { lockOwnerAway } from './lockout.ts';
import type { Output, Sys } from './types.ts';

/** GitHub's classic-token page, with the note and scopes filled in. */
export const TOKEN_PAGE = `https://github.com/settings/tokens/new?description=process-rules%20agent&scopes=${TOKEN_SCOPES.join(',')}`;
const KEY_PAGE = 'https://github.com/settings/ssh/new';

/** What to do on the token page; the expiry is the one field a link cannot fill. */
export function tokenInstructions(agent: string): string[] {
  return [
    `Create ${agent}'s classic token. In a private window signed in as ${agent}, on the page this opens:`,
    `  Note and scopes are filled in: ${TOKEN_SCOPES.join(', ')}. Tick nothing else.`,
    `  Expiration: 90 days. doctor warns ${EXPIRY_WARNING_DAYS} days before it ends; run machine again then.`,
    '  Generate token, and copy it.',
    'Where an organisation uses SAML single sign-on, choose Configure SSO → Authorize next to the token for it.',
  ];
}

/**
 * Sets up this machine for one agent account: its signing key, its classic
 * token in the keychain, the key registered on GitHub, and the session file
 * agent sessions source. Needs no client repository; whether the agent can
 * push to one is `onboard`'s check. Every change waits for a yes.
 */
export async function machine(sys: Sys, io: Output, named?: string): Promise<number> {
  const { id, login: agent } = await account(sys, agentFrom(sys, named));
  const paths = pathsFor(sys.home, agent);
  io.out(`Setting up this machine so agent sessions work as ${agent}. Each change asks first.`);

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
    sys.mkdir(`${sys.home}/.ssh`);
    const made = sys.exec('ssh-keygen', ['-q', '-t', 'ed25519', '-C', `${agent} signing`, '-N', '', '-f', paths.key]);
    if (made.code !== 0) {
      io.err(`machine: ssh-keygen failed: ${made.stderr.trim()}`);
      return 1;
    }
  } else if (!sys.exists(`${paths.key}.pub`)) {
    const derived = sys.exec('ssh-keygen', ['-y', '-f', paths.key]);
    if (derived.code === 0) {
      if (!(await confirm(`Write ${paths.key}.pub from the private key?`))) return stop('signing key');
      sys.write(`${paths.key}.pub`, `${derived.stdout.trim()} ${agent} signing\n`);
    }
  }
  const keyProblem = keyPairProblem(sys, paths.key);
  if (keyProblem) {
    io.err(`machine: ${keyProblem}; move it aside and run machine again to make a new key`);
    return 1;
  }
  io.out(`✓ signing key ${paths.key}`);

  let token = readToken(sys, agent);
  if (token) {
    const check = checkToken(token, await tokenInfo(sys, token), agent, sys.now());
    if (check.problem !== undefined) {
      io.out(`The stored token cannot stay: ${check.problem}. Replacing it.`);
      token = undefined;
    } else if (check.days <= EXPIRY_WARNING_DAYS) {
      if (await confirm(`The stored token ends in ${check.days} days. Replace it with a new one?`)) token = undefined;
    }
  }
  if (!token) {
    for (const line of tokenInstructions(agent)) io.out(line);
    sys.open(TOKEN_PAGE);
    const entered = (await sys.askSecret(`Paste ${agent}'s new token (hidden): `)).trim();
    const info = entered ? await tokenInfo(sys, entered) : undefined;
    const { problem } = checkToken(entered, info, agent, sys.now());
    if (problem !== undefined) {
      io.err(`machine: ${problem}`);
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
  io.out(`✓ classic token for ${agent} in the keychain`);

  const publicKey = sys.read(`${paths.key}.pub`).trim();
  if (!(await signingKeys(sys, agent, token)).includes(keyBody(publicKey))) {
    if (!(await confirm(`Register ${paths.key}.pub as a signing key on ${agent}?`))) {
      return stop('register key');
    }
    const posted = await sys.http(`${API}/user/ssh_signing_keys`, {
      method: 'POST',
      token,
      body: { title: 'process-rules signing', key: publicKey },
    });
    if (posted.status !== 201) {
      io.out(`GitHub's API refused (HTTP ${posted.status}). Add it in the browser, signed in as ${agent}:`);
      io.out('  New SSH key → Key type: Signing Key, and paste:');
      io.out(`  ${publicKey}`);
      sys.open(KEY_PAGE);
      await sys.ask('Press Enter once it is added. ');
    }
    if (!(await signingKeys(sys, agent, token)).includes(keyBody(publicKey))) {
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

  const launcher = launcherPath(sys.home);
  const wanted = launcherScript(sys.runtime.node, sys.runtime.cli, cliCommand(sys, launcher));
  if (!sys.exists(launcher) || sys.read(launcher) !== wanted) {
    if (!(await confirm(`Write ${launcher}, which the hooks run with this node (${sys.runtime.node}), so they need no node on PATH?`))) {
      return stop('launcher');
    }
    sys.mkdir(launcher.slice(0, launcher.lastIndexOf('/')));
    sys.write(launcher, wanted, 0o755);
  }
  io.out(`✓ launcher ${launcher}`);

  await lockOwnerAway(sys, io, confirm, agent);
  io.out(`machine: done. Agent sessions act as ${agent} once they source ${paths.session}.`);
  return 0;
}

/**
 * The package manager's command for the CLI on this shell's PATH, which
 * stays put when the CLI is upgraded; undefined when there is none, or when
 * this CLI runs from a checkout, whatever an installed one on PATH is.
 */
function cliCommand(sys: Sys, launcher: string): string | undefined {
  if (!sys.runtime.cli.includes('/node_modules/')) return undefined;
  const found = sys.exec('/bin/sh', ['-c', 'command -v process-rules']);
  const command = found.stdout.trim();
  return found.code === 0 && command.startsWith('/') && command !== launcher ? command : undefined;
}
