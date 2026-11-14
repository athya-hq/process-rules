import { LOCKED, asAgent, asAgentArgs } from './as-agent.ts';
import { cloudSetup } from './cloud.ts';
import { needsOwner } from './asks.ts';
import { decisionsWeekly } from './decisions.ts';
import { prDesign } from './design.ts';
import { doctor } from './doctor.ts';
import { guard } from './guard.ts';
import { issueType } from './issue-types.ts';
import { prIdentity } from './identity.ts';
import { machine, machineArgs } from './machine.ts';
import { reviewsDue } from './reviews.ts';
import { reviewThread, threadArgs } from './review-thread.ts';
import { onboard, onboardArgs } from './onboard.ts';
import { ownerStep, ownerStepArgs } from './owner-step.ts';
import { sessionStart } from './session-start.ts';
import { upgrade } from './upgrade.ts';
import { prMerged, prePush, prWorkRules, propose } from './work.ts';
import type { Output, Sys } from './types.ts';

import { CLI } from './names.ts';
import { packageVersion } from './version.ts';

export type { Output } from './types.ts';
export { packageVersion, versionOf } from './version.ts';

export const USAGE = `Usage: niyam <command>

Commands:
  machine [agent] [--yes] [--dry-run]
                   Set up this machine so agent sessions work as the agent account
  doctor [agent]   Check agent sessions here can work as the agent account
  onboard [owner agent] [--features a,b] [--add feature] [--yes] [--dry-run]
                   Set up the client repo here, for the features it turns on
  upgrade          Install the newest release with pnpm, and check PATH runs it alone
  owner-step <step> [args]
                   In your own terminal: one GitHub step only the owner's account can do, through a
                   throwaway gh sign-in. Steps: issue-types <org>;
                   label <owner/repo> <number> <add|remove> <approved|do-not-merge>;
                   required-checks <owner/repo> <ruleset id or name> [--check <name>]…
  cloud-setup      Print the Setup snippet for a Claude cloud environment, pasted once
  session-start    Run by a client's SessionStart hook: the agent identity, or GitHub locked out
  guard            Run by a client's PreToolUse hook: gh and git's remote commands only as the agent
  as-agent --session <session_id> -- <command> [args...]
                   For a client's hook: run one command as the session's agent, or nothing (exit ${LOCKED})
  pr-identity      Run by the shared workflow: agent commits Verified and pushed by the agent
  pr-work-rules    Run by the shared workflow: an agent pull request builds one slice it may build
  pr-merged        Run by the shared workflow: a merged pull request closes the slice and States it names
  pr-design        Run by the shared workflow: each state of the slice links a frame from the design library
  decisions-weekly Run by the shared workflow weekly: decision checks, undo issues, expiring labels
  needs-owner      Run by the shared workflow: an ask labels its issue needs-owner; the owner's answer takes it off
  issue-type       Run by the shared workflow: an issue opened with no type gets the work model's
  reviews-due      For the review routine: open decisions whose review date has come, as JSON lines
  pre-push         Run by the pre-push git hook: the same rules before an agent session pushes
  propose <issue>... [--page <url>]
                   As the agent: ask the owner to approve, with a 👍, a slice added late or a dropped state,
                   in a short comment linking the published page that argues it (--page is needed
                   whenever a proposal is still to be posted; a rerun that only links needs none);
                   with an Approvals issue, it prints the first line of one comment there answering them all
  review-thread <thread-id> [--reply <text>] [--resolve]
                   As the agent: answer a review thread on one of its own pull requests here
  help             Show this text
  version          Print the installed version

as-agent's command gets the session's agent identity, stdin, stdout and stderr, and its
exit code is as-agent's; exit ${LOCKED} means the session does not work as the agent, and nothing ran.
Without [agent], machine and doctor use the agent account .github/niyam.json names
in the repo around the working directory.
onboard suggests the owner and agent the first time (or name them); after that it reads them from that file.
Features: identity (always on), pr-identity, board, work-rules, figma, decisions, review.
--features lists them the first time (all when left out); --add turns one more on.
machine and onboard print one plan and ask once; --yes goes ahead without asking, --dry-run stops at the plan.`;

/**
 * propose's issue numbers, one or several, and the page its comments link
 * (`--page <url>` or `--page=<url>`, once); throws on anything else, naming
 * the first argument that is not an issue number.
 */
