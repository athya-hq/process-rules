import {
  BASE_ENV,
  anyLogin,
  either,
  loadSettings,
  pathsFor,
  sameLogin,
  sessionEnv,
  sessionNames,
  sessionRecord,
  sessionScript,
} from './agent.ts';
import { cloudToken } from './cloud.ts';
import { recordedAgent, reachesGitHub, refusal } from './guard.ts';
import { GUARD_COMMAND, HOOK_COMMAND, OLDER_GUARD_COMMANDS, OLDER_HOOK_COMMANDS } from './onboard.ts';
import { tokenStore, unsupported } from './token-store.ts';
import type { Output, Sys } from './types.ts';

/**
 * What `as-agent` exits with when it runs nothing because the session does
 * not work as the agent: 77, sysexits' EX_NOPERM. Not 0, 1 or 2, which mean
 * done, failed and bad usage here and blocking to Claude Code's hooks; not a
 * code gh (1, 2, 4, 8) or git (1, 128, 129) exits with, nor the shell's 126,
 * 127 or 128 plus a signal (docs/decisions.md, P-43).
 */
export const LOCKED = 77;

/** The arguments of `as-agent`: `--session <id> -- <command> [args...]`. */
export function asAgentArgs(args: readonly string[]): { sessionId: string; command: string; args: string[] } {
  const [flag, sessionId, dashes, command, ...rest] = args;
  if (flag !== '--session' || sessionId === undefined) throw new Error('as-agent needs --session <session_id> first');
  if (dashes !== '--') throw new Error('as-agent needs -- between the session id and the command');
  if (!command) throw new Error('as-agent needs a command after --');
  return { sessionId, command, args: rest };
}

/**
 * Run by a client's hook to run one command as the session's agent. Hooks
 * other than SessionStart, Setup, CwdChanged and FileChanged get no
 * CLAUDE_ENV_FILE, so they keep the lock the settings' `env` gives every
 * session, and their gh reaches GitHub as nobody. This runs the command, its
 * standard input, output and error and exit code passed straight through,
 * with the environment session-start gave the session's shells, but only
 * when session-start recorded that this session works as one of the repo
 * settings' agents. Otherwise it runs nothing, says why on standard error in
 * the guard's words, and exits LOCKED. The token goes only into the child's
 * environment, read from the token store now, and the owner's login is never
 * a fallback.
 */
export function asAgent(sys: Sys, io: Output, parsed: ReturnType<typeof asAgentArgs>): number {
  const locked = (reason: string): number => {
    io.err(refusal(reason));
    return LOCKED;
  };
  if (!sessionRecord(sys.home, parsed.sessionId)) return locked(`"${parsed.sessionId}" is not a Claude Code session id`);
  const recorded = recordedAgent(sys, parsed.sessionId);
  if ('problem' in recorded) return locked(recorded.problem);
  let agents: readonly string[];
  try {
    agents = loadSettings(sys, repoRoot(sys)).agents;
  } catch (error) {
    return locked(message(error));
  }
  if (!anyLogin(agents, recorded.agent)) return locked(`session-start recorded ${recorded.agent}, and the repo's settings name the agents ${either(agents)}`);

  const env = sys.env.CLAUDE_CODE_REMOTE === 'true' ? cloudEnv(sys, recorded.agent) : macEnv(sys, recorded.agent);
  if ('problem' in env) return locked(env.problem);
  const result = sys.exec(parsed.command, parsed.args, { env: env.env, interactive: true });
  // With standard error passed through, what is left is why the command could not start.
  if (result.stderr) io.err(`process-rules as-agent: ${parsed.command}: ${result.stderr.trim()}`);
  return result.code;
}

type Env = { env: Record<string, string> } | { problem: string };

/** The hook's environment without the lock the settings' `env` gave it. */
function unlocked(sys: Sys): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(sys.env).filter(([name]) => !Object.hasOwn(BASE_ENV, name)));
}

