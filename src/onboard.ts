import { OLD_PRODUCT, PRODUCT } from './names.ts';
import {
  API,
  BASE_ENV,
  SETTINGS_PATH,
  account,
  agentHere,
  agentsSetUp,
  anyLogin,
  checkToken,
  either,
  isLogin,
  keyPairProblem,
  loadSettings,
  pathsFor,
  readToken,
  repoAt,
  sameLogin,
  sessionEnv,
  tokenInfo,
} from './agent.ts';
import { setUpBoard } from './board.ts';
import { type OwnerToken, asOwner, isOrganisation, ownerScopes, signInOnce } from './owner-login.ts';
import { appendToArray, replaceValues, setMember } from './jsonedit.ts';
import { HOURLY } from './asks.ts';
import { DEFAULT_SCHEDULE, type Feature, FEATURES, FIGMA_FILE_KEY, NEEDS_ISSUE_TYPES, featuresIn, parseFeatures, renamedLines, scheduleIn } from './features.ts';
import { type Change, CLOUD_SETUP_PATH, HOOKS_PATH, ONBOARD_BRANCH, WORKFLOW_PATH, autoMerge, mergeQueue, openPull, remoteFile } from './onboard-pull.ts';
import { cloudRepoScript, cloudScriptVersion, releaseSha256 } from './cloud.ts';
import { setSecret } from './secrets.ts';
import { UPGRADE } from './upgrade.ts';
import { isNewer, packageVersion } from './version.ts';
import type { Output, Sys } from './types.ts';
import { GITHUB_WEB } from './host.ts';
import { type Item, type Paint, closing, heading, painter, planLines, runStep } from './layout.ts';

/** Where `cloud-setup`'s script goes in a Setup field the repo's own setup shares. */
export const SETUP_FIRST = "If the repo has its own Setup script, put this first, then the repo's own: a repo's script may end with exit, and nothing after that runs.";

/** This product's repository: clients call its shared workflow. */
export { PRODUCT } from './names.ts';
export { HOOKS_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
/**
 * The pre-push git hook: before a local agent session pushes, that it
 * reaches GitHub as the agent, then the work rules. It needs no Claude Code
 * hook to have run: any shell Claude Code runs sets CLAUDECODE, in a Claude
 * cloud session too.
 */
export const PRE_PUSH_HOOK = [
  '#!/bin/sh',
  '# Written by process-rules onboard: before an agent session pushes, that it pushes as the agent, then the work rules.',
  '# Anyone else\'s push goes ahead. Without the CLI nothing can check an agent session\'s push, so it is refused.',
  '[ -z "$PROCESS_RULES_AGENT" ] && [ "$CLAUDECODE" != 1 ] && exit 0',
  'cli="$HOME/.config/process-rules/bin/process-rules"',
  '[ -x "$cli" ] || cli=process-rules',
  'if ! command -v "$cli" >/dev/null 2>&1; then',
  '  echo "process-rules: the CLI is not installed, so this agent push cannot be checked" >&2',
  '  exit 1',
  'fi',
  'exec "$cli" pre-push "$@"',
  '',
].join('\n');

/** The pre-push hooks older releases wrote, which onboard replaces with this release's. */
export const OLDER_PRE_PUSH_HOOKS = [
  [
    '#!/bin/sh',
    '# Written by process-rules onboard: before an agent session pushes, that it pushes as the agent, then the work rules.',
    '# Anyone else\'s push goes ahead. Without the CLI nothing can check an agent session\'s push, so it is refused.',
    '[ "$CLAUDE_CODE_REMOTE" = true ] && exit 0',
    '[ -z "$PROCESS_RULES_AGENT" ] && [ "$CLAUDECODE" != 1 ] && exit 0',
    'cli="$HOME/.config/process-rules/bin/process-rules"',
    '[ -x "$cli" ] || cli=process-rules',
    'if ! command -v "$cli" >/dev/null 2>&1; then',
    '  echo "process-rules: the CLI is not installed, so this agent push cannot be checked" >&2',
    '  exit 1',
    'fi',
    'exec "$cli" pre-push "$@"',
    '',
  ].join('\n'),
  [
    '#!/bin/sh',
    '# Written by process-rules onboard: the work rules before an agent session pushes.',
    '# Without the CLI nothing can check an agent session\'s push, so it is refused; anyone else\'s goes ahead.',
    'if ! command -v process-rules >/dev/null 2>&1; then',
    '  [ -z "$PROCESS_RULES_AGENT" ] && exit 0',
    '  echo "process-rules: the CLI is not installed, so this agent push cannot be checked against the work rules" >&2',
    '  exit 1',
    'fi',
    'exec process-rules pre-push "$@"',
    '',
  ].join('\n'),
];

/**
 * The pre-push git hook git runs in the repository at `root`, and how it
 * stands: outside the repository (a shared hooks folder, the owner's to
 * change), missing, one an older release wrote, this release's or one that
 * runs the CLI, or the client's own.
 */
export function prePushHook(sys: Sys, root: string): { path: string; file: string; state: 'outside' | 'missing' | 'older' | 'ours' | 'own' } {
  const path = sys.exec('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: root }).stdout.trim();
  const file = path.startsWith('/') ? path : `${root}/${path}`;
  const gitDir = sys.exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }).stdout.trim();
  if (!file.startsWith(`${root}/`) && !file.startsWith(`${gitDir}/`)) return { path, file, state: 'outside' };
  if (!sys.exists(file)) return { path, file, state: 'missing' };
  const text = sys.read(file);
  if (OLDER_PRE_PUSH_HOOKS.includes(text)) return { path, file, state: 'older' };
  return { path, file, state: /^\s*(?:exec\s+)?(?:"\$cli"|process-rules|niyam)\s+pre-push\b/m.test(text) ? 'ours' : 'own' };
}

/** How a hook finds the CLI: the launcher `machine` writes, else whatever PATH has. */
const FIND_CLI = 'cli="$HOME/.config/process-rules/bin/process-rules"; [ -x "$cli" ] || cli=process-rules; ';

/**
 * What the client's SessionStart hook runs, on a Mac and in a Claude cloud
 * session alike. When the CLI is missing or fails, what it printed reaches
 * the session inside a line telling it to stop; the settings' `env` has
 * already locked GitHub out.
 */
export const HOOK_COMMAND =
  FIND_CLI +
  'if said=$("$cli" session-start 2>&1); then printf \'%s\\n\' "$said"; ' +
  'else printf \'%s\\n\' "process-rules: STOP. process-rules session-start did not run here ($said), so this session cannot be given the agent identity and GitHub is locked out of it. Do not push, fetch, or run gh in this session; tell the owner."; fi';

/**
 * What the client's PreToolUse hook runs before each Bash command: `guard`
 * refuses gh and git's remote commands outside the agent identity. A command
 * not naming either as a word goes ahead without starting the CLI. When the CLI cannot
 * run, every command naming either is refused, so a broken CLI fails closed.
 */
export const GUARD_COMMAND =
  'input=$(cat); ' +
  // The command alone, not the rest of the input, such as its description and paths.
  'cmd=$(printf \'%s\' "$input" | sed -nE \'s/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\\\]|\\\\.)*)".*/\\1/p\'); ' +
  'printf \'%s\' "$cmd" | grep -Eq \'(^|[^[:alnum:]_-])(gh|git)([^[:alnum:]_-]|$)\' || exit 0; ' +
  FIND_CLI +
  'printf \'%s\' "$input" | "$cli" guard && exit 0; [ $? -eq 2 ] && exit 2; ' +
  'echo "process-rules: refused, because the process-rules CLI did not run here to check this command. Do not work around it; tell the owner." >&2; exit 2';

/**
 * The permission rule that lets agent sessions answer review threads on
 * their own pull requests without a prompt: only the CLI command that does
 * that and checks it, not `gh api`, whose rules cannot hold its arguments.
 */
export const REVIEW_THREAD_RULE = 'Bash(process-rules review-thread *)';

/** The hook commands older releases wrote, which onboard replaces with this release's. */
export const OLDER_HOOK_COMMANDS = [
  `if [ "$CLAUDE_CODE_REMOTE" = true ]; then [ -z "$CLAUDE_ENV_FILE" ] || echo 'unset ${Object.keys(BASE_ENV).join(' ')}' >> "$CLAUDE_ENV_FILE"; else ` +
    FIND_CLI +
    'if said=$("$cli" session-start 2>&1); then printf \'%s\\n\' "$said"; ' +
    'else printf \'%s\\n\' "process-rules: STOP. process-rules session-start did not run here ($said), so this session cannot be given the agent identity and GitHub is locked out of it. Do not push, fetch, or run gh in this session; tell the owner."; fi; fi',
  'command -v process-rules >/dev/null 2>&1 && process-rules session-start || ' +
    'echo "process-rules: STOP. The process-rules CLI is not installed here, so this session cannot be given the agent identity and gh and git would act as the owner. Do not push, fetch, or run gh in this session; tell the owner."',
  'if [ "$CLAUDE_CODE_REMOTE" = true ]; then :; ' +
    'elif command -v process-rules >/dev/null 2>&1 && process-rules session-start; then :; ' +
    'else echo "process-rules: STOP. The process-rules CLI is missing or did not run here, so this session cannot be given the agent identity and gh and git would act as the owner. Do not push, fetch, or run gh in this session; tell the owner."; fi',
];

