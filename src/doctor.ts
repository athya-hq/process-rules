import {
  EXPIRY_WARNING_DAYS,
  SETTINGS_PATH,
  account,
  agentFrom,
  agentIn,
  anyLogin,
  either,
  hasSettings,
  loadSettings,
  repoAt,
  sameLogin,
  checkToken,
  keyBody,
  keyPairProblem,
  launcherPath,
  pathsFor,
  sessionFileIs,
  signingKeys,
  tokenInfo,
} from './agent.ts';
import { LOCKED, hooksHittingLock } from './as-agent.ts';
import { FROM_SETUP, cloudLogin, fileFromSetup, ranFromSetup, repoReleases } from './cloud.ts';
import { featuresIn } from './features.ts';
import { typesDrift } from './issue-types.ts';
import { type Finding, closing, findingLines, heading, painter, tilde } from './layout.ts';
import { exposure, exposureFindings, movedFindings, readDeclined, setAside } from './lockout.ts';
import { CLOUD_SETUP_PATH, HOOKS_PATH } from './onboard-pull.ts';
import { leftoverDir, leftoverToken } from './machine.ts';
import { missingAutoFixRules } from './onboard.ts';
import { isOrganisation } from './owner-login.ts';
import { leftBehind } from './owner-step.ts';
import { repoRoot } from './session-start.ts';
import { type TokenStore, tokenStore, unsupported } from './token-store.ts';
import type { Output, Sys } from './types.ts';
import { installedFindings } from './upgrade.ts';
import { packageVersion } from './version.ts';

const MACHINE = 'niyam machine';

/** Runs a check that reads GitHub; a failed read is that check's ✗, fixed by asking again. */
async function remote(name: string, check: () => Promise<Finding>): Promise<Finding> {
  try {
    return await check();
  } catch (error) {
    return { mark: '✗', text: `${name}: cannot ask GitHub (${error instanceof Error ? error.message : String(error)})`, fix: 'niyam doctor again' };
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
      const is = sessionFileIs(sys.read(paths.session), agent, found.id, paths, store);
      if (!is) return { mark: '✗', text: 'session file out of date', fix: MACHINE };
      return is === 'current'
        ? { mark: '✓', text: 'session file' }
        : { mark: '▲', text: 'session file from an older release; it still works', fix: MACHINE };
    }),
  ];

  mac.push(launcherFinding(sys), ...leftoverFindings(sys, store, agent), ...(await installedFindings(sys)));
  const { left, kept } = setAside(exposure(sys, agent), readDeclined(sys, agent));
  mac.push(...kept.map((text): Finding => ({ mark: '✓', text })), ...exposureFindings(left, sys.home), ...movedFindings(sys, agent), ...leftBehind(sys));

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
    ...(await typesFindings(sys, token)),
  ];

  return report(sys, io, agent, [
    ['This Mac', mac],
    [`GitHub — as ${agent}`, github],
    ['This repo', repoFindings(sys)],
  ]);
}

/** The launcher the hooks run, which `machine` writes: ✓ when it runs. */
function launcherFinding(sys: Sys): Finding {
  const launcher = launcherPath(sys.home);
  if (!sys.exists(launcher)) return { mark: '✗', text: 'launcher missing, so hooks need node on PATH', fix: MACHINE };
  const runs = sys.exec(launcher, ['--version'], { env: { ...sys.env, PATH: '/usr/bin:/bin' } });
  return runs.code === 0
    ? { mark: '✓', text: 'launcher' }
    : { mark: '✗', text: `launcher does not run (${runs.stderr.trim() || `exit ${runs.code}`}); its node removed?`, fix: MACHINE };
}

/**
 * What is left on this Mac from before niyam, which no release reads since
 * P-57: the folder before P-55, and the keychain's entry before niyam. Each
 * is ▲, as `machine` removes it; an entry holding another token than the
 * current one `machine` leaves, so its fix is the delete by hand.
 */
function leftoverFindings(sys: Sys, store: TokenStore, agent: string): Finding[] {
  const dir = leftoverDir(sys);
  const token = leftoverToken(sys, store, agent);
  const item = store.leftoverItem?.(agent) ?? 'the old keychain entry';
  return [
    ...(dir ? [{ mark: '▲' as const, text: `${tilde(sys.home, dir)}, niyam's folder before P-55, is still here; nothing reads it`, fix: MACHINE }] : []),
    ...(token === undefined
      ? []
      : [
          token.same
            ? { mark: '▲' as const, text: `${item}, from before niyam, is still in ${store.where}; nothing reads it`, fix: MACHINE }
            : { mark: '▲' as const, text: `${item}, from before niyam, is still in ${store.where}, and ${token.why}`, fix: `once nothing needs it, ${store.dropLeftoverCommand?.(agent) ?? 'delete it'}` },
        ]),
  ];
}

/**
 * Whether the organisation's enabled issue types are the work model's, no
 * issue here holds another, and every open one here has one but the
 * Approvals issue: checked in a repository whose settings turn the board on,
 * in an organisation, since onboard keeps them so there.
 */
