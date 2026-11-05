import {
  EXPIRY_WARNING_DAYS,
  account,
  agentFrom,
  checkToken,
  keyBody,
  keyPairProblem,
  launcherPath,
  pathsFor,
  sessionScript,
  signingKeys,
  tokenInfo,
} from './agent.ts';
import { LOCKED, hooksHittingLock } from './as-agent.ts';
import { type Finding, closing, findingLines, heading, painter, tilde } from './layout.ts';
import { exposure, exposureFindings, movedFindings, readDeclined, setAside } from './lockout.ts';
import { tokenStore, unsupported } from './token-store.ts';
import type { Output, Sys } from './types.ts';

const MACHINE = 'process-rules machine';

/** Runs a check that reads GitHub; a failed read is that check's ✗, fixed by asking again. */
async function remote(name: string, check: () => Promise<Finding>): Promise<Finding> {
  try {
    return await check();
  } catch (error) {
    return { mark: '✗', text: `${name}: cannot ask GitHub (${error instanceof Error ? error.message : String(error)})`, fix: 'process-rules doctor again' };
  }
}

/**
 * Checks that agent sessions on this machine can work as an agent account,
 * reading only: on this Mac the signing key, the session file, the launcher
 * and what of the owner's an agent session could reach; on GitHub the
 * classic token and the key registered; in the repository here, hooks that
 * reach GitHub outside `as-agent`. It shows them grouped, one line each, ✓
 * fine, ▲ worth fixing, ✗ broken, each problem with its fix. Exit 1 when
 * any is broken; a token near its end is worth fixing.
 */
export async function doctor(sys: Sys, io: Output, named?: string): Promise<number> {
  const store = tokenStore(sys);
  if (!store) {
    io.err(`doctor: ${unsupported(sys)}`);
    return 1;
  }
  const typed = agentFrom(sys, named);
  // GitHub's spelling of the login, as machine stored it; when GitHub cannot
  // be asked, the typed one, and the session file check says why.
  const found = await account(sys, typed).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  const agent = found instanceof Error ? typed : found.login;
  const paths = pathsFor(sys.home, agent);
  const home = (path: string): string => tilde(sys.home, path);
  const paint = painter(sys);

  const keyProblem = keyPairProblem(sys, paths.key);
  const mac: Finding[] = [
    keyProblem
      ? { mark: '✗', text: keyProblem.replaceAll(paths.key, home(paths.key)), fix: /missing$/.test(keyProblem) ? MACHINE : `move it aside, then ${MACHINE}` }
      : { mark: '✓', text: `signing key ${home(paths.key)}` },
    await remote('session file', async () => {
      if (!sys.exists(paths.session)) return { mark: '✗', text: 'session file missing', fix: MACHINE };
      if (found instanceof Error) throw found;
      const script = sessionScript(agent, found.id, paths, store);
      return sys.read(paths.session) === script ? { mark: '✓', text: 'session file' } : { mark: '✗', text: 'session file out of date', fix: MACHINE };
    }),
  ];

  const launcher = launcherPath(sys.home);
  const runs = sys.exists(launcher) ? sys.exec(launcher, ['--version'], { env: { ...sys.env, PATH: '/usr/bin:/bin' } }) : undefined;
  mac.push(
    !runs
      ? { mark: '✗', text: 'launcher missing, so hooks need node on PATH', fix: MACHINE }
      : runs.code !== 0
        ? { mark: '✗', text: `launcher does not run (${runs.stderr.trim() || `exit ${runs.code}`}); its node removed?`, fix: MACHINE }
        : { mark: '✓', text: 'launcher' },
  );
  const { left, kept } = setAside(exposure(sys, agent), readDeclined(sys, agent));
  mac.push(...kept.map((text): Finding => ({ mark: '✓', text })), ...exposureFindings(left, sys.home), ...movedFindings(sys, agent));

  const token = store.read(sys, agent);
  const github: Finding[] = [
    await remote('token', async () => {
      if (!token) return { mark: '✗', text: `no token in ${store.where}`, fix: MACHINE };
      const check = checkToken(token, await tokenInfo(sys, token), agent, sys.now());
      if (check.problem !== undefined) return { mark: '✗', text: `token: ${check.problem}`, fix: MACHINE };
      return check.days <= EXPIRY_WARNING_DAYS
        ? { mark: '▲', text: `token ends in ${check.days} days`, fix: MACHINE }
        : { mark: '✓', text: `token, ends in ${check.days} days` };
    }),
    await remote('signing key', async () => {
      const registered = !keyProblem && (await signingKeys(sys, agent)).includes(keyBody(sys.read(`${paths.key}.pub`)));
      return registered ? { mark: '✓', text: 'signing key registered' } : { mark: '✗', text: 'signing key not registered', fix: MACHINE };
    }),
  ];

  const repo = hooksHittingLock(sys).map(
    (hook): Finding => ({
      mark: '▲',
      text: `${hook} reaches GitHub outside as-agent, so gets 401`,
      fix: `run its gh or git via process-rules as-agent --session <session_id> -- (exit ${LOCKED} when not the agent)`,
    }),
  );

  io.out(heading(paint, 'doctor', agent));
  for (const line of [
    ...findingLines(paint, 'This Mac', mac),
    ...findingLines(paint, `GitHub — as ${agent}`, github),
    ...findingLines(paint, 'This repo', repo),
  ]) {
    io.out(line);
  }
  io.out(paint.dim('│'));
  const all = [...mac, ...github, ...repo];
  const toFix = all.filter((finding) => finding.mark !== '✓').length;
  io.out(closing(paint, toFix === 0 ? 'All good' : `${toFix} to fix`));
  return all.some((finding) => finding.mark === '✗') ? 1 : 0;
}