/** The guard commands older releases wrote, which onboard replaces with this release's. */
export const OLDER_GUARD_COMMANDS = [
  '[ "$CLAUDE_CODE_REMOTE" = true ] && exit 0; input=$(cat); ' +
    // The command alone, not the rest of the input, such as its description and paths.
    'cmd=$(printf \'%s\' "$input" | sed -nE \'s/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\\\]|\\\\.)*)".*/\\1/p\'); ' +
    'printf \'%s\' "$cmd" | grep -Eq \'(^|[^[:alnum:]_-])(gh|git)([^[:alnum:]_-]|$)\' || exit 0; ' +
    FIND_CLI +
    'printf \'%s\' "$input" | "$cli" guard && exit 0; [ $? -eq 2 ] && exit 2; ' +
    'echo "process-rules: refused, because the process-rules CLI did not run here to check this command. Do not work around it; tell the owner." >&2; exit 2',
];

/** The comment above the workflow's schedule, naming when the decisions job runs. */
function scheduleComment(schedule: string): string {
  return schedule === DEFAULT_SCHEDULE
    ? '  # The weekly decisions job: Mondays, 06:17 UTC.'
    : `  # The decisions job: cron ${schedule}, UTC, as "schedule" in ${SETTINGS_PATH} sets it.`;
}

/** The pull request events the workflow runs on, with why: since P-46, closed too. */
const TRIGGER_TYPES = [
  '    # edited: a changed "Slice: #N" line is checked again; closed: a merged pull request closes its slice.',
  '    types: [opened, synchronize, reopened, edited, closed]',
];
/** The pull request events before P-46. */
const OLDER_TRIGGER_TYPES = ['    # edited: a changed "Slice: #N" line is checked again.', '    types: [opened, synchronize, reopened, edited]'];
/** The read-only job's condition: a closed pull request runs the merged job alone. */
const READ_ONLY_IF = "    if: (github.event_name == 'pull_request' && github.event.action != 'closed') || github.event_name == 'push'";
const SPLIT_COMMENT = '# The weekly, merged and needs-owner jobs are split out so pull request and push runs stay read-only.';
/** The comment before the needs-owner job. */
const MERGED_SPLIT_COMMENT = '# The weekly and merged jobs are split out so pull request and push runs stay read-only.';

/** The events an ask and the owner's answer to it raise: since 0156 S-2, a comment and a label. */
const ASK_TRIGGERS = [
  "  # A comment that asks the owner labels its issue needs-owner; the owner's approved label or Decision: comment takes it off.",
  '  issue_comment:',
  '    types: [created]',
  '  pull_request_review_comment:',
  '    types: [created]',
  '  issues:',
  '    types: [labeled]',
];
/** The second cron, after the decisions job's: the hourly needs-owner sweep. */
const HOURLY_CRON = ["    # Hourly: the owner's 👍 on an ask takes its needs-owner label off.", `    - cron: '${HOURLY}'`];
/** The weekly job's condition: the decisions job's cron, not the hourly one, or a run by hand. */
const WEEKLY_IF = `    if: (github.event_name == 'schedule' && github.event.schedule != '${HOURLY}') || github.event_name == 'workflow_dispatch'`;
/** The weekly job's condition before the hourly sweep. */
const OLDER_WEEKLY_IF = "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
/** The asks job's comment clause: a comment by the owner, a member or a collaborator that may ask or decide. */
const ASKS_COMMENT_IF = [
  "      ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&",
  `      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&`,
  "      (contains(github.event.comment.body, 'Needs you:') || contains(github.event.comment.body, 'Proposal:') ||",
  "      contains(github.event.comment.body, 'Decision:'))) ||",
];
/** The clause 0.5.28 wrote, which any commenter's comment met; onboard adds the author check. */
const OLDER_ASKS_COMMENT_IF = ASKS_COMMENT_IF.filter((_, at) => at !== 1);

/**
 * The job that labels an issue where the agent asks the owner, and takes the
 * label off at the owner's answer: only comments that may ask or decide, the
 * owner's approved label and the hourly sweep start it, so other comments run
 * nothing. A comment starts it only from the owner, a member or a collaborator,
 * so no outsider's comment runs a job that may write; needs-owner itself acts
 * only on the agent's ask and the owner's answer.
 */
function asksJob(version: string, secrets: string[]): string[] {
  return [
    "  # An ask labels its issue needs-owner, which the board's Needs you view lists; the owner's answer takes it off.",
    '  process-rules-asks:',
    '    if: >-',
    ...ASKS_COMMENT_IF,
    "      (github.event_name == 'issues' && github.event.label.name == 'approved') ||",
    `      (github.event_name == 'schedule' && github.event.schedule == '${HOURLY}')`,
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: write',
    ...callChecks(version, secrets),
    '',
  ];
}

/** The job that closes the slice a merged pull request names, which alone of a pull request's runs writes to issues. */
function mergedJob(version: string, secrets: string[]): string[] {
  return [
    '  # A merged pull request closes the slice it names, which moves it to Done on the board.',
    '  process-rules-merged:',
    // Into the default branch alone, and from this repository: a fork's run gets a read-only token.
    '    if: >-',
    "      github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.merged &&",
    '      github.event.pull_request.base.ref == github.event.repository.default_branch &&',
    '      github.event.pull_request.head.repo.full_name == github.repository',
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: read',
    ...callChecks(version, secrets),
    '',
  ];
}

/**
 * The lines a workflow from before the merged job has where this release's
 * differs, each with what this release writes there; the comment is
 * optional, the others mark the template.
 */
const BEFORE_MERGED: { was: string; now: string; optional?: true }[] = [
  { was: '# The weekly job is split out so pull request and push runs stay read-only.', now: MERGED_SPLIT_COMMENT, optional: true },
  { was: OLDER_TRIGGER_TYPES.join('\n'), now: TRIGGER_TYPES.join('\n') },
  { was: "    if: github.event_name == 'pull_request' || github.event_name == 'push'", now: READ_ONLY_IF },
];

/**
 * A two-job workflow from before the merged job, as `before`, with the
 * merged job added at the version it pins and the pull request runs made to
 * leave it alone; undefined when its lines are not the template's.
 */
function addMergedJob(before: string, version: string, figma: boolean): string | undefined {
  let text = before;
  for (const { was, now, optional } of BEFORE_MERGED) {
    if (text.split(was).length !== 2) {
      if (optional) continue;
      return undefined;
    }
    text = text.replace(was, now);
  }
  return `${text.replace(/\n*$/, '\n')}\n${mergedJob(version, figma ? FIGMA_SECRETS : []).join('\n')}`;
}

/**
 * A three-job workflow from before the needs-owner job, as `before`, with
 * that job added at the version it pins: the comment and label triggers
 * before the schedule, the hourly cron after the decisions job's one, and the
 * weekly job made to leave the hourly runs alone. Undefined when its lines
 * are not the template's.
 */
function addAsksJob(before: string, version: string, figma: boolean): string | undefined {
  if (before.split(OLDER_WEEKLY_IF).length !== 2 || !SCHEDULE.test(before)) return undefined;
  const text = before
    .replace(MERGED_SPLIT_COMMENT, SPLIT_COMMENT)
    .replace(OLDER_WEEKLY_IF, WEEKLY_IF)
    .replace(SCHEDULE, (lines: string) => `${ASK_TRIGGERS.join('\n')}\n${lines}\n${HOURLY_CRON.join('\n')}`);
  return `${text.replace(/\n*$/, '\n')}\n${asksJob(version, figma ? FIGMA_SECRETS : []).join('\n')}`;
}

/** The workflow's head, down to its jobs, which every template shares; `asks` adds the needs-owner job's triggers. */
function workflowHead(branch: string, version: string, comments: string[], schedule = DEFAULT_SCHEDULE, types = TRIGGER_TYPES, asks = true): string[] {
  return [
    `# Written by process-rules onboard: the shared process-rules checks at v${version}.`,
    ...comments,
    'name: process-rules',
    '',
    'on:',
    '  pull_request:',
    ...types,
    '  push:',
    `    branches: [${JSON.stringify(branch)}]`,
    ...(asks ? ASK_TRIGGERS : []),
    scheduleComment(schedule),
    '  schedule:',
    `    - cron: '${schedule}'`,
    ...(asks ? HOURLY_CRON : []),
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '  issues: read',
    '  pull-requests: read',
    '',
    'jobs:',
  ];
}

/** The Figma secrets a job passes the shared checks, when the figma feature is on. */
const FIGMA_SECRETS = ['    secrets:', '      FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}', '      FIGMA_LIBRARY: ${{ secrets.FIGMA_LIBRARY }}'];
/** The secrets every job passed before P-23, whether figma was on or not. */
const OLDER_SECRETS = ['    secrets:', '      FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}'];
/**
 * A job's `process-rules-ref` line and the block of Figma secrets after it, as
 * either list writes it, or the line alone when no secrets follow: a block
 * with secrets of the client's own is left as it is.
 */
