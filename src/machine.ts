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
  sessionScript,
  signingKeys,
  tokenInfo,
} from './agent.ts';
import { type Finding, type Item, closing, findingLines, heading, painter, planLines, runStep, spinning, tilde } from './layout.ts';
import { exposure, keyFindings, recordMove, removeGitPassword, signOut } from './lockout.ts';
import { tokenStore, unsupported } from './token-store.ts';
import type { Output, Sys } from './types.ts';
import { GITHUB_HOST, GITHUB_WEB } from './host.ts';

/** GitHub's classic-token page, with the note and scopes filled in. */
export const TOKEN_PAGE = `${GITHUB_WEB}/settings/tokens/new?description=process-rules%20agent&scopes=${TOKEN_SCOPES.join(',')}`;
const KEY_PAGE = `${GITHUB_WEB}/settings/ssh/new`;

/**
 * What to do on the token page, in short lines: the first heads the step,
 * the rest follow it. The expiry is the one field a link cannot fill.
 */
export function tokenInstructions(agent: string): string[] {
  return [
    `token page opened, for ${agent}`,
    `sign in as ${agent}, in a private window`,
    'note and scopes are filled in; tick nothing else',
    `Expiration: 90 days (doctor warns ${EXPIRY_WARNING_DAYS} days before)`,
    'Generate token, and copy it',
    'SAML org: Configure SSO → Authorize, next to it',
  ];
}

/** machine's arguments: the agent, then `--yes` and `--dry-run`. */
export function machineArgs(args: readonly string[]): { named?: string; yes?: true; dryRun?: true } {
  let named: string | undefined;
  let yes = false;
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--yes') yes = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (named === undefined) named = arg;
    else throw new Error(`unexpected argument "${arg}"`);
  }
  return { ...(named === undefined ? {} : { named }), ...(yes ? { yes: true as const } : {}), ...(dryRun ? { dryRun: true as const } : {}) };
}

/**
 * Sets up this machine for one agent account: its signing key, its classic
 * token in the token store, the key registered on GitHub, the session file
 * agent sessions source, the launcher the hooks run, and the owner's `gh`
 * logins and saved git password locked away. Needs no client repository;
 * whether the agent can push to one is `onboard`'s check.
 *
 * It first works out what it would change, changing nothing, shows that as
 * one plan and asks once (`--yes` skips the question, `--dry-run` stops at
 * the plan); a no changes nothing. With nothing to change it asks nothing.
 * After the yes each step shows as one line; the token's step opens
 * GitHub's page and asks for the paste, hidden.
 */