function defined(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * On a Mac: what the agent's session file gives a shell, checked as
 * session-start checks it, with the token read from the store now.
 */
function macEnv(sys: Sys, agent: string): Env {
  const store = tokenStore(sys);
  if (!store) return { problem: unsupported(sys) };
  const paths = pathsFor(sys.home, agent);
  let script: string;
  try {
    script = sys.read(paths.session);
  } catch {
    return { problem: `${paths.session} is missing or cannot be read` };
  }
  const names = sessionNames(script);
  if (!names || !sameLogin(names.agent, agent) || script !== sessionScript(names.agent, names.id, paths, store)) {
    return { problem: `${paths.session} is out of date, or not the file process-rules machine writes, for ${agent}` };
  }
  const token = store.read(sys, names.agent);
  if (!token) return { problem: `${store.where} has no ${names.agent} token` };
  return { env: defined(sessionEnv(unlocked(sys), names.agent, names.id, token, paths)) };
}

/**
 * In a Claude cloud session: what session-start's lines give a shell there,
 * the proxy's placeholder token, which it swaps for the connected account's,
 * and the agent session-start checked that account is.
 */
function cloudEnv(sys: Sys, agent: string): Env {
  const token = cloudToken(sys);
  return { env: defined({ ...unlocked(sys), GH_TOKEN: token, GITHUB_TOKEN: token, PROCESS_RULES_AGENT: agent }) };
}

/** The settings files a client's hooks live in. */
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const OWN_COMMANDS = new Set([HOOK_COMMAND, GUARD_COMMAND, ...OLDER_HOOK_COMMANDS, ...OLDER_GUARD_COMMANDS]);

/**
 * The client's hooks, in the repo around the working directory, that reach
 * GitHub outside `as-agent`, so get the lock's placeholder token: by the
 * hook's command, or by a script in the repo it names. Like the guard, it
 * reads text, so a script that runs another script is missed.
 */
export function hooksHittingLock(sys: Sys): string[] {
  const top = sys.exec('git', ['rev-parse', '--show-toplevel'], { cwd: sys.cwd });
  if (top.code !== 0) return [];
  const root = top.stdout.trim();
  const found: string[] = [];
  for (const file of SETTINGS_FILES) {
    let settings: { hooks?: Record<string, unknown> };
    try {
      settings = JSON.parse(sys.read(`${root}/${file}`)) as typeof settings;
    } catch {
      continue;
    }
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        const hooks = (group as { hooks?: unknown } | null)?.hooks;
        for (const hook of Array.isArray(hooks) ? hooks : []) {
          const command = (hook as { command?: unknown } | null)?.command;
          if (typeof command !== 'string' || OWN_COMMANDS.has(command)) continue;
          const script = scriptOf(sys, root, command);
          const text = script ? `${command}\n${script.text}` : command;
          if (reachesGitHub(withoutAsAgent(text))) found.push(`${file} ${event} hook ${script ? script.path : JSON.stringify(command)}`);
        }
      }
    }
  }
  return found;
}

/** The text with each line that runs `as-agent` taken out. */
function withoutAsAgent(text: string): string {
  return text.split('\n').filter((line) => !/\bas-agent\b/.test(line)).join('\n');
}

/** The script in the repo a hook command runs, by its first word. */
function scriptOf(sys: Sys, root: string, command: string): { path: string; text: string } | undefined {
  const first = /^\s*(?:(?:ba|z)?sh\s+|node\s+|python3?\s+)?(\S+)/.exec(command)?.[1];
  if (!first) return undefined;
  const path = first.replaceAll(/["']/g, '').replace(/^\$\{?CLAUDE_PROJECT_DIR\}?\//, '').replace(/^\.\//, '');
  if (path.startsWith('/') || path.startsWith('$') || path.startsWith('~')) return undefined;
  try {
    return { path, text: sys.read(`${root}/${path}`) };
  } catch {
    return undefined;
  }
}

/** The top of the git repository the hook runs in. */
function repoRoot(sys: Sys): string {
  const dir = sys.env.CLAUDE_PROJECT_DIR ?? sys.cwd;
  const top = sys.exec('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.code !== 0) throw new Error(`${dir} is not inside a git repository`);
  return top.stdout.trim();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
