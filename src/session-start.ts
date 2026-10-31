import {
  BASE_ENV,
  loadSettings,
  lockScript,
  pathsFor,
  readToken,
  sameLogin,
  sessionNames,
  sessionRecord,
  sessionScript,
  type Settings,
} from './agent.ts';
import { cloudLogin, cloudToken } from './cloud.ts';
import { PRE_PUSH_HOOK, prePushHook } from './onboard.ts';
import type { Output, Sys } from './types.ts';

/**
 * Run by the client's SessionStart hook. Appends to CLAUDE_ENV_FILE, which
 * Claude Code sources before each command: first the lock, then, when this
 * Mac has the session file `machine` writes for the agent the repo's
 * settings name, that file's lines, which replace the lock with the agent's
 * identity. The file is copied only when it is exactly what `machine`
 * writes, so nothing else in it can run. Never the owner's login: any other
 * outcome leaves GitHub locked out. Prints one line for the session,
 * records the outcome for the PreToolUse guard, and always exits 0, so a
 * hook failure never stops the session from starting.
 * A Claude cloud session reaches GitHub through its proxy, as the account
 * connected to claude.ai: it works as the agent only when GitHub says that
 * account is the agent; see `cloudStart`.
 */
export async function sessionStart(sys: Sys, io: Output): Promise<number> {
  const record = recordFor(sys);
  const said = sys.env.CLAUDE_CODE_REMOTE === 'true' ? await cloudStart(sys) : start(sys);
  io.out(said.line);
  record(said.agent ? { agent: said.agent } : { problem: said.line });
  return 0;
}

/** What session-start tells the session, and the agent it works as when it does. */
interface Said {
  line: string;
  agent?: string;
}

/**
 * Writes how session-start left this session where the PreToolUse guard
 * reads it, keyed by the session id Claude Code passes on standard input.
 * Without an id, or when the record cannot be written, the guard finds none
 * and refuses GitHub, as for a session whose hook never ran.
 */
function recordFor(sys: Sys): (entry: { agent: string } | { problem: string }) => void {
  let path: string | undefined;
  try {
    const input = JSON.parse(sys.readStdin() || '{}') as { session_id?: unknown };
    path = typeof input.session_id === 'string' ? sessionRecord(sys.home, input.session_id) : undefined;
  } catch {
    path = undefined;
  }
  return (entry) => {
    if (!path) return;
    try {
      sys.mkdir(path.slice(0, path.lastIndexOf('/')));
      sys.write(path, `${JSON.stringify(entry)}\n`, 0o600);
    } catch {
      // The guard finds no record and refuses GitHub, which is the safe side.
    }
  };
}

/**
 * A Claude cloud session: no keychain and no session file, so the agent's
 * identity is the account claude.ai's GitHub connection uses, which GitHub
 * names through the session's proxy. When that is the agent, the lock the
 * settings' `env` gave the session is lifted, so gh and git reach GitHub
 * through the proxy, and the session is marked as the agent's for the guard
 * and the pre-push hook, which it writes, since a cloud clone has none of
 * the owner's. Otherwise GitHub stays locked out and the session is told to
 * stop: it would act as someone else.
 */