export async function machine(sys: Sys, io: Output, args: readonly string[] = []): Promise<number> {
  const { named, yes, dryRun } = machineArgs(args);
  const store = tokenStore(sys);
  if (!store) {
    io.err(`machine: ${unsupported(sys)}`);
    return 1;
  }
  if (!sys.tty && !yes && !dryRun) {
    io.err('machine: no terminal to ask in; pass --yes to go ahead without asking, or --dry-run to see the plan');
    return 1;
  }
  const { id, login: agent } = await account(sys, agentFrom(sys, named));
  const paths = pathsFor(sys.home, agent);
  const paint = painter(sys);
  const bar = paint.dim('│');
  const say = (line: string): void => io.out(`${bar}  ${line}`);
  const home = (path: string): string => tilde(sys.home, path);

  // The plan, by group, worked out before anything changes.
  const mac: Item[] = [];
  const github: Item[] = [];
  const warnings: string[] = [];

  // The signing key: made, or its public half written from the private key; a pair that cannot be used is refused.
  const keyMissing = !sys.exists(paths.key);
  let publicHalf: string | undefined;
  if (keyMissing) {
    mac.push({ label: 'signing key', detail: `${home(paths.key)} (new)` });
  } else {
    const derived = sys.exists(`${paths.key}.pub`) ? undefined : sys.exec('ssh-keygen', ['-y', '-f', paths.key]);
    if (derived?.code === 0) {
      publicHalf = `${derived.stdout.trim()} ${agent} signing\n`;
      mac.push({ label: 'signing key', detail: `${home(paths.key)}.pub (from the key)` });
    } else {
      const problem = keyPairProblem(sys, paths.key);
      if (problem) {
        io.err(`machine: ${problem}; move it aside and run machine again to make a new key`);
        return 1;
      }
    }
  }

  // The token: a stored one that works and is not near its end stays.
  let token = store.read(sys, agent);
  if (token) {
    const check = checkToken(token, await tokenInfo(sys, token), agent, sys.now());
    if (check.problem !== undefined) {
      warnings.push(`the stored token cannot stay: ${check.problem}`);
      mac.push({ label: 'token', detail: `classic, in ${store.where.replace(/^this Mac's /, 'the ')} (replaced)` });
      token = undefined;
    } else if (check.days <= EXPIRY_WARNING_DAYS) {
      mac.push({ label: 'token', detail: `ends in ${check.days} days; a new one replaces it` });
      token = undefined;
    }
  } else {
    mac.push({ label: 'token', detail: `classic, in ${store.where.replace(/^this Mac's /, 'the ')} (new)` });
  }

  // The key on GitHub: a new key is registered; an existing one unless GitHub lists it.
  const listedNow = async (): Promise<boolean> => {
    const half = publicHalf ?? (sys.exists(`${paths.key}.pub`) ? sys.read(`${paths.key}.pub`) : undefined);
    if (half === undefined) return false;
    // With no token that stays, the public list; when GitHub cannot say, the step after the yes asks again.
    return (await signingKeys(sys, agent, token).catch(() => [] as string[])).includes(keyBody(half));
  };
  const register = keyMissing || !(await listedNow());
  if (register) github.push({ label: 'signing key', detail: 'register' });

  const script = sessionScript(agent, id, paths, store);
  const session = !sys.exists(paths.session) ? 'new' : sys.read(paths.session) !== script ? 'updated' : undefined;
  if (session) mac.push({ label: 'session file', detail: session });

  const launcher = launcherPath(sys.home);
  const wanted = launcherScript(sys.runtime.node, sys.runtime.cli, cliCommand(sys, launcher));
  const writeLauncher = !sys.exists(launcher) || sys.read(launcher) !== wanted;
  if (writeLauncher) mac.push({ label: 'launcher', detail: home(launcher) });

  // The owner's credentials an agent session could reach: gh's logins and the saved git password go; keys stay the owner's.
  const found = exposure(sys, agent);
  for (const login of found.ghLogins) mac.push({ label: 'gh', detail: `sign out ${login}` });
  if (found.gitPassword) mac.push({ label: 'git password', detail: 'remove from the keychain' });
  const fixes: Finding[] = keyFindings(found, sys.home);

  const end = (): number => {
    for (const line of findingLines(paint, 'Worth fixing', fixes)) io.out(line);
    io.out(bar);
    io.out(closing(paint, `${agent} is ready on this Mac`));
    return 0;
  };
  const head = [heading(paint, 'machine', agent), ...warnings.map((warning) => `${bar}  ! ${warning}`)];
  if (mac.length === 0 && github.length === 0) {
    io.out(head[0] as string);
    io.out(bar);
    io.out(`${paint.done('◇')}  This Mac is set up for ${agent}`);
    return end();
  }
  for (const line of planLines(paint, head, [
    { title: 'This Mac', items: mac },
    { title: `GitHub — as ${agent}`, items: github },
  ])) {
    io.out(line);
  }
  if (dryRun) {
    io.out(closing(paint, 'Dry run: nothing changed.'));
    return 0;
  }
  if (yes) io.out(`${paint.done('◇')}  Go ahead? Yes (--yes)`);
  else if (!(await sys.choose('Go ahead?'))) {
    io.out(closing(paint, 'Nothing changed.'));
    return 1;
  }

  if (keyMissing || publicHalf !== undefined) {
    const made = await runStep(sys, io, paint, 'signing key', async (out) => {
      if (publicHalf !== undefined) {
        sys.write(`${paths.key}.pub`, publicHalf);
        return true;
      }
      sys.mkdir(`${sys.home}/.ssh`);
      const made = sys.exec('ssh-keygen', ['-q', '-t', 'ed25519', '-C', `${agent} signing`, '-N', '', '-f', paths.key]);
      if (made.code !== 0) {
        out.err(`machine: ssh-keygen failed: ${made.stderr.trim()}`);
        return false;
      }
      const problem = keyPairProblem(sys, paths.key);
      if (problem) out.err(`machine: ${problem}; move it aside and run machine again to make a new key`);
      return !problem;
    });
    if (!made.ok) return 1;
  }

  if (!token) {
    const [first, ...rest] = tokenInstructions(agent);
    io.out(`${paint.done('◇')}  ${first}`);
    sys.open(TOKEN_PAGE);
    for (const line of rest) say(line);
    const entered = (await sys.askSecret(`${bar}  paste the token (hidden): `)).trim();
    const stored = await runStep(sys, io, paint, `token in ${store.where.replace(/^this Mac's /, 'the ')}`, async (out) => {
      const { problem } = checkToken(entered, entered ? await tokenInfo(sys, entered) : undefined, agent, sys.now());
      if (problem !== undefined) {
        out.err(`machine: ${problem}`);
        return false;
      }
      if (!store.store(sys, agent, entered)) {
        out.err(`machine: ${store.where} did not take the token`);
        return false;
      }
      return true;
    });
    if (!stored.ok) return 1;
    token = entered;
  }

  if (register) {
    const mine = token;
    const publicKey = sys.read(`${paths.key}.pub`).trim();
    const listed = async (): Promise<boolean> => (await signingKeys(sys, agent, mine)).includes(keyBody(publicKey));
    // True when GitHub already lists it; otherwise the status GitHub's API answered the key with.
    const posted = await spinning(sys, 'signing key registered', async () =>
      (await listed())
        ? true
        : (await sys.http(`${API}/user/ssh_signing_keys`, { method: 'POST', token: mine, body: { title: 'process-rules signing', key: publicKey } })).status,
    );
    if (posted !== true && posted !== 201) {
      io.out(`${paint.done('◇')}  signing key: add it in the browser, as ${agent}`);
      say(`GitHub's API refused (HTTP ${posted}); on the page this opened:`);
      say('New SSH key → Key type: Signing Key, and paste:');
      say(publicKey);
      sys.open(KEY_PAGE);
      await sys.ask(`${bar}  press Enter once it is added `);
    }
    const ok = await runStep(sys, io, paint, 'signing key registered', async (out) => {
      if (posted === true || (await listed())) return true;
      out.err(`machine: GitHub still does not list the key as ${agent}'s signing key`);
      return false;
    });
    if (!ok.ok) return 1;
  }

  if (session) {
    await runStep(sys, io, paint, 'session file', async () => {
      sys.mkdir(paths.gh);
      sys.write(paths.session, script, 0o600);
      return true;
    });
  }
  if (writeLauncher) {
    await runStep(sys, io, paint, 'launcher', async () => {
      sys.mkdir(launcher.slice(0, launcher.lastIndexOf('/')));
      sys.write(launcher, wanted, 0o755);
      return true;
    });
  }

  // Locking the owner away is hardening: what fails is worth fixing, and stops nothing.
  const signedOut: string[] = [];
  for (const login of found.ghLogins) {
    const tried: { problem?: string | undefined } = {};
    await runStep(sys, io, paint, `gh signed out of ${login}`, async () => !(tried.problem = signOut(sys, login)));
    if (tried.problem) fixes.push({ mark: '▲', text: `gh is still signed in as ${login}: ${tried.problem}`, fix: 'process-rules machine' });
    else signedOut.push(login);
  }
  if (found.gitPassword) {
    const { ok } = await runStep(sys, io, paint, 'git password removed', async () => removeGitPassword(sys));
    if (!ok) fixes.push({ mark: '▲', text: `the saved git password for ${GITHUB_HOST} is still in the keychain`, fix: 'process-rules machine' });
  }
  if (found.ghLogins.length > 0 || found.gitPassword) fixes.push(...recordMove(sys, agent, signedOut));
  return end();
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
