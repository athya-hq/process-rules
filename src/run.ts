import { decisionsWeekly } from './decisions.ts';
import { prDesign } from './design.ts';
import { doctor } from './doctor.ts';
import { guard } from './guard.ts';
import { prIdentity } from './identity.ts';
import { machine } from './machine.ts';
import { reviewsDue } from './reviews.ts';
import { onboard, onboardArgs } from './onboard.ts';
import { sessionStart } from './session-start.ts';
import { prePush, prWorkRules } from './work.ts';
import type { Output, Sys } from './types.ts';

import { packageVersion } from './version.ts';

export type { Output } from './types.ts';
export { packageVersion, versionOf } from './version.ts';

export const USAGE = `Usage: process-rules <command>

Commands:
  machine [agent]  Set up this machine so agent sessions work as the agent account
  doctor [agent]   Check agent sessions here can work as the agent account
  onboard [owner agent] [--features a,b] [--add feature]
                   Set up the client repo here, for the features it turns on
  session-start    Run by a client's SessionStart hook: the agent identity, or GitHub locked out
  guard            Run by a client's PreToolUse hook: gh and git's remote commands only as the agent
  pr-identity      Run by the shared workflow: agent commits Verified and pushed by the agent
  pr-work-rules    Run by the shared workflow: an agent pull request builds one slice it may build
  pr-design        Run by the shared workflow: each state of the slice links a frame from the design library
  decisions-weekly Run by the shared workflow weekly: decision checks, undo issues, expiring labels
  reviews-due      For the review routine: open decisions whose review date has come, as JSON lines
  pre-push         Run by the pre-push git hook: the same rules before an agent session pushes
  help             Show this text
  version          Print the installed version

Without [agent], machine and doctor use the agent account .github/process-rules.json names
in the repo around the working directory.
onboard suggests the owner and agent the first time (or name them); after that it reads them from that file.
Features: identity (always on), pr-identity, board, work-rules, design, decisions, review.
--features lists them the first time (all when left out); --add turns one more on.`;

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 bad usage. */
export async function run(
  args: readonly string[],
  io: Output,
  sys: () => Sys | Promise<Sys>,
): Promise<number> {
  const [command, ...rest] = args;
  const allowed = command === 'onboard' ? Infinity : command === 'pre-push' ? 2 : command === 'machine' || command === 'doctor' ? 1 : 0;
  const extra = rest[allowed];
  if (extra !== undefined) {
    io.err(`process-rules: unexpected argument "${extra}"`);
    io.err(USAGE);
    return 2;
  }
  if (command === 'onboard') {
    // onboard's options are checked here, so a bad one is bad usage (exit 2).
    try {
      onboardArgs(rest);
    } catch (error) {
      io.err(`process-rules: ${error instanceof Error ? error.message : String(error)}`);
      io.err(USAGE);
      return 2;
    }
  }
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(USAGE);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      io.out(packageVersion());
      return 0;
    case 'session-start':
      return sessionStart(await sys(), io);
    case 'guard':
      // Any failure refuses: Claude Code runs the command when a PreToolUse hook exits 1.
      try {
        const real = await sys();
        return guard(real, io, real.readStdin());
      } catch (error) {
        io.err(`process-rules guard: refused, because the check failed: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    case 'machine':
    case 'doctor':
    case 'onboard':
    case 'pr-identity':
    case 'pr-work-rules':
    case 'pr-design':
    case 'decisions-weekly':
    case 'reviews-due':
    case 'pre-push':
      try {
        if (command === 'reviews-due') return await reviewsDue(await sys(), io);
        if (command === 'decisions-weekly') return await decisionsWeekly(await sys(), io);
        if (command === 'pr-design') return await prDesign(await sys(), io);
        if (command === 'pr-identity') return await prIdentity(await sys(), io);
        if (command === 'pr-work-rules') return await prWorkRules(await sys(), io);
        if (command === 'pre-push') {
          const real = await sys();
          return await prePush(real, io, real.readStdin(), rest[1]);
        }
        if (command === 'onboard') return await onboard(await sys(), io, rest);
        return await (command === 'machine' ? machine : doctor)(await sys(), io, rest[0]);
      } catch (error) {
        io.err(`process-rules ${command}: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    default:
      io.err(`process-rules: unknown command "${command}"`);
      io.err(USAGE);
      return 2;
  }
}