async function cloudStart(sys: Sys): Promise<Said> {
  let settings: Settings;
  let root: string;
  try {
    root = repoRoot(sys);
    settings = loadSettings(sys, root);
  } catch (error) {
    return { line: `process-rules: STOP. ${message(error)}, so this cloud session cannot be checked as the agent. Do not push, fetch, or run gh in this session; tell the owner.` };
  }
  const { owner, agent } = settings;
  const stop = `Do not push, fetch, or run gh in this session; tell ${owner}.`;
  const envFile = sys.env.CLAUDE_ENV_FILE;
  if (!envFile) return { line: `process-rules: STOP. CLAUDE_ENV_FILE is unset, so this cloud session cannot be given the agent identity. ${stop}` };
  const asked = await cloudLogin(sys);
  if ('problem' in asked) return { line: `process-rules: STOP. ${asked.problem}, so it cannot be checked as ${agent}. ${stop}` };
  if (!sameLogin(asked.login, agent)) {
    return {
      line: `process-rules: STOP. This cloud session reaches GitHub as ${asked.login}, not ${agent}: claude.ai's GitHub connection must be ${agent} for agent sessions. ${stop}`,
    };
  }
  // A fresh clone has only git's samples: the identity and work rules before a push come from the hook written here,
  // before the lock is lifted.
  let hook: ReturnType<typeof prePushHook>;
  try {
    hook = prePushHook(sys, root);
    if (hook.state === 'missing' || hook.state === 'older') sys.write(hook.file, PRE_PUSH_HOOK, 0o755);
  } catch (error) {
    return { line: `process-rules: STOP. Writing the pre-push git hook failed (${message(error)}), so this cloud session's pushes cannot be checked. ${stop}` };
  }
  try {
    // gh needs a token to run at all: the proxy's placeholder, which it swaps for the connected account's.
    const token = cloudToken(sys);
    sys.append(envFile, `\nunset ${Object.keys(BASE_ENV).join(' ')}\nexport GH_TOKEN=${token} GITHUB_TOKEN=${token} PROCESS_RULES_AGENT=${asked.login}\n`);
  } catch (error) {
    return { line: `process-rules: STOP. Writing to CLAUDE_ENV_FILE failed (${message(error)}), so this cloud session cannot be given the agent identity. ${stop}` };
  }
  const unchecked = hook.state === 'own'
    ? ` Its pre-push hook ${hook.path} does not run process-rules, so only the pull request's checks hold the work rules.`
    : hook.state === 'outside'
      ? ` Its pre-push hook ${hook.path} is outside the repository and was not checked, so only the pull request's checks may hold the work rules.`
      : '';
  return { line: `process-rules: this cloud session works as ${asked.login} on GitHub.${unchecked}`, agent: asked.login };
}

function start(sys: Sys): Said {
  let settings: Settings | undefined;
  let settingsProblem = '';
  try {
    settings = loadSettings(sys, repoRoot(sys));
  } catch (error) {
    settingsProblem = message(error);
  }
  const owner = settings?.owner ?? 'the owner';
  const stop = `Do not push, fetch, or run gh in this session; tell ${owner}.`;

  const envFile = sys.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    return { line: `process-rules: STOP. CLAUDE_ENV_FILE is unset, so this session cannot be given the agent identity and gh and git would act as the owner. ${stop}` };
  }
  try {
    sys.append(envFile, `\n${lockScript(sys.home)}`);
  } catch (error) {
    return { line: `process-rules: STOP. Writing the GitHub lock to CLAUDE_ENV_FILE failed (${message(error)}), so gh and git may act as the owner. ${stop}` };
  }

  const locked = (reason: string, fix: string): Said => ({
    line: `process-rules: GitHub is locked out of this session: ${reason}. Do not work around the lock; ${fix}.`,
  });
  if (!settings) return locked(settingsProblem, `tell ${owner}`);
  const { agent } = settings;
  const paths = pathsFor(sys.home, agent);
  const fix = `ask ${owner} to run process-rules machine ${agent} (process-rules doctor ${agent} names what is missing)`;

  if (!sys.exists(paths.session)) return locked(`${paths.session} is missing`, fix);
  let script: string;
  try {
    script = sys.read(paths.session);
  } catch (error) {
    return locked(`${paths.session} cannot be read (${message(error)})`, fix);
  }
  const names = sessionNames(script);
  if (!names || !sameLogin(names.agent, agent) || script !== sessionScript(names.agent, names.id, paths)) {
    return locked(`${paths.session} is out of date, or not the file process-rules machine writes, for ${agent}`, fix);
  }
  try {
    sys.append(envFile, `\n${script}`);
  } catch (error) {
    return locked(`appending ${paths.session} to CLAUDE_ENV_FILE failed (${message(error)})`, fix);
  }
  if (!readToken(sys, names.agent)) {
    return locked(`this Mac's keychain has no ${names.agent} token, so GitHub refuses gh and git`, fix);
  }
  return { line: `process-rules: this session works as ${names.agent} on GitHub.`, agent: names.agent };
}

/** The top of the git repository the session runs in. */
function repoRoot(sys: Sys): string {
  const dir = sys.env.CLAUDE_PROJECT_DIR ?? sys.cwd;
  const top = sys.exec('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.code !== 0) throw new Error(`${dir} is not inside a git repository`);
  return top.stdout.trim();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