export function proposeArgs(args: readonly string[]): { numbers: number[]; page?: string } {
  const issues: string[] = [];
  let page: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    const inline = arg.startsWith('--page=') ? arg.slice('--page='.length) : undefined;
    if (arg !== '--page' && inline === undefined) {
      issues.push(arg);
      continue;
    }
    if (page !== undefined) throw new Error('propose takes one --page: one page argues every proposal of the run');
    const value = inline ?? args[++at];
    if (!value || value.startsWith('-')) throw new Error("propose --page needs the published page's link");
    page = value;
  }
  const notIssue = issues.length === 0 ? '' : issues.find((arg) => !/^#?0*[1-9]\d*$/.test(arg));
  if (notIssue !== undefined) throw new Error(`propose needs an issue number${notIssue === '' ? '' : `, not "${notIssue}"`}`);
  return { numbers: issues.map((arg) => Number(arg.replace('#', ''))), ...(page === undefined ? {} : { page }) };
}

/** Runs one command and returns its exit code: 0 done, 1 failed, 2 bad usage. */
export async function run(args: readonly string[], io: Output, sys: () => Sys | Promise<Sys>): Promise<number> {
  const [command, ...rest] = args;
  const allowed = command === 'onboard' || command === 'machine' || command === 'review-thread' || command === 'as-agent' || command === 'propose' || command === 'owner-step' ? Infinity : command === 'pre-push' ? 2 : command === 'doctor' ? 1 : 0;
  const extra = rest[allowed];
  if (extra !== undefined) {
    io.err(`niyam: unexpected argument "${extra}"`);
    io.err(USAGE);
    return 2;
  }
  if (command === 'onboard' || command === 'machine' || command === 'review-thread' || command === 'as-agent' || command === 'propose' || command === 'owner-step') {
    // Their options are checked here, so a bad one is bad usage (exit 2).
    try {
      (command === 'onboard' ? onboardArgs : command === 'machine' ? machineArgs : command === 'as-agent' ? asAgentArgs : command === 'propose' ? proposeArgs : command === 'owner-step' ? ownerStepArgs : threadArgs)(rest);
    } catch (error) {
      io.err(`niyam: ${error instanceof Error ? error.message : String(error)}`);
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
    case 'cloud-setup':
      return cloudSetup(io);
    case 'session-start':
      return sessionStart(await sys(), io);
    case 'guard':
      // Any failure refuses: Claude Code runs the command when a PreToolUse hook exits 1.
      try {
        const real = await sys();
        return guard(real, io, real.readStdin());
      } catch (error) {
        io.err(`niyam guard: refused, because the check failed: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
      }
    case 'as-agent':
      // Any failure runs nothing and says so with the locked code, never the command's own.
      try {
        return asAgent(await sys(), io, asAgentArgs(rest));
      } catch (error) {
        io.err(`niyam as-agent: ran nothing, because the check failed: ${error instanceof Error ? error.message : String(error)}`);
        return LOCKED;
      }
    case 'machine':
    case 'doctor':
    case 'onboard':
    case 'pr-identity':
    case 'pr-work-rules':
    case 'pr-merged':
    case 'pr-design':
    case 'decisions-weekly':
    case 'needs-owner':
    case 'issue-type':
    case 'reviews-due':
    case 'pre-push':
    case 'propose':
    case 'review-thread':
    case 'upgrade':
    case 'owner-step':
      try {
        if (command === 'upgrade') return await upgrade(await sys(), io);
        if (command === 'owner-step') return await ownerStep(await sys(), io, rest);
        if (command === 'review-thread') return await reviewThread(await sys(), io, rest);
        if (command === 'propose') {
          const { numbers, page } = proposeArgs(rest);
          return await propose(await sys(), io, numbers, page);
        }
        if (command === 'reviews-due') return await reviewsDue(await sys(), io);
        if (command === 'decisions-weekly') return await decisionsWeekly(await sys(), io);
        if (command === 'needs-owner') return await needsOwner(await sys(), io);
        if (command === 'issue-type') return await issueType(await sys(), io);
        if (command === 'pr-design') return await prDesign(await sys(), io);
        if (command === 'pr-identity') return await prIdentity(await sys(), io);
        if (command === 'pr-work-rules') return await prWorkRules(await sys(), io);
        if (command === 'pr-merged') return await prMerged(await sys(), io);
        if (command === 'pre-push') {
          const real = await sys();
          return await prePush(real, io, real.readStdin(), rest[1] ?? '');
        }
        if (command === 'onboard') return await onboard(await sys(), io, rest);
        if (command === 'machine') return await machine(await sys(), io, rest);
        return await doctor(await sys(), io, rest[0]);
      } catch (error) {
        io.err(`niyam ${command}: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    default:
      io.err(`niyam: unknown command "${command}"`);
      io.err(USAGE);
      return 2;
  }
}
