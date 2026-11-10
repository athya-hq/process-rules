import { sessionRecord } from './agent.ts';
import { askRefusal, commentProblem } from './asks.ts';
import type { Output, Sys } from './types.ts';

/** Where a command word starts, and an optional folder before it, as in /usr/bin/gh. */
const WORD = String.raw`(?:^|[\s;&|()\`'"$])(?:[\w.~-]*/)*`;
/** git's options before its subcommand: -C and -c take a value. */
const GIT_OPTIONS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-\w))*`;
/** `git remote`, with `-v` or not, before its subcommand. */
const GIT_REMOTE = String.raw`${WORD}git${GIT_OPTIONS}\s+remote(?:\s+(?:-v|--verbose))?\s+`;
/** `gh` as a command, and the git commands that always reach a remote. */
const GH = new RegExp(`${WORD}gh(?:\\s|$)`);
const GIT_NETWORK = new RegExp(`${WORD}git${GIT_OPTIONS}\\s+(?:push|fetch|pull|clone|ls-remote|submodule)(?:\\s|$)|${GIT_REMOTE}(?:update|prune)(?:\\s|$)`);
/** `git remote add`, `set-head` or `show`, and its words up to the next `;`, `&`, `|` or line end. */
const GIT_REMOTE_MAYBE = new RegExp(`${GIT_REMOTE}(add|set-head|show)((?:[ \\t]+[^;&|\\s]+)*)`, 'g');

/**
 * Whether a `git remote add` fetches (its last of `-f`, `--fetch` and
 * `--no-fetch` is one of the first two), a `set-head` asks the remote
 * (`-a`, `--auto`), or a `show` does (no `-n`). `update` and `prune` are in
 * GIT_NETWORK; the rest (`get-url`, `set-url`, `rename`, `remove`, `-v`, …)
 * only read or write `.git/config` (#219).
 */
function remoteContacted(command: string): boolean {
  return [...command.matchAll(GIT_REMOTE_MAYBE)].some(([, subcommand, rest = '']) => {
    const words = rest.trim().split(/\s+/);
    if (subcommand === 'show') return !words.includes('-n');
    if (subcommand === 'set-head') return words.some((word) => word === '-a' || word === '--auto');
    const last = words.filter((word) => ['-f', '--fetch', '--no-fetch'].includes(word)).at(-1);
    return last === '-f' || last === '--fetch';
  });
}

/** Whether a shell command runs gh or a git command that reaches a remote. */
export function reachesGitHub(command: string): boolean {
  return GH.test(command) || GIT_NETWORK.test(command) || remoteContacted(command);
}

/**
 * Run by the client's PreToolUse hook before each Bash command. A command
 * that runs gh or reaches a remote with git goes ahead only in a session
 * session-start gave the agent identity; anywhere else it is refused (exit 2,
 * the reason on standard error, which Claude Code shows the session). The
 * hook cannot see the variables session-start gives the session's shells, so
 * it reads what session-start recorded for this session id: a session whose
 * hook never ran, failed, or locked GitHub out has no record saying it works
 * as the agent, a Claude cloud session's included.
 *
 * In an agent session, a comment the command posts through gh (`gh issue
 * comment`, `gh pr comment`, or `gh api` on a comments endpoint) that asks
 * the owner, opening with `Needs you:` or `Proposal:` or naming the owner,
 * must link a published page and fit 500 characters; otherwise it is refused
 * with the rule and the fix. `propose` posts through the API, not gh, so
 * this check does not see it; it holds its own comments to the same rule
 * (`askProblem`) before posting them.
 */
export function guard(sys: Sys, io: Output, stdin: string): number {
  let input: { session_id?: unknown; cwd?: unknown; tool_input?: { command?: unknown } };
  try {
    input = JSON.parse(stdin) as typeof input;
  } catch {
    return refuse(io, 'the hook was given no command to check');
  }
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return 0;
  if (!reachesGitHub(command)) return 0;

  const recorded = recordedAgent(sys, input.session_id);
  if (!('agent' in recorded)) return refuse(io, recorded.problem);
  // A comment that asks the owner links a published page and stays short; the command runs where the hook says.
  const problem = commentProblem(sys, command, typeof input.cwd === 'string' && input.cwd.startsWith('/') ? input.cwd : sys.cwd);
  if (!problem) return 0;
  io.err(askRefusal(problem));
  return 2;
}

/**
 * The agent session-start recorded this session as working as, or why it
 * names none: no record for the id, one it did not write, or the problem it
 * recorded instead. `as-agent` reads the same record.
 */
export function recordedAgent(sys: Sys, sessionId: unknown): { agent: string } | { problem: string } {
  const path = typeof sessionId === 'string' ? sessionRecord(sys.home, sessionId) : undefined;
  if (!path || !sys.exists(path)) {
    return { problem: 'session-start did not run for this session, so it was not given the agent identity' };
  }
  let entry: { agent?: unknown; problem?: unknown } | null;
  try {
    entry = JSON.parse(sys.read(path)) as typeof entry;
  } catch {
    entry = null;
  }
  if (typeof entry !== 'object' || entry === null) return { problem: `${path} is not what session-start writes` };
  if (typeof entry.agent === 'string') return { agent: entry.agent };
  return { problem: typeof entry.problem === 'string' ? `session-start said: ${entry.problem}` : `${path} names no agent` };
}

/** The line a refusal prints, for the guard and `as-agent` alike. */
export function refusal(reason: string): string {
  return `niyam: refused, because this session does not work as the agent on GitHub: ${reason.replace(/\.$/, '')}. Do not work around it; tell the owner.`;
}

function refuse(io: Output, reason: string): number {
  io.err(refusal(reason));
  return 2;
}