async function typesFindings(sys: Sys, token: string | undefined): Promise<Finding[]> {
  let slug: string;
  let approvals: number | undefined;
  try {
    const found = repoAt(sys);
    const path = `${found.root}/${SETTINGS_PATH}`;
    if (!token || !sys.exists(path)) return [];
    const settings = JSON.parse(sys.read(path)) as unknown;
    if (!featuresIn(settings).includes('board')) return [];
    slug = found.slug;
    const named = (settings as { approvals?: unknown } | null)?.approvals;
    approvals = typeof named === 'number' ? named : undefined;
  } catch {
    // Outside a client's clone, or settings doctor cannot read: onboard says what is wrong with them.
    return [];
  }
  const org = slug.split('/')[0] as string;
  try {
    return (await isOrganisation(sys, org)) ? [await typesDrift(sys, token, org, slug, approvals)] : [];
  } catch (error) {
    return [{ mark: '✗', text: `issue types: cannot ask GitHub (${message(error)})`, fix: 'niyam doctor again' }];
  }
}

/**
 * Client hooks that reach GitHub outside `as-agent` where doctor runs, a Mac
 * or a cloud session, and the Auto-fix rules an onboarded repo's Claude Code
 * settings lack.
 */
function repoFindings(sys: Sys): Finding[] {
  return [
    ...hooksHittingLock(sys).map(
      (hook): Finding => ({
        mark: '▲',
        text: `${hook} reaches GitHub outside as-agent, so gets 401`,
        fix: `run its gh or git via niyam as-agent --session <session_id> -- (exit ${LOCKED} when not the agent)`,
      }),
    ),
    ...autoFixFindings(sys),
  ];
}

/**
 * Which of onboard's Auto-fix rules the repo's `.claude/settings.json`
 * lacks, so the auto-mode classifier refuses an agent session turning
 * Auto-fix on: checked in an onboarded repo whose file doctor can read.
 */
function autoFixFindings(sys: Sys): Finding[] {
  let settings: unknown;
  try {
    // Where session-start looks, so a cloud session's CLI run from outside the clone still finds it.
    const root = repoRoot(sys);
    if (!hasSettings(sys, root) || !sys.exists(`${root}/${HOOKS_PATH}`)) return [];
    settings = JSON.parse(sys.read(`${root}/${HOOKS_PATH}`)) as unknown;
  } catch {
    // Outside a clone, or a file doctor cannot read: onboard says what is wrong with it.
    return [];
  }
  const missing = missingAutoFixRules(settings);
  return missing.length === 0
    ? []
    : [{ mark: '▲', text: `${HOOKS_PATH} does not allow ${missing.join(', ')}, so agent sessions cannot turn Auto-fix on`, fix: ONBOARD }];
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

const ONBOARD = 'niyam onboard again';

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
  // The cloud setup file the repo has: under its old name, until onboard moves it.
  let setupFile = CLOUD_SETUP_PATH;
  try {
    root = repoRoot(sys);
  } catch (error) {
    session.push({ mark: '✗', text: message(error), fix: "niyam doctor in the repo's clone" });
  }

  if (root !== undefined) {
    const { pinned, scripted, workflow, script } = repoReleases(sys, root);
    setupFile = script;
    if (scripted === undefined) {
      session.push({ mark: '✗', text: `${script} missing, or not the file onboard writes, so the Setup script installs no niyam`, fix: ONBOARD });
    } else if (pinned === undefined) {
      session.push({ mark: '▲', text: `${workflow} is missing or pins no one version, so ${script} is not checked against it`, fix: ONBOARD });
    } else if (pinned !== scripted) {
      session.push({ mark: '✗', text: `${script} installs ${scripted}, but ${workflow} pins v${pinned}`, fix: ONBOARD });
    } else {
      session.push({ mark: '✓', text: `${script} installs ${scripted}, as ${workflow} pins` });
    }
    const installed = packageVersion();
    const wanted = scripted ?? pinned;
    if (wanted === installed) {
      session.push({ mark: '✓', text: `niyam ${installed} runs here` });
    } else if (scripted !== undefined) {
      session.push({ mark: '▲', text: `this session runs niyam ${installed}, not the ${scripted} ${script} installs`, fix: `bash ${script}, or a new session` });
    } else if (pinned !== undefined) {
      session.push({ mark: '▲', text: `this session runs niyam ${installed}, not the v${pinned} ${workflow} pins`, fix: `${ONBOARD}, then a new session` });
    }
  }
  session.push(
    ranFromSetup(sys)
      ? { mark: '✓', text: `the Setup script runs ${fileFromSetup(sys) ?? "the repo's cloud setup file"}` }
      : {
          mark: '▲',
          text: `${FROM_SETUP} missing, so the cloud environment's Setup script does not run ${setupFile}`,
          fix: "paste what niyam cloud-setup prints into the cloud environment's Setup script, once",
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
    github.push({ mark: '✗', text: asked.problem, fix: 'niyam doctor again' });
  } else if (agents !== undefined) {
    github.push(
      anyLogin(agents, asked.login)
        ? { mark: '✓', text: `the proxy acts as ${asked.login}, an agent the repo's settings name` }
        : { mark: '✗', text: `the proxy acts as ${asked.login}, not ${either(agents)}`, fix: `connect claude.ai's GitHub as ${either(agents)}` },
    );
  }
  // What session-start exported when it lifted the lock; without it, gh and git in this session reach GitHub as nobody.
  // It must be an agent, and the account the proxy acts as now: another means the connection changed since.
  const given = agentIn(sys.env);
  github.push(
    given && (agents === undefined || anyLogin(agents, given)) && (!('login' in asked) || sameLogin(given, asked.login))
      ? { mark: '✓', text: `session-start gave this session ${given}'s identity` }
      : {
          mark: '✗',
          text: 'session-start did not give this session the agent identity, so gh and git stay locked out',
          fix: 'a new session; its first niyam line says why',
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
