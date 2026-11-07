import {
  EXPIRY_WARNING_DAYS,
  account,
  agentFrom,
  anyLogin,
  either,
  loadSettings,
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
import { FROM_SETUP, cloudLogin, repoReleases } from './cloud.ts';
import { type Finding, closing, findingLines, heading, painter, tilde } from './layout.ts';
import { exposure, exposureFindings, movedFindings, readDeclined, setAside } from './lockout.ts';
import { CLOUD_SETUP_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
import { repoRoot } from './session-start.ts';
import { tokenStore, unsupported } from './token-store.ts';
import type { Output, Sys } from './types.ts';
import { packageVersion } from './version.ts';

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
 * reading only: on this Mac the signing key, the session file, the launcher,
 * and the owner's accounts and keys an agent session could reach; on GitHub the
 * classic token and the key registered; in the repository here, hooks that
 * reach GitHub outside `as-agent`. It shows them grouped, one line each, ✓
 * fine, ▲ worth fixing, ✗ broken, each problem with its fix. Exit 1 when
 * any is broken; a token near its end is worth fixing. A Claude cloud session
 * has no keychain, so it gets its own checks; see `cloudDoctor`.
 */
export async function doctor(sys: Sys, io: Output, named?: string): Promise<number> {
  // The same test session-start and as-agent use; on any other machine without a token store, the refusal stands.
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') return cloudDoctor(sys, io, named);
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

  return report(sys, io, agent, [
    ['This Mac', mac],
    [`GitHub — as ${agent}`, github],
    ['This repo', repoFindings(sys)],
  ]);
}

/** Client hooks that reach GitHub outside `as-agent`, on a Mac or in a cloud session alike. */
function repoFindings(sys: Sys): Finding[] {
  return hooksHittingLock(sys).map(
    (hook): Finding => ({
      mark: '▲',
      text: `${hook} reaches GitHub outside as-agent, so gets 401`,
      fix: `run its gh or git via process-rules as-agent --session <session_id> -- (exit ${LOCKED} when not the agent)`,
    }),
  );
}

/** Prints the findings, grouped, and closes; exit 1 when any is broken. */
function report(sys: Sys, io: Output, about: string, groups: [title: string, findings: Finding[]][]): number {
  const paint = painter(sys);
  io.out(heading(paint, 'doctor', about));
  for (const [title, findings] of groups) {
    for (const line of findingLines(paint, title, findings)) io.out(line);
  }
  io.out(paint.dim('│'));
  const all = groups.flatMap(([, findings]) => findings);
  const toFix = all.filter((finding) => finding.mark !== '✓').length;
  io.out(closing(paint, toFix === 0 ? 'All good' : `${toFix} to fix`));
  return all.some((finding) => finding.mark === '✗') ? 1 : 0;
}

const ONBOARD = 'process-rules onboard again';

/**
 * A Claude cloud session's checks, reading only: no keychain, signing key,
 * session file or launcher here, and GitHub reached through the session's
 * proxy as the account connected to claude.ai. In the session: the release
 * the repo's cloud setup file installs against the one its workflow pins,
 * the CLI running against that, and the mark the Setup snippet leaves when
 * it ran the file (as session-start's `cloudDrift` reads them, without
 * installing anything). On GitHub: the account the proxy acts as is one of
 * the repo settings' agents, as session-start checks it, and session-start
 * gave this session that identity. In the repo, hooks as on a Mac.
 */
async function cloudDoctor(sys: Sys, io: Output, named?: string): Promise<number> {
  const session: Finding[] = [];
  const github: Finding[] = [];
  let root: string | undefined;
  try {
    root = repoRoot(sys);
  } catch (error) {
    session.push({ mark: '✗', text: message(error), fix: "process-rules doctor in the repo's clone" });
  }

  if (root !== undefined) {
    const { pinned, scripted } = repoReleases(sys, root);
    if (scripted === undefined) {
      session.push({ mark: '✗', text: `${CLOUD_SETUP_PATH} missing, or not the file onboard writes, so the Setup script installs no process-rules`, fix: ONBOARD });
    } else if (pinned === undefined) {
      session.push({ mark: '▲', text: `${WORKFLOW_PATH} is missing or pins no one version, so ${CLOUD_SETUP_PATH} is not checked against it`, fix: ONBOARD });
    } else if (pinned !== scripted) {
      session.push({ mark: '✗', text: `${CLOUD_SETUP_PATH} installs ${scripted}, but ${WORKFLOW_PATH} pins v${pinned}`, fix: ONBOARD });
    } else {
      session.push({ mark: '✓', text: `${CLOUD_SETUP_PATH} installs ${scripted}, as ${WORKFLOW_PATH} pins` });
    }
    const installed = packageVersion();
    const wanted = scripted ?? pinned;
    if (wanted === installed) {
      session.push({ mark: '✓', text: `process-rules ${installed} runs here` });
    } else if (scripted !== undefined) {
      session.push({ mark: '▲', text: `this session runs process-rules ${installed}, not the ${scripted} ${CLOUD_SETUP_PATH} installs`, fix: `bash ${CLOUD_SETUP_PATH}, or a new session` });
    } else if (pinned !== undefined) {
      session.push({ mark: '▲', text: `this session runs process-rules ${installed}, not the v${pinned} ${WORKFLOW_PATH} pins`, fix: `${ONBOARD}, then a new session` });
    }
  }
  session.push(
    sys.exists(FROM_SETUP)
      ? { mark: '✓', text: `the Setup script runs ${CLOUD_SETUP_PATH}` }
      : {
          mark: '▲',
          text: `${FROM_SETUP} missing, so the cloud environment's Setup script does not run ${CLOUD_SETUP_PATH}`,
          fix: "paste what process-rules cloud-setup prints into the cloud environment's Setup script, once",
        },
  );

  let agents: readonly string[] | undefined = named === undefined ? undefined : [named];
  if (agents === undefined && root !== undefined) {
    try {
      agents = loadSettings(sys, root).agents;
    } catch (error) {
      github.push({ mark: '✗', text: `${message(error)}, so the agents are not known`, fix: ONBOARD });
    }
  }
  const asked = await cloudLogin(sys);
  if ('problem' in asked) {
    github.push({ mark: '✗', text: asked.problem, fix: 'process-rules doctor again' });
  } else if (agents !== undefined) {
    github.push(
      anyLogin(agents, asked.login)
        ? { mark: '✓', text: `the proxy acts as ${asked.login}, an agent the repo's settings name` }
        : { mark: '✗', text: `the proxy acts as ${asked.login}, not ${either(agents)}`, fix: `connect claude.ai's GitHub as ${either(agents)}` },
    );
  }
  // What session-start exported when it lifted the lock; without it, gh and git in this session reach GitHub as nobody.
  const given = sys.env.PROCESS_RULES_AGENT;
  github.push(
    given && (agents === undefined || anyLogin(agents, given))
      ? { mark: '✓', text: `session-start gave this session ${given}'s identity` }
      : {
          mark: '✗',
          text: 'session-start did not give this session the agent identity, so gh and git stay locked out',
          fix: 'a new session; its first process-rules line says why',
        },
  );

  const about = 'login' in asked ? asked.login : agents !== undefined ? either(agents) : 'this cloud session';
  return report(sys, io, about, [
    ['This cloud session', session],
    [`GitHub — as ${about}`, github],
    ['This repo', repoFindings(sys)],
  ]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