const SECRETS_AFTER_REF = /^( {6}process-rules-ref:[^\n]*\n)(?: {4}secrets:\n(?: {6}FIGMA_(?:TOKEN|LIBRARY): \$\{\{ secrets\.FIGMA_(?:TOKEN|LIBRARY) \}\}\n)+(?! {6})|(?! {4}secrets:))/gm;

/**
 * The jobs of a workflow that call the shared checks without passing them
 * FIGMA_LIBRARY, by name: each job's own block is read, so one job missing it
 * is found though another passes it.
 */
export function jobsWithoutLibrary(text: string): string[] {
  const jobs = text.slice(Math.max(0, text.search(/^jobs:\s*$/m)));
  return [...jobs.matchAll(/^ {2}([\w-]+):\s*\n((?:(?: {3,}.*)?\n|(?: {3,}.*)$)*)/gm)].flatMap(([, name, body = '']) =>
    /checks\.yml@/.test(body) && !/secrets\.FIGMA_LIBRARY\b|^ {4}secrets:\s*inherit\s*$/m.test(body) ? [name as string] : [],
  );
}

/** One job's call of the shared checks at `version`, passing `secrets`. */
function callChecks(version: string, secrets: string[]): string[] {
  return [
    `    uses: ${PRODUCT}/.github/workflows/checks.yml@v${version}`,
    '    with:',
    `      process-rules-ref: v${version}`,
    ...secrets,
  ];
}

/**
 * The client's workflow: the shared checks on every pull request, on pushes
 * to the default branch and weekly, at the niyam release `version`.
 * Pull request and push runs are read-only; the weekly job alone writes to
 * issues. Upgrading is changing that version, which each job names twice.
 * The Figma secrets are passed only when the figma feature is on; the
 * weekly job runs on the settings' `schedule`.
 */
export function workflow(branch: string, version: string, figma: boolean, schedule = DEFAULT_SCHEDULE): string {
  const secrets = figma ? FIGMA_SECRETS : [];
  return [
    ...workflowHead(
      branch,
      version,
      [
        '# To upgrade, change the version on every line that names it (two per job).',
        SPLIT_COMMENT,
      ],
      schedule,
    ),
    '  # Pull request and push runs: read-only.',
    '  process-rules:',
    READ_ONLY_IF,
    ...callChecks(version, secrets),
    '',
    '  # The weekly run alone writes to issues: it comments and opens undo issues.',
    '  process-rules-weekly:',
    WEEKLY_IF,
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: read',
    ...callChecks(version, secrets),
    '',
    ...mergedJob(version, secrets),
    ...asksJob(version, secrets),
  ].join('\n');
}

/**
 * The workflows older releases wrote, at `version`, which onboard replaces
 * with this release's: one job that wrote to issues on every run.
 */
