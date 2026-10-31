import { sessionRecord } from './agent.ts';
import type { Output, Sys } from './types.ts';

/** Where a command word starts, and an optional folder before it, as in /usr/bin/gh. */
const WORD = String.raw`(?:^|[\s;&|()\`'"$])(?:[\w.~-]*/)*`;
/** git's options before its subcommand: -C and -c take a value. */
const GIT_OPTIONS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-\w))*`;
/** `gh` as a command, and the git commands that reach a remote. */
const GH = new RegExp(`${WORD}gh(?:\\s|$)`);
const GIT_NETWORK = new RegExp(`${WORD}git${GIT_OPTIONS}\\s+(?:push|fetch|pull|clone|ls-remote|remote|submodule)(?:\\s|$)`);

/** Whether a shell command runs gh or a git command that reaches a remote. */
export function reachesGitHub(command: string): boolean {
  return GH.test(command) || GIT_NETWORK.test(command);
}

/**
 * Run by the client's PreToolUse hook before each Bash command. A command
 * that runs gh or reaches a remote with git goes ahead only in a session
 * session-start gave the agent identity; anywhere else it is refused (exit 2,
 * the reason on standard error, which Claude Code shows the session). The
 * hook cannot see the variables session-start gives the session's shells, so
 * it reads what session-start recorded for this session id: a session whose
 * hook never ran, failed, or locked GitHub out has no record saying it works
 * as the agent. Cloud sessions are left alone.
 */
export function guard(sys: Sys, io: Output, stdin: string): number {
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') return 0;
  let input: { session_id?: unknown; tool_input?: { command?: unknown } };
  try {
    input = JSON.parse(stdin) as typeof input;
  } catch {
    return refuse(io, 'the hook was given no command to check');
  }
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return 0;
  if (!reachesGitHub(command)) return 0;

  const path = typeof input.session_id === 'string' ? sessionRecord(sys.home, input.session_id) : undefined;
  if (!path || !sys.exists(path)) {
    return refuse(io, 'session-start did not run for this session, so it was not given the agent identity');
  }
  let entry: { agent?: unknown; problem?: unknown };
  try {
    entry = JSON.parse(sys.read(path)) as typeof entry;
  } catch {
    return refuse(io, `${path} is not what session-start writes`);
  }
  if (typeof entry.agent === 'string') return 0;
  return refuse(io, typeof entry.problem === 'string' ? `session-start said: ${entry.problem}` : `${path} names no agent`);
}

function refuse(io: Output, reason: string): number {
  io.err(`process-rules: refused, because this session does not work as the agent on GitHub: ${reason.replace(/\.$/, '')}. Do not work around it; tell the owner.`);
  return 2;
}