export function olderWorkflows(branch: string, version: string): string[] {
  return [
    [
      ...workflowHead(branch, version, ['# To upgrade, change the version on both lines that name it.'], DEFAULT_SCHEDULE, OLDER_TRIGGER_TYPES, false),
      '  process-rules:',
      '    # Write to issues for this job only: the weekly run comments and opens undo issues.',
      '    permissions:',
      '      contents: read',
      '      issues: write',
      '      pull-requests: read',
      ...callChecks(version, OLDER_SECRETS),
      '',
    ].join('\n'),
  ];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A call of the shared workflow, at this repository or the one it moved from (GitHub forwards it), and its version. */
const CHECKS_PIN = new RegExp(`((?:${escape(PRODUCT)}|${escape(OLD_PRODUCT)})/\\.github/workflows/checks\\.yml@v)([^\\s'"#]+)`, 'g');
const REF_PIN = /^(\s+process-rules-ref:\s*['"]?v)([^\s'"#]+)/gm;
const HEADER_PIN = /^(# Written by process-rules onboard: the shared process-rules checks at v)(\S+?)(\.?)$/m;

/** The versions a workflow pins: each `checks.yml@v…`, then each `process-rules-ref: v…`. */
export function workflowPins(text: string): string[] {
  return [...text.matchAll(CHECKS_PIN), ...text.matchAll(REF_PIN)].map((match) => match[2] as string);
}

/** The one branch a workflow's `push:` trigger names, as `onboard` writes it, quoted or not. */
const PUSH_BRANCH = /^( {2}push:\n {4}branches: \[\s*)(['"]?)([^,'"\]\s]+)\2(\s*\])$/m;

/**
 * The one cron a workflow's `schedule:` trigger names, as `onboard` writes it,
 * quoted or not, with the comment `onboard` writes above it when it is there:
 * no other item follows it, past blank and comment lines, but the hourly needs-owner sweep's.
 */
const SCHEDULE = new RegExp(String.raw`^( {2}# The (?:weekly )?decisions job:[^\n]*\n)?( {2}schedule:\n {4}- cron: )(['"]?)([^'"#\n]+?)\3([ \t]*)$(?!(?:\n[ \t]*(?:#[^\n]*)?)*\n {4}- (?!cron: '${HOURLY.replaceAll('*', '\\*')}'[ \t]*$))`, 'm');

/**
 * `value` as a YAML flow scalar in the `quote` style the line already uses:
 * single quotes double themselves; double quotes, and a bare value YAML would
 * not read as that string (a number, a date, true or null), are written as
 * JSON, which YAML reads alike.
 */
function flowScalar(value: string, quote: string): string {
  if (quote === "'") return `'${value.replaceAll("'", "''")}'`;
  // Bare only when YAML reads it as a string: starting with a letter rules out numbers and dates.
  if (quote === '' && /^[A-Za-z][\w./-]*$/.test(value) && !/^(?:true|false|yes|no|on|off|y|n|null)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * What onboard does with the client's workflow: write it, replace an older
 * release's template, or, in a workflow already split into a read-only
 * `process-rules` job and a `process-rules-weekly` job, move the version pins,
 * the one branch pushes run on when the default branch has changed, the one
 * cron the weekly job runs on when the settings' schedule has changed, and
 * each job's Figma secrets to what the figma feature needs, leaving the rest
 * as the client has it.
 */
export function workflowUpdate(
  before: string | undefined,
  branch: string,
  version: string,
  figma: boolean,
  schedule = DEFAULT_SCHEDULE,
):
  | { kind: 'same' }
  | { kind: 'write' | 'replace-older' | 'replace'; text: string; from?: string }
  | { kind: 'repin'; text: string; from?: string; branch?: string; schedule?: string; secrets?: true; merged?: true; asks?: true; authors?: true } {
  const wanted = workflow(branch, version, figma, schedule);
  if (before === undefined) return { kind: 'write', text: wanted };
  if (before === wanted) return { kind: 'same' };
  const pins = workflowPins(before);
  const from = pins[0];
  const pushed = PUSH_BRANCH.exec(before)?.[3];
  if (from !== undefined && pushed !== undefined && olderWorkflows(pushed, from).includes(before)) {
    return { kind: 'replace-older', text: wanted, from };
  }
  const split = /^ {2}process-rules:\s*$/m.test(before) && /^ {2}process-rules-weekly:\s*$/m.test(before);
  const merged = /^ {2}process-rules-merged:\s*$/m.test(before);
  const added = split && !merged && pins.length === 4 && from !== undefined ? addMergedJob(before, from, figma) : undefined;
  if (added !== undefined) {
    const update = workflowUpdate(added, branch, version, figma, schedule);
    return { ...(update.kind === 'repin' ? update : { text: added }), kind: 'repin', merged: true };
  }
  const asks = /^ {2}process-rules-asks:\s*$/m.test(before);
  const withAsks = split && merged && !asks && pins.length === 6 && from !== undefined ? addAsksJob(before, from, figma) : undefined;
  if (withAsks !== undefined) {
    const update = workflowUpdate(withAsks, branch, version, figma, schedule);
    return { ...(update.kind === 'repin' ? update : { text: withAsks }), kind: 'repin', asks: true };
  }
  if (split && merged && asks && pins.length === 8) {
    const moved = pushed !== undefined && pushed !== branch;
    const cron = SCHEDULE.exec(before)?.[4]?.trim();
    const rescheduled = cron !== undefined && cron.split(/\s+/).join(' ') !== schedule;
    const authors = before.includes(OLDER_ASKS_COMMENT_IF.join('\n'));
    const pinned = before
      .replace(OLDER_ASKS_COMMENT_IF.join('\n'), ASKS_COMMENT_IF.join('\n'))
      .replace(CHECKS_PIN, () => `${PRODUCT}/.github/workflows/checks.yml@v${version}`)
      .replace(REF_PIN, (_, head: string) => `${head}${version}`)
      .replace(HEADER_PIN, (_, head: string, _old: string, dot: string) => `${head}${version}${dot}`)
      .replace(PUSH_BRANCH, (line: string, head: string, quote: string, _old: string, tail: string) =>
        moved ? `${head}${flowScalar(branch, quote)}${tail}` : line,
      )
      .replace(SCHEDULE, (line: string, comment: string | undefined, head: string, quote: string, _old: string, tail: string) =>
        rescheduled ? `${comment === undefined ? '' : `${scheduleComment(schedule)}\n`}${head}${quote || "'"}${schedule}${quote || "'"}${tail}` : line,
      );
    const secrets = figma ? `${FIGMA_SECRETS.join('\n')}\n` : '';
    const text = pinned.replace(SECRETS_AFTER_REF, (_, ref: string) => `${ref}${secrets}`);
    if (text === before) return { kind: 'same' };
    const stale = pins.find((pin) => pin !== version);
    return { kind: 'repin', text, ...(stale ? { from: stale } : {}), ...(moved ? { branch } : {}), ...(rescheduled ? { schedule } : {}), ...(text !== pinned ? { secrets: true as const } : {}), ...(authors ? { authors: true as const } : {}) };
  }
  return { kind: 'replace', text: wanted };
}

/** A niyam release a repository pins, and where. */
interface Pin {
  version: string;
  where: string;
}

/** The newest of `pins` that is newer than `version`, if any. */
function newest(pins: Pin[], version: string): Pin | undefined {
  return pins.filter((pin) => isNewer(pin.version, version)).reduce<Pin | undefined>((best, pin) => (best === undefined || isNewer(pin.version, best.version) ? pin : best), undefined);
}

/**
 * A release newer than `version` that the checkout pins already, in its
 * workflow or its cloud setup file. An older CLI onboarding over it would
 * move the pins back and drop what the newer release added.
 */
function newerPinHere(fileAt: (path: string) => string | undefined, version: string): Pin | undefined {
  return newest(
    [
      ...workflowPins(fileAt(WORKFLOW_PATH) ?? '').map((pin) => ({ version: pin, where: `${WORKFLOW_PATH} in this checkout` })),
      ...[cloudScriptVersion(fileAt(CLOUD_SETUP_PATH) ?? '')].filter((pin) => pin !== undefined).map((pin) => ({ version: pin, where: `${CLOUD_SETUP_PATH} in this checkout` })),
    ],
    version,
  );
}

/**
 * A release newer than `version` that the repository pins on GitHub: on the
 * default branch, which a checkout may be behind, or on the branch of an open
 * onboard pull request, which a newer release may have pushed and this run
 * would push over. A problem when GitHub does not say, so a run never moves
 * a pin back for want of an answer.
 */
async function newerPinOnGitHub(sys: Sys, slug: string, token: string, branch: string | undefined, version: string): Promise<Pin | { problem: string } | undefined> {
  const refs = branch === undefined ? [] : [branch];
  const pulls = await sys.http(`${API}/repos/${slug}/pulls?state=open&head=${slug.split('/')[0]}:${ONBOARD_BRANCH}`, { token }).catch(() => ({ status: 0, json: undefined }));
  if (pulls.status !== 200 || !Array.isArray(pulls.json)) return { problem: `GitHub did not say whether an onboard pull request is open (${pulls.status === 0 ? 'no answer' : `HTTP ${pulls.status}`})` };
  if (pulls.json.length > 0) refs.push(ONBOARD_BRANCH);
  const pins: Pin[] = [];
  for (const ref of refs) {
    const read = await remoteFile(sys, slug, WORKFLOW_PATH, ref, token);
    if ('problem' in read) return read;
    pins.push(...workflowPins(read.text ?? '').map((pin) => ({ version: pin, where: `${WORKFLOW_PATH} on ${ref}` })));
  }
  return newest(pins, version);
}

/** onboard's refusal of a repository that pins a newer release than this one. */
function refuseOlder(io: Output, slug: string, pin: Pin, version: string): number {
  io.err(`onboard: ${slug} already pins niyam v${pin.version} (${pin.where}), and this is v${version}; onboard never moves the pin back`);
  io.err(`  Update this Mac's niyam first: ${UPGRADE}`);
  return 1;
}

/** What GitHub says about the agent's access to a repository. */
type Access =
  | { kind: 'push'; branch: string }
  | { kind: 'read'; branch?: string }
  | { kind: 'none' }
  | { kind: 'refused'; reason: string };

async function access(sys: Sys, slug: string, token: string): Promise<Access> {
  const { status, json, headers = {} } = await sys.http(`${API}/repos/${slug}`, { token });
  const repo = json as { default_branch?: unknown; permissions?: { push?: unknown }; message?: unknown } | null;
  if (status === 200) {
    return repo?.permissions?.push === true && typeof repo.default_branch === 'string'
      ? { kind: 'push', branch: repo.default_branch }
      : { kind: 'read', ...(typeof repo?.default_branch === 'string' ? { branch: repo.default_branch } : {}) };
  }
  if (status === 404) return { kind: 'none' };
  const sso = /url=(\S+)/.exec(headers['x-github-sso'] ?? '')?.[1];
  if (sso) {
    return { kind: 'refused', reason: `the organisation requires SAML single sign-on; authorise the token for it at ${sso}` };
  }
  const message = typeof repo?.message === 'string' ? repo.message : '';
  if (/personal access tokens? \(classic\)/i.test(message)) {
    return {
      kind: 'refused',
      reason: `the organisation does not allow classic tokens ("${message}"); an organisation owner can allow them under Settings → Personal access tokens`,
    };
  }
  return { kind: 'refused', reason: `GitHub refused (HTTP ${status}${message ? `: ${message}` : ''})` };
}

/** The agent's pending invitation to `slug`, if any, looking through every page GitHub lists. */
async function invitation(sys: Sys, slug: string, token: string): Promise<number | undefined> {
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}/user/repository_invitations?per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) return undefined;
    const found = json.find((entry: unknown) => {
      const name = (entry as { repository?: { full_name?: unknown } } | null)?.repository?.full_name;
      return typeof name === 'string' && sameLogin(name, slug);
    }) as { id?: unknown } | undefined;
    if (typeof found?.id === 'number') return found.id;
    if (json.length < 100) return undefined;
  }
}

/** The command entries under one hook event, as written in the settings object. */
function hooksOf(settings: object, event: string): { command?: unknown }[] {
  const groups = (settings as { hooks?: Record<string, unknown> }).hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    const hooks = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) ? hooks.filter((hook): hook is { command?: unknown } => typeof hook === 'object' && hook !== null) : [];
  });
}

/**
 * The client's Claude Code settings with this release's hooks and lock: each
 * entry an older release wrote swapped where it stands, a missing one added,
 * the lock's variables set in `env`, and REVIEW_THREAD_RULE allowed. Every edit is made in the text, so
 * the rest of the file keeps its layout. Says what changed, for the question.
 */
export function claudeSettings(before: string | undefined): { text: string; changes: string[]; labels: string[] } {
  let text = before ?? '{}\n';
  const changes: string[] = [];
  // The same, in a word or two each, for the plan.
  let hooksChanged: 'added' | 'updated' | undefined;
  const labels: string[] = [];
  const parsed = (): object => JSON.parse(text) as object;
  const first: unknown = parsed();
  if (typeof first !== 'object' || first === null || Array.isArray(first)) throw new Error(`${HOOKS_PATH} is not a JSON object`);
  const hooks: [string, string, readonly string[], string, Record<string, unknown>][] = [
    ['SessionStart', HOOK_COMMAND, OLDER_HOOK_COMMANDS, 'the SessionStart hook that runs process-rules session-start', {}],
    ['PreToolUse', GUARD_COMMAND, OLDER_GUARD_COMMANDS, "the PreToolUse hook that refuses gh and git's remote commands outside the agent identity", { matcher: 'Bash' }],
  ];
  try {
    for (const [event, command, older, name, extra] of hooks) {
      const swapped = replaceValues(text, ['hooks', event, '*', 'hooks', '*', 'command'], (value) =>
        typeof value === 'string' && older.includes(value) ? command : undefined,
      );
      if (swapped.replaced > 0) {
        text = swapped.text;
        changes.push(`replace the older ${name.replace(/^the /, '')} with this release's`);
        hooksChanged = 'updated';
      } else if (!hooksOf(parsed(), event).some((hook) => hook.command === command)) {
        text = appendToArray(text, ['hooks'], event, { ...extra, hooks: [{ type: 'command', command }] });
        changes.push(`add ${name}`);
        hooksChanged ??= 'added';
      }
    }
    const env = (parsed() as { env?: unknown }).env;
    const current = typeof env === 'object' && env !== null ? (env as Record<string, unknown>) : {};
    const missing = Object.entries(BASE_ENV).filter(([name, value]) => current[name] !== value);
    for (const [name, value] of missing) text = setMember(text, ['env'], name, value);
    const names = missing.map(([name]) => name);
    const named = names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
    if (hooksChanged) labels.push(`hooks ${hooksChanged}`);
    if (missing.length > 0) {
      changes.push(`set ${named} in env, so GitHub is locked out until session-start gives the agent identity`);
      labels.push('lock');
    }
    const allow = (parsed() as { permissions?: { allow?: unknown } }).permissions?.allow;
    if (!Array.isArray(allow) || !allow.includes(REVIEW_THREAD_RULE)) {
      text = appendToArray(text, ['permissions'], 'allow', REVIEW_THREAD_RULE);
      changes.push('allow process-rules review-thread without a prompt, so agent sessions answer review threads on their own pull requests');
      labels.push('review rule');
    }
  } catch (error) {
    throw new Error(`${HOOKS_PATH}: ${(error as Error).message}`);
  }
  return { text, changes, labels };
}

/** Who the run's sign-in is, the owner's likely login; undefined when it failed. */
async function signedInLogin(signIn: () => Promise<OwnerToken | { problem: string }>): Promise<string | undefined> {
  const signed = await signIn().catch(() => undefined);
  return signed && 'login' in signed ? signed.login : undefined;
}

/**
 * Asks for an account, offering what this Mac suggests: Enter takes the
 * first suggestion. Undefined when there is none and nothing is typed.
 */
async function choose(sys: Sys, io: Output, role: string, suggestions: (string | undefined)[]): Promise<string | undefined> {
  const offered = suggestions.filter((login): login is string => !!login);
  if (offered.length > 1) io.out(`Accounts set up here for the ${role.split(',')[0]}: ${offered.join(', ')}`);
  const typed = (await sys.ask(`The ${role}${offered[0] ? ` [${offered[0]}]` : ''}: `)).trim();
  return typed || offered[0];
}

/** onboard's arguments: up to two logins, then `--features a,b` (first time) or `--add <feature>`, `--yes` and `--dry-run`. */
export function onboardArgs(args: readonly string[]): { named: string[]; features?: Feature[]; add?: Feature; yes?: true; dryRun?: true } {
  const named: string[] = [];
  let features: Feature[] | undefined;
  let add: Feature | undefined;
  let yes = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = args[i + 1];
    if (arg === '--yes') yes = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--features' || arg === '--add') {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--features') features = parseFeatures(value);
      else {
        const [, feature] = parseFeatures(value);
        if (!feature || value.includes(',')) throw new Error('--add takes one feature other than identity');
        add = feature;
      }
      i++;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else if (named.length < 2) {
      named.push(arg);
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }
  return { named, ...(features ? { features } : {}), ...(add ? { add } : {}), ...(yes ? { yes: true as const } : {}), ...(dryRun ? { dryRun: true as const } : {}) };
}

/** A step the run takes after the yes, in order; `owner` when it acts as the owner, so the sign-in comes before its spinner. */
interface Step {
  label: string;
  owner?: true;
  run(io: Output, ownerToken: string | undefined): Promise<boolean>;
}

/** What a workflow update changes, in a few words for the plan. */
function workflowDetail(update: Exclude<ReturnType<typeof workflowUpdate>, { kind: 'same' }>, version: string, figma: boolean): string {
  if (update.kind !== 'repin') return { write: 'new', 'replace-older': 'older template replaced', replace: 'replaced' }[update.kind];
  return (
    [
      ...(update.from ? [`pins → v${version}`] : []),
      ...(update.branch ? [`branch → ${update.branch}`] : []),
      ...(update.schedule ? [`schedule → ${update.schedule}`] : []),
      ...(update.secrets ? [figma ? 'Figma secrets' : 'no Figma secrets'] : []),
      ...(update.merged ? ['merged job'] : []),
      ...(update.asks ? ['needs-owner job'] : []),
      ...(update.authors ? ['needs-owner job only for owners, members and collaborators'] : []),
    ].join(', ') || `header → v${version}`
  );
}

/** What a workflow update changes, in full for the pull request's description. */
function workflowWhat(update: Exclude<ReturnType<typeof workflowUpdate>, { kind: 'same' }>, version: string, figma: boolean, schedulePath: string): string {
  if (update.kind !== 'repin') {
    return {
      write: `write ${WORKFLOW_PATH}, which runs the shared niyam checks`,
      'replace-older': `replace the older ${WORKFLOW_PATH}, which lets every run write to issues, with this release's, which lets the weekly run alone`,
      replace: `replace ${WORKFLOW_PATH}, which runs the shared niyam checks`,
    }[update.kind];
  }
  const parts = [
    ...(update.from ? [`move the version pins from v${update.from} to v${version}`] : []),
    ...(update.branch ? [`run pushes on the default branch, ${update.branch}`] : []),
    ...(update.schedule ? [`run the weekly decisions job on the schedule ${schedulePath} sets, cron ${update.schedule} UTC`] : []),
    ...(update.secrets ? [figma ? 'pass the FIGMA_TOKEN and FIGMA_LIBRARY secrets' : 'stop passing Figma secrets, with figma off'] : []),
    ...(update.merged ? ['add a job that closes the slice a merged pull request names, the one pull request run that writes to issues'] : []),
    ...(update.asks ? ["add a job that labels an issue needs-owner where the agent asks the owner, and takes it off at the owner's approved label, Decision: comment or (hourly) 👍"] : []),
    ...(update.authors ? ['start the needs-owner job only on a comment by the owner, a member or a collaborator'] : []),
  ];
  return `in ${WORKFLOW_PATH}, ${parts.join(' and ') || `set the version in its header comment to v${version}`}, leaving the rest as it is`;
}

/** The plan's head: the release onboard moves the repository to, then who is who, and any warnings. */
function planHead(paint: Paint, head: { from?: string | undefined; version: string; slug: string; owner: string; agent: string; warnings: string[] }): string[] {
  const bar = paint.dim('│');
  return [
    heading(paint, 'onboard', `${head.from && head.from !== head.version ? `v${head.from} → ` : ''}v${head.version}`),
    `${bar}  ${head.slug} · owner ${head.owner} · agent ${head.agent}`,
    ...head.warnings.map((warning) => `${bar}  ! ${warning}`),
  ];
}

/**
 * Sets up the client repository the working directory is in, run by its
 * owner on a Mac `machine` has set up for the agent. It first works out
 * everything it would change, changing nothing: the settings file, the
 * Claude Code settings, the workflow and the cloud setup file, opened as the agent's pull request
 * so the owner's checkout is never modified; the agent's push access; the
 * work board (issue types, labels, Project, fields and views); the pre-push
 * hook; and one signed test commit GitHub must show as Verified by the
 * agent. It prints that as one plan and asks once (`--yes` skips the
 * question, `--dry-run` stops at the plan); a no changes nothing. After the
 * yes, one browser sign-in as the owner serves every step that acts as the
 * owner, and each step shows as one line.
 */
export async function onboard(sys: Sys, io: Output, args: readonly string[] = []): Promise<number> {
  const { named, features: chosen, add, yes, dryRun } = onboardArgs(args);
  if (sys.env.PROCESS_RULES_AGENT) {
    io.err('onboard: run it in your own terminal, not in an agent session');
    return 1;
  }
  if (!sys.tty && !yes && !dryRun) {
    io.err('onboard: no terminal to ask in; pass --yes to go ahead without asking, or --dry-run to see the plan');
    return 1;
  }
  const { root, slug } = repoAt(sys);
  const paint = painter(sys);
  const bar = paint.dim('│');
  const say = (line: string): void => io.out(`${bar}  ${line}`);
  const version = packageVersion();
  // Whether an organisation owns the repository, asked of GitHub once in this run.
  let organisation: Promise<boolean> | undefined;
  const byOrganisation = (): Promise<boolean> => (organisation ??= isOrganisation(sys, slug.split('/')[0] as string));
  const personal = `${slug} is owned by a personal account, and GitHub has issue types for organisations only`;
  // The repository's files are changed only through the agent's pull request at the end: until then each
  // change is held here, and read back from here, so the owner's checkout is never modified.
  const changes = new Map<string, Change>();
  const fileAt = (path: string): string | undefined => {
    const held = changes.get(path);
    if (held !== undefined) return held.text;
    return sys.exists(`${root}/${path}`) ? sys.read(`${root}/${path}`) : undefined;
  };
  const change = (path: string, text: string, what: string): void => {
    const held = changes.get(path);
    const before = held ? held.before : fileAt(path);
    changes.set(path, { path, before, text, what: held ? `${held.what}; ${what}` : what });
  };
  // Before anything is asked or planned: a checkout a newer release onboarded is never moved back.
  const aheadHere = newerPinHere(fileAt, version);
  if (aheadHere !== undefined) return refuseOlder(io, slug, aheadHere, version);
  // The plan, by group, and the steps that carry it out after the yes.
  const pull: Item[] = [];
  const github: Item[] = [];
  const mac: Item[] = [];
  const cloud: Item[] = [];
  const steps: Step[] = [];
  const warnings: string[] = [];
  const byHand: string[] = [];
  // For the pull request's description: what was done outside it, and why, and in full what is left to do by hand.
  const notes: string[] = [];
  const later: string[] = [];
  // The owner's sign-in for this run: one browser approval at the first step that needs it, never stored.
  let scopes: string[] = [];
  let signedIn: Promise<OwnerToken | { problem: string }> | undefined;
  // `as` is who may sign in: the owner, the settings' owners while the run has not chosen one, or none yet known.
  const signIn = (as: readonly string[] = []): Promise<OwnerToken | { problem: string }> =>
    (signedIn ??= (async () => {
      // The features the run ends with: the sign-in can come before --add's feature is turned on.
      scopes = ownerScopes(add ? [...features, add] : features, await byOrganisation());
      // Which access the approval grants: gh's own repo scope, and what the run's features add.
      io.out(`${paint.done('◇')}  Sign in to GitHub as ${as.length === 0 ? 'the owner' : either(as)}, for this run only: ${['repo', ...scopes].join(', ')}`);
      const signed = await signInOnce(sys, scopes, say);
      if ('login' in signed) io.out(`${paint.done('◇')}  Signed in as ${signed.login}`);
      return signed;
    })());
  const ownerToken = async (): Promise<string | undefined> => {
    const token = asOwner(await signIn([owner]), owner, scopes);
    if (typeof token === 'string') return token;
    io.err(`onboard: ${token.problem}`);
    return undefined;
  };

  let owner: string;
  let agent: string;
  let features: Feature[];
  let schedule = DEFAULT_SCHEDULE;
  if (fileAt(SETTINGS_PATH) !== undefined) {
    const settings = loadSettings(sys, root);
    if (chosen) {
      io.err(`onboard: ${SETTINGS_PATH} already lists its features; turn one more on with --add <feature>`);
      return 1;
    }
    const [namedOwner, namedAgent] = named;
    if ((namedOwner && !anyLogin(settings.owners, namedOwner)) || (namedAgent && !anyLogin(settings.agents, namedAgent))) {
      io.err(`onboard: ${SETTINGS_PATH} already names owner ${either(settings.owners)} and agent ${either(settings.agents)}; edit or delete it to change them`);
      return 1;
    }
    // With several agents, the one named, else the one set up here.
    const here = namedAgent ? { agent: namedAgent } : agentHere(sys, settings.agents);
    if ('problem' in here) {
      io.err(`onboard: ${here.problem}; name the owner and the agent: niyam onboard <owner> <agent>`);
      return 1;
    }
    let raw = JSON.parse(fileAt(SETTINGS_PATH) as string) as Record<string, unknown>;
    features = featuresIn(raw);
    schedule = scheduleIn(raw);
    // With several owners, the one named, else the one the run's sign-in is, which must be listed: after the
    // features are read, which the sign-in's scopes depend on. Only the sign-in can tell, so it comes before the plan.
    let chosenOwner = namedOwner ?? (settings.owners.length === 1 ? settings.owners[0] : undefined);
    if (!chosenOwner) {
      if (dryRun) {
        io.err(`onboard: ${SETTINGS_PATH} names the owners ${either(settings.owners)}; name yours for a dry run, which signs in to nothing: niyam onboard <owner> --dry-run`);
        return 1;
      }
      const signed = await signIn(settings.owners);
      if ('problem' in signed) {
        io.err(`onboard: ${signed.problem}; name the owner: niyam onboard <owner>`);
        return 1;
      }
      if (!anyLogin(settings.owners, signed.login)) {
        io.err(`onboard: the browser signed in to GitHub as ${signed.login}, but ${SETTINGS_PATH} names the owners ${either(settings.owners)}; sign in there as one of them and run it again`);
        return 1;
      }
      chosenOwner = signed.login;
      notes.push(`- onboard signed in before showing its plan: ${SETTINGS_PATH} names several owners, and only the sign-in tells which one ran it.`);
    }
    // GitHub's spelling, which the keychain, the session file and commits use.
    owner = (await account(sys, chosenOwner)).login;
    agent = (await account(sys, here.agent)).login;
    // Before any change, so a refused --add leaves the settings as they were.
    if (add && !features.includes(add) && NEEDS_ISSUE_TYPES.includes(add) && !(await byOrganisation())) {
      io.err(`onboard: ${personal}, so ${add} cannot run here`);
      return 1;
    }
    // Settings an older release wrote: a feature by its older name, or the Figma library key, which belongs in a secret.
    const renamed = renamedLines(raw).length > 0;
    if (renamed || raw.figma !== undefined) {
      const library = (raw.figma as { library?: unknown } | null)?.library;
      // Set as the secret only when it is a file key, so nothing else is stored as one.
      const fileKey = typeof library === 'string' && FIGMA_FILE_KEY.test(library) ? library : undefined;
      const updates = [
        ...(renamed ? ['rename the design feature to figma'] : []),
        ...(raw.figma === undefined
          ? []
          : [fileKey ? 'take out "figma" and set its library key as the FIGMA_LIBRARY Actions secret' : 'take out "figma", since the library key belongs in the FIGMA_LIBRARY Actions secret']),
      ];
      pull.push({ label: 'process-rules.json', detail: [...(renamed ? ['design → figma'] : []), ...(raw.figma === undefined ? [] : ['figma key out'])].join(', ') });
      const { figma: _figma, ...rest } = raw;
      raw = { ...rest, ...(rest.features === undefined ? {} : { features }) };
      change(SETTINGS_PATH, `${JSON.stringify(raw, null, 2)}\n`, updates.join(' and '));
      if (fileKey) {
        github.push({ label: 'FIGMA_LIBRARY secret' });
        steps.push({
          label: 'FIGMA_LIBRARY secret',
          owner: true,
          async run(out, mine) {
            const problem = await setSecret(sys, slug, mine as string, 'FIGMA_LIBRARY', fileKey);
            if (problem) out.err(`onboard: ${problem}`);
            else out.out('set the FIGMA_LIBRARY Actions secret to the library key taken out of the settings');
            return !problem;
          },
        });
      } else if (library !== undefined) {
        byHand.push(`FIGMA_LIBRARY secret: the design library's file key → ${GITHUB_WEB}/${slug}/settings/secrets/actions`);
        later.push(`The "figma.library" taken out was not a Figma file key; set the FIGMA_LIBRARY Actions secret to the design library's file key under ${slug} → Settings → Secrets and variables → Actions.`);
      }
    }
    const typed = features.filter((feature) => NEEDS_ISSUE_TYPES.includes(feature));
    if (typed.length > 0 && !(await byOrganisation())) {
      warnings.push(`${typed.join(', ')}: organisations only; take ${typed.length === 1 ? 'it' : 'them'} out of features`);
    }
    if (add && !features.includes(add)) {
      features = FEATURES.filter((feature) => features.includes(feature) || feature === add);
      pull.push({ label: 'process-rules.json', detail: `turn ${add} on` });
      // The pull request opens only once every step has finished, so settings never claim a half-set-up feature.
      change(SETTINGS_PATH, `${JSON.stringify({ ...raw, features }, null, 2)}\n`, `turn ${add} on`);
    }
  } else {
    if (add) {
      io.err(`onboard: there is no ${SETTINGS_PATH} to add to; run niyam onboard <owner> <agent> first`);
      return 1;
    }
    features = chosen ?? [...FEATURES];
    if ((!named[0] || !named[1]) && !sys.tty) {
      io.err('onboard: name the owner and the agent account: niyam onboard <owner> <agent>');
      return 1;
    }
    // The sign-in suggests the owner, so it comes before the plan; a dry run signs in to nothing.
    const suggested = named[0] || dryRun ? undefined : await signedInLogin(signIn);
    if (suggested) notes.push('- onboard signed in before showing its plan, to suggest the owner by the account the browser signed in as.');
    const namedOwner = named[0] ?? (await choose(sys, io, 'owner, who approves', [suggested]));
    const namedAgent = named[1] ?? (await choose(sys, io, 'agent, which builds', agentsSetUp(sys)));
    if (!namedOwner || !namedAgent) {
      io.err('onboard: name the owner and the agent account: niyam onboard <owner> <agent>');
      return 1;
    }
    for (const login of [namedOwner, namedAgent]) {
      if (!isLogin(login)) throw new Error(`"${login}" is not a GitHub login`);
    }
    owner = (await account(sys, namedOwner)).login;
    agent = (await account(sys, namedAgent)).login;
    if (sameLogin(owner, agent)) {
      io.err('onboard: the owner and the agent must be different accounts');
      return 1;
    }
    const typed = features.filter((feature) => NEEDS_ISSUE_TYPES.includes(feature));
    const refused = typed.length > 0 && !(await byOrganisation());
    if (refused) {
      if (chosen) {
        io.err(`onboard: ${personal}, so ${typed.join(', ')} cannot run here; leave ${typed.length === 1 ? 'it' : 'them'} out of --features`);
        return 1;
      }
      warnings.push(`personal account: ${typed.join(', ')} left off`);
      features = features.filter((feature) => !typed.includes(feature));
    }
    pull.push({ label: 'process-rules.json', detail: `new, ${features.length} feature${features.length === 1 ? '' : 's'} on` });
    change(SETTINGS_PATH, `${JSON.stringify({ owner, agent, features }, null, 2)}\n`, `owner ${owner} approves, agent ${agent} builds, with ${features.join(', ')} on`);
  }
  const on = (feature: Feature): boolean => features.includes(feature);
  const workflowNeeded = on('pr-identity') || on('work-rules') || on('figma') || on('decisions') || on('review');

  const existing = fileAt(HOOKS_PATH);
  // Worked out before the plan, so a file onboard cannot edit is refused before any question.
  const claude = claudeSettings(existing);
  if (claude.changes.length > 0) {
    pull.push({ label: 'settings.json', detail: existing === undefined ? 'new' : claude.labels.join(', ') });
    change(HOOKS_PATH, claude.text, claude.changes.join('; '));
  }

  const paths = pathsFor(sys.home, agent);
  const token = readToken(sys, agent);
  const ready = token && checkToken(token, await tokenInfo(sys, token), agent, sys.now());
  const keyProblem = keyPairProblem(sys, paths.key);
  if (!token || !ready || ready.problem !== undefined || keyProblem) {
    // machine is the owner's to run, apart from onboard: it asks for the agent's token, hidden, and makes and
    // registers the agent's signing key, and a --yes or a run with no terminal can do neither (docs/decisions.md).
    const why = !token || !ready ? `no token stored for ${agent}` : (ready.problem ?? keyProblem);
    io.err(`onboard: this Mac is not set up for ${agent} (${why}); run niyam machine ${agent}, then onboard again`);
    return 1;
  }
  const { id } = await account(sys, agent);

  let reach = await access(sys, slug, token);
  if (reach.kind === 'refused') {
    io.err(`onboard: ${reach.reason}`);
    return 1;
  }
  // An agent that cannot see the repository has no pull request open on it, and the checkout was checked above.
  if (reach.kind !== 'none') {
    const ahead = await newerPinOnGitHub(sys, slug, token, reach.branch, version);
    if (ahead !== undefined && 'problem' in ahead) {
      io.err(`onboard: ${ahead.problem}; run it again`);
      return 1;
    }
    if (ahead !== undefined) return refuseOlder(io, slug, ahead, version);
  }
  // The default branch, which the workflow's pushes run on, is GitHub's to say once the agent can push; until then
  // the workflow is worked out again once it can, and the plan says only what it can know without it.
  const planned = reach.kind === 'push' ? reach.branch : undefined;
  // A public repository, or an organisation's base permission, lets the agent read without pushing.
  if (reach.kind === 'none' || reach.kind === 'read') {
    const sees = reach.kind === 'none' ? 'cannot see' : 'can read but not push to';
    let invite = await invitation(sys, slug, token);
    github.push({ label: invite === undefined ? `${agent} write access` : `${agent} accepts its invitation` });
    steps.push({
      label: `${agent} can push`,
      ...(invite === undefined ? { owner: true as const } : {}),
      async run(out, mine) {
        if (invite === undefined) {
          const added = await sys.http(`${API}/repos/${slug}/collaborators/${agent}`, { method: 'PUT', token: mine as string, body: { permission: 'push' } });
          if (added.status !== 201 && added.status !== 204) {
            const why = (added.json as { message?: unknown } | null)?.message;
            out.err(`onboard: GitHub did not add ${agent} (HTTP ${added.status}${typeof why === 'string' ? `: ${why}` : ''})`);
            out.err(`  Add it yourself: ${slug} → Settings → Collaborators → Add people → ${agent}, role Write.`);
            return false;
          }
          out.out(`gave ${agent}, which ${sees} ${slug}, write access, as ${owner}`);
          // An organisation member gets access at once; anyone else gets an invitation.
          reach = await access(sys, slug, token);
          invite = reach.kind === 'push' ? undefined : await invitation(sys, slug, token);
        }
        if (invite !== undefined) {
          const accepted = await sys.http(`${API}/user/repository_invitations/${invite}`, { method: 'PATCH', token });
          if (accepted.status !== 204) {
            out.err(`onboard: GitHub did not accept the invitation (HTTP ${accepted.status})`);
            return false;
          }
          out.out(`accepted ${agent}'s invitation to ${slug}, as ${agent}`);
          reach = await access(sys, slug, token);
        }
        if (reach.kind === 'push') return true;
        const why = {
          none: `${agent} still cannot see ${slug}; check the invitation reached ${agent}`,
          read: `${agent} can read ${slug} but still not push; check the invitation reached ${agent}, or give it the Write role`,
          refused: reach.kind === 'refused' ? reach.reason : '',
        };
        out.err(`onboard: ${why[reach.kind]}`);
        return false;
      },
    });
  }

  // The shared checks run only for features that need them.
  const workflowFrom = workflowPins(fileAt(WORKFLOW_PATH) ?? '')[0];
  const workflowFor = (branch: string): void => {
    const update = workflowUpdate(fileAt(WORKFLOW_PATH), branch, version, on('figma'), schedule);
    if (update.kind !== 'same') change(WORKFLOW_PATH, update.text, workflowWhat(update, version, on('figma'), SETTINGS_PATH));
  };
  if (workflowNeeded) {
    const update = planned === undefined ? undefined : workflowUpdate(fileAt(WORKFLOW_PATH), planned, version, on('figma'), schedule);
    if (update === undefined) pull.push({ label: 'workflow', detail: fileAt(WORKFLOW_PATH) === undefined ? 'new' : 'write or update' });
    else if (update.kind !== 'same') pull.push({ label: 'workflow', detail: workflowDetail(update, version, on('figma')) });
  }

  if (on('board')) {
    github.push({ label: 'board', detail: 'set up or check' });
    if (await byOrganisation()) github.push({ label: 'issue types', detail: 'org-wide, if missing' });
    const projectTitle = (JSON.parse(fileAt(SETTINGS_PATH) as string) as { project?: unknown }).project;
    steps.push({
      label: 'board',
      owner: true,
      async run(out, mine) {
        // The plan's one yes covers each step of the board but replacing a Project made before the template, which
        // moves its items and closes it: that is left to the owner, with what the template would have set.
        const board = await setUpBoard(sys, out, (_, step) => Promise.resolve(step !== 'replace'), slug, owner, mine as string, typeof projectTitle === 'string' ? projectTitle : undefined);
        byHand.unshift(...(board?.byHand ?? []));
        later.unshift(...(board?.byHand ?? []).map((line) => `On the board: ${line}.`));
        return board !== undefined;
      },
    });
  }

  // Every adopter: the identity guard holds where the Claude Code hooks did not run.
  const hook = prePushHook(sys, root);
  const hookLine = 'process-rules pre-push "$@"';
  if (hook.state === 'missing' || hook.state === 'older') {
    mac.push({ label: 'pre-push hook', detail: hook.state === 'older' ? 'older one replaced' : 'new' });
    steps.push({
      label: 'pre-push hook',
      async run(out) {
        sys.write(hook.file, PRE_PUSH_HOOK, 0o755);
        out.out(`${hook.state === 'older' ? 'replaced the older' : 'wrote the'} pre-push git hook ${hook.path}, which checks an agent session pushes to GitHub as the agent, and the work rules`);
        return true;
      },
    });
  } else if (hook.state === 'outside' || hook.state === 'own') {
    // A hooks folder shared by other repositories (a global core.hooksPath), or the client's own hook, is the owner's to change.
    byHand.push(`add ${hookLine} → ${hook.path}`);
    later.push(`Add the line \`${hookLine}\` to the pre-push git hook ${hook.path}, which ${hook.state === 'own' ? 'is your own' : 'git runs from outside this repository'}.`);
  }

  steps.push({
    label: `test commit Verified as ${agent}`,
    async run(out) {
      return (await testCommit(sys, out, { agent, id, token, slug })) === 0;
    },
  });
  // Claude's routines API answers only a Claude Code session's own sign-in, and a routine works as claude.ai's GitHub
  // connection, so onboard cannot create one or check it.
  if (on('review')) {
    const routine = `${GITHUB_WEB}/${PRODUCT}/blob/v${version}/routines/review.md`;
    byHand.push(`review routine → ${routine}`);
    later.push(
      `The review routine: create a weekly Claude routine on ${slug} (claude.ai/code/routines, or /schedule in Claude Code), with claude.ai's GitHub connected as ${agent}, and give it the prompt below the line in ${routine}. Until it gives its verdicts, the weekly job labels needs-owner each decision over a week past its review date.`,
    );
  }
  // Claude cloud sessions. Claude Code has no API for a cloud environment's Setup script, so the version lives in a
  // file the repo owns, written at the pin on every run, and the Setup script runs it: one paste, the first time.
  const cloudBefore = fileAt(CLOUD_SETUP_PATH);
  const released = await releaseSha256(sys, version, token);
  if ('problem' in released) warnings.push(`${CLOUD_SETUP_PATH} left as it is: ${released.problem}`);
  else {
    const text = cloudRepoScript(version, released.sha256);
    if (text !== cloudBefore) {
      const from = cloudBefore === undefined ? undefined : cloudScriptVersion(cloudBefore);
      pull.push({ label: 'cloud-setup.sh', detail: cloudBefore === undefined ? `new, installs v${version}` : from && from !== version ? `v${from} → v${version}` : 'written again' });
      change(CLOUD_SETUP_PATH, text, `installs niyam ${version} in Claude cloud sessions, its download checked against its sha256`);
    }
    if (cloudBefore === undefined) {
      cloud.push({ label: 'Setup script', detail: 'niyam cloud-setup, first' }, { label: "claude.ai's GitHub", detail: `as ${agent}` });
      byHand.push(`cloud sessions, once: claude.ai's GitHub as ${agent}, Setup script from niyam cloud-setup, first`);
      later.push(
        `Claude cloud sessions, once: connect claude.ai's GitHub as ${agent}, and paste what niyam cloud-setup prints into the cloud environment's Setup script, over any older process-rules part. It runs ${CLOUD_SETUP_PATH}, which onboard keeps at the pin, so a new release needs no new paste. ${SETUP_FIRST}`,
      );
    }
  }
  let pullUrl: string | undefined;
  // Whether the pull request merges itself once its checks pass.
  let merging = false;
  // A Mergify merge queue that takes pull requests by itself merges it, so GitHub's auto-merge is neither turned on
  // nor asked for. Read from the default branch; where the agent cannot push yet, worked out again once it can.
  let queue = planned === undefined ? undefined : await mergeQueue(sys, slug, planned, token);
  steps.push({
    label: 'pull request',
    async run(out) {
      if (reach.kind !== 'push') return false;
      if (workflowNeeded) workflowFor(reach.branch);
      // From the workflow the pull request leaves, worked out only now that GitHub has said the branch.
      const text = fileAt(WORKFLOW_PATH);
      const unpassed = workflowNeeded && on('figma') && text !== undefined ? jobsWithoutLibrary(text) : [];
      if (unpassed.length > 0) {
        byHand.unshift(`pass FIGMA_LIBRARY in ${unpassed.join(', ')} → ${WORKFLOW_PATH}`);
        later.unshift(`In ${WORKFLOW_PATH}, ${unpassed.join(', ')} pass the shared checks no FIGMA_LIBRARY secret, so the design check stays off there; add \`FIGMA_LIBRARY: \${{ secrets.FIGMA_LIBRARY }}\` under their secrets.`);
      }
      // A change that puts a file back as it was is no change.
      const changed = [...changes.values()].filter((one) => one.text !== one.before);
      if (changed.length === 0) return true;
      const described = [
        ...(notes.length > 0 ? ['Done at the terminal, outside this pull request:', '', ...notes, ''] : []),
        ...(later.length > 0 ? ['Left to do by hand:', '', ...later.map((line) => `- ${line}`)] : []),
      ];
      const opened = await openPull(sys, out, { agent, id, token, slug, branch: reach.branch, version }, changed, described);
      if (opened === 1) return false;
      pullUrl = opened.url;
      if (planned === undefined) queue = await mergeQueue(sys, slug, reach.branch, token);
      if (queue !== undefined) {
        merging = true;
        return true;
      }
      // Not turning it on fails nothing: the owner merges it instead.
      // A request that gets no answer is a refusal like any other: the pull request is open either way.
      const refused = await autoMerge(sys, slug, token, opened.id).catch((error: unknown) => ({
        problem: error instanceof Error ? error.message : String(error),
        notAllowed: undefined,
      }));
      merging = refused === undefined;
      if (refused?.notAllowed) byHand.unshift(`auto-merge: turn on Allow auto-merge → ${GITHUB_WEB}/${slug}/settings, or merge it yourself`);
      else if (refused) byHand.unshift(`auto-merge: GitHub refused (${refused.problem}); merge it yourself`);
      return true;
    },
  });

  const signedAs = signedIn && (await signedIn);
  const asOwnerItems = steps.some((step) => step.owner);
  const groups = [
    // It merges itself, through the repository's merge queue, or as the agent turns auto-merge on, unless the repository does not allow it.
    {
      title: 'Pull request',
      items:
        pull.length > 0
          ? [
              ...pull,
              queue !== undefined
                ? { label: 'merge queue', detail: 'Mergify, when checks pass' }
                : // Until the agent can push, whether a merge queue takes it is not known.
                  { label: planned === undefined ? 'auto-merge or merge queue' : 'auto-merge', detail: 'when checks pass' },
            ]
          : [],
    },
    { title: asOwnerItems ? (signedAs && 'login' in signedAs ? `GitHub — signed in as ${signedAs.login}` : `GitHub — one sign-in as ${owner}`) : 'GitHub', items: github },
    { title: 'This Mac', items: mac },
    { title: 'Claude cloud — by hand, once', items: cloud },
    { title: 'Check', items: [{ label: `one signed test commit by ${agent}, deleted after` }] },
  ];
  for (const line of planLines(paint, planHead(paint, { from: workflowNeeded ? workflowFrom : undefined, version, slug, owner, agent, warnings }), groups)) io.out(line);
  if (dryRun) {
    io.out(closing(paint, 'Dry run: nothing changed.'));
    return 0;
  }
  if (yes) io.out(`${paint.done('◇')}  Go ahead? Yes (--yes)`);
  else if (!(await sys.choose('Go ahead?'))) {
    io.out(closing(paint, 'Nothing changed, and no pull request was opened.'));
    return 1;
  }

  for (const step of steps) {
    const mine = step.owner ? await ownerToken() : undefined;
    const { ok, log } = await runStep(sys, io, paint, step.label, !step.owner || mine ? (out) => step.run(out, mine) : undefined);
    if (!ok) {
      io.err(`onboard: stopped at "${step.label}"; nothing after it was changed, and no pull request was opened`);
      return 1;
    }
    if (log.length > 0) notes.push(`- ${step.label}:`, ...log.map((line) => `  - ${line.trim().replace(/^[✓-] /, '')}`));
  }
  io.out(closing(paint, `${!pullUrl ? 'Done; no file changes, so no pull request.' : merging ? `${pullUrl}  ${queue !== undefined ? 'the merge queue merges it' : 'merges itself'} when checks pass` : `Merge ${pullUrl}`}`));
  io.out('');
  io.out('By hand:');
  for (const line of byHand) io.out(`  ${line}`);
  return 0;
}

/** How many times onboard asks GitHub about the test commit, waiting a little longer each time. */
export const COMMIT_ATTEMPTS = 5;

/**
 * GitHub's answer about a commit just pushed. A dropped connection or an
 * error from GitHub is asked again, since a commit can take a moment to
 * show and the network can fail for a moment; the last failure otherwise.
 */
async function commitInfo(sys: Sys, slug: string, sha: string, token: string): Promise<unknown> {
  let failure = new Error('not asked');
  for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
    try {
      const { status, json } = await sys.http(`${API}/repos/${slug}/commits/${sha}`, { token });
      if (status === 200) return json;
      failure = new Error(`HTTP ${status}`);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < COMMIT_ATTEMPTS) await sys.sleep(attempt * 2000);
  }
  return failure;
}

interface Target {
  agent: string;
  id: number;
  token: string;
  slug: string;
}

/** Signs an empty commit on the repo's tip as the agent, pushes it, and asks GitHub whether it is Verified. */
async function testCommit(sys: Sys, io: Output, target: Target): Promise<number> {
  const { agent, id, token, slug } = target;
  const paths = pathsFor(sys.home, agent);
  const dir = sys.exec('mktemp', ['-d']).stdout.trim();
  const env = sessionEnv(sys.env, agent, id, token, paths);
  const git = (...args: string[]) => sys.exec('git', args, { cwd: dir, env });
  const url = `${GITHUB_WEB}/${slug}.git`;
  const branch = `process-rules/verify-${agent.toLowerCase()}-${sys.now().getTime()}`;
  let pushed = false;
  try {
    const head = git('ls-remote', url, 'HEAD');
    if (head.code === 0 && !head.stdout.trim()) {
      // A first push would make the throwaway branch the default one.
      io.err(`onboard: ${slug} has no commits yet; push a first commit to it, then onboard again`);
      return 1;
    }
    for (const args of [
      ['init', '-q'],
      ['fetch', '-q', '--depth=1', '--filter=blob:none', url, 'HEAD'],
    ]) {
      const step = git(...args);
      if (step.code !== 0) {
        io.err(`onboard: git ${args[0]} failed: ${step.stderr.trim()}`);
        return 1;
      }
    }
    const made = git('commit-tree', '-S', 'FETCH_HEAD^{tree}', '-p', 'FETCH_HEAD', '-m', `niyam: signing check for ${agent}`);
    const sha = made.stdout.trim();
    if (made.code !== 0 || !sha) {
      io.err(`onboard: signing the test commit failed: ${made.stderr.trim()}`);
      return 1;
    }
    const push = git('push', '-q', url, `${sha}:refs/heads/${branch}`);
    if (push.code !== 0) {
      io.err(`onboard: pushing as ${agent} failed: ${push.stderr.trim()}`);
      return 1;
    }
    pushed = true;
    io.out(`Test commit ${GITHUB_WEB}/${slug}/commit/${sha}`);
    const asked = await commitInfo(sys, slug, sha, token);
    if (asked instanceof Error) {
      io.err(`onboard: cannot ask GitHub whether the test commit is Verified (${asked.message}); open the link above to see`);
      return 1;
    }
    const commit = asked as {
      committer?: { login?: string } | null;
      commit?: { verification?: { verified?: boolean; reason?: string } };
    } | null;
    const verification = commit?.commit?.verification;
    const committer = commit?.committer?.login;
    io.out(`  committer: ${committer ?? 'none'}; verified: ${String(verification?.verified)} (${verification?.reason ?? 'no reason'})`);
    if (verification?.verified !== true || !sameLogin(committer, agent)) {
      io.err(`onboard: GitHub does not show the commit Verified by ${agent}`);
      return 1;
    }
    io.out(`✓ GitHub shows the test commit Verified by ${agent}`);
    return 0;
  } finally {
    // Runs on every path after the push, the API failing included; says so when the branch stays.
    if (pushed) {
      const removed = git('push', '-q', url, `:refs/heads/${branch}`);
      if (removed.code === 0) io.out(`Deleted the throwaway branch ${branch}.`);
      else io.err(`onboard: could not delete ${branch}; delete it on GitHub: ${removed.stderr.trim()}`);
    }
    sys.exec('rm', ['-rf', dir]);
  }
}
