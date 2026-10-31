import {
  API,
  BASE_ENV,
  SETTINGS_PATH,
  account,
  checkToken,
  isLogin,
  keyPairProblem,
  loadSettings,
  pathsFor,
  readToken,
  repoAt,
  sameLogin,
  sessionEnv,
  sessionNames,
  tokenInfo,
} from './agent.ts';
import { setUpBoard } from './board.ts';
import { ownerRules, ownerRulesProblem } from './codeowners.ts';
import { appendToArray, replaceValues, setMember } from './jsonedit.ts';
import { type Feature, FEATURES, FIGMA_FILE_KEY, featuresIn, parseFeatures, renamedLines } from './features.ts';
import { packageVersion } from './version.ts';
import type { Output, Sys } from './types.ts';

/** This product's repository: clients call its shared workflow. */
export const PRODUCT = 'athya-hq/process-rules';
export const HOOKS_PATH = '.claude/settings.json';
export const WORKFLOW_PATH = '.github/workflows/process-rules.yml';
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
  return { path, file, state: /^\s*(?:exec\s+)?(?:"\$cli"|process-rules)\s+pre-push\b/m.test(text) ? 'ours' : 'own' };
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

/** The workflow's head, down to its jobs, which every template shares. */
function workflowHead(branch: string, version: string, comments: string[]): string[] {
  return [
    `# Written by process-rules onboard: the shared process-rules checks at v${version}.`,
    ...comments,
    'name: process-rules',
    '',
    'on:',
    '  pull_request:',
    '    # edited: a changed "Slice: #N" line is checked again.',
    '    types: [opened, synchronize, reopened, edited]',
    '  push:',
    `    branches: [${JSON.stringify(branch)}]`,
    '  # The weekly decisions job: Mondays, 06:17 UTC.',
    '  schedule:',
    "    - cron: '17 6 * * 1'",
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
 * to the default branch and weekly, at the process-rules release `version`.
 * Pull request and push runs are read-only; the weekly job alone writes to
 * issues. Upgrading is changing that version, which each job names twice.
 * The Figma secrets are passed only when the figma feature is on.
 */
export function workflow(branch: string, version: string, figma: boolean): string {
  const secrets = figma ? FIGMA_SECRETS : [];
  return [
    ...workflowHead(branch, version, [
      '# To upgrade, change the version on every line that names it (two per job).',
      '# The weekly job is split out so pull request and push runs stay read-only.',
    ]),
    '  # Pull request and push runs: read-only.',
    '  process-rules:',
    "    if: github.event_name == 'pull_request' || github.event_name == 'push'",
    ...callChecks(version, secrets),
    '',
    '  # The weekly run alone writes to issues: it comments and opens undo issues.',
    '  process-rules-weekly:',
    "    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: read',
    ...callChecks(version, secrets),
    '',
  ].join('\n');
}

/**
 * The workflows older releases wrote, at `version`, which onboard replaces
 * with this release's: one job that wrote to issues on every run.
 */
export function olderWorkflows(branch: string, version: string): string[] {
  return [
    [
      ...workflowHead(branch, version, ['# To upgrade, change the version on both lines that name it.']),
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

const CHECKS_PIN = new RegExp(`(${PRODUCT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.github/workflows/checks\\.yml@v)([^\\s'"#]+)`, 'g');
const REF_PIN = /^(\s+process-rules-ref:\s*['"]?v)([^\s'"#]+)/gm;
const HEADER_PIN = /^(# Written by process-rules onboard: the shared process-rules checks at v)(\S+?)(\.?)$/m;

/** The versions a workflow pins: each `checks.yml@v…`, then each `process-rules-ref: v…`. */
export function workflowPins(text: string): string[] {
  return [...text.matchAll(CHECKS_PIN), ...text.matchAll(REF_PIN)].map((match) => match[2] as string);
}

/** The one branch a workflow's `push:` trigger names, as `onboard` writes it, quoted or not. */
const PUSH_BRANCH = /^( {2}push:\n {4}branches: \[\s*)(['"]?)([^,'"\]\s]+)\2(\s*\])$/m;

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
 * the one branch pushes run on when the default branch has changed, and each
 * job's Figma secrets to what the figma feature needs, leaving the rest as
 * the client has it.
 */
export function workflowUpdate(
  before: string | undefined,
  branch: string,
  version: string,
  figma: boolean,
):
  | { kind: 'same' }
  | { kind: 'write' | 'replace-older' | 'replace'; text: string; from?: string }
  | { kind: 'repin'; text: string; from?: string; branch?: string; secrets?: true } {
  const wanted = workflow(branch, version, figma);
  if (before === undefined) return { kind: 'write', text: wanted };
  if (before === wanted) return { kind: 'same' };
  const pins = workflowPins(before);
  const from = pins[0];
  const pushed = PUSH_BRANCH.exec(before)?.[3];
  if (from !== undefined && pushed !== undefined && olderWorkflows(pushed, from).includes(before)) {
    return { kind: 'replace-older', text: wanted, from };
  }
  const split = /^ {2}process-rules:\s*$/m.test(before) && /^ {2}process-rules-weekly:\s*$/m.test(before);
  if (split && pins.length === 4) {
    const moved = pushed !== undefined && pushed !== branch;
    const pinned = before
      .replace(CHECKS_PIN, (_, head: string) => `${head}${version}`)
      .replace(REF_PIN, (_, head: string) => `${head}${version}`)
      .replace(HEADER_PIN, (_, head: string, _old: string, dot: string) => `${head}${version}${dot}`)
      .replace(PUSH_BRANCH, (line: string, head: string, quote: string, _old: string, tail: string) =>
        moved ? `${head}${flowScalar(branch, quote)}${tail}` : line,
      );
    const secrets = figma ? `${FIGMA_SECRETS.join('\n')}\n` : '';
    const text = pinned.replace(SECRETS_AFTER_REF, (_, ref: string) => `${ref}${secrets}`);
    if (text === before) return { kind: 'same' };
    const stale = pins.find((pin) => pin !== version);
    return { kind: 'repin', text, ...(stale ? { from: stale } : {}), ...(moved ? { branch } : {}), ...(text !== pinned ? { secrets: true as const } : {}) };
  }
  return { kind: 'replace', text: wanted };
}

/** What GitHub says about the agent's access to a repository. */
type Access =
  | { kind: 'push'; branch: string }
  | { kind: 'read' }
  | { kind: 'none' }
  | { kind: 'refused'; reason: string };

async function access(sys: Sys, slug: string, token: string): Promise<Access> {
  const { status, json, headers = {} } = await sys.http(`${API}/repos/${slug}`, { token });
  const repo = json as { default_branch?: unknown; permissions?: { push?: unknown }; message?: unknown } | null;
  if (status === 200) {
    return repo?.permissions?.push === true && typeof repo.default_branch === 'string'
      ? { kind: 'push', branch: repo.default_branch }
      : { kind: 'read' };
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
export function claudeSettings(before: string | undefined): { text: string; changes: string[] } {
  let text = before ?? '{}\n';
  const changes: string[] = [];
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
      } else if (!hooksOf(parsed(), event).some((hook) => hook.command === command)) {
        text = appendToArray(text, ['hooks'], event, { ...extra, hooks: [{ type: 'command', command }] });
        changes.push(`add ${name}`);
      }
    }
    const env = (parsed() as { env?: unknown }).env;
    const current = typeof env === 'object' && env !== null ? (env as Record<string, unknown>) : {};
    const missing = Object.entries(BASE_ENV).filter(([name, value]) => current[name] !== value);
    for (const [name, value] of missing) text = setMember(text, ['env'], name, value);
    const names = missing.map(([name]) => name);
    const named = names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
    if (missing.length > 0) changes.push(`set ${named} in env, so GitHub is locked out until session-start gives the agent identity`);
    const allow = (parsed() as { permissions?: { allow?: unknown } }).permissions?.allow;
    if (!Array.isArray(allow) || !allow.includes(REVIEW_THREAD_RULE)) {
      text = appendToArray(text, ['permissions'], 'allow', REVIEW_THREAD_RULE);
      changes.push('allow process-rules review-thread without a prompt, so agent sessions answer review threads on their own pull requests');
    }
  } catch (error) {
    throw new Error(`${HOOKS_PATH}: ${(error as Error).message}`);
  }
  return { text, changes };
}

/** The account the owner's `gh` is signed in as, the owner's likely login. */
async function ghLogin(sys: Sys): Promise<string | undefined> {
  const token = sys.exec('gh', ['auth', 'token', '-h', 'github.com'], { env: { ...sys.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined } });
  if (token.code !== 0 || !token.stdout.trim()) return undefined;
  const { status, json } = await sys.http(`${API}/user`, { token: token.stdout.trim() }).catch(() => ({ status: 0, json: null }));
  const login = (json as { login?: unknown } | null)?.login;
  return status === 200 && typeof login === 'string' ? login : undefined;
}

/** The agent accounts `machine` has set up on this Mac, as their session files spell them. */
function agentsSetUp(sys: Sys): string[] {
  const dir = `${sys.home}/.config/process-rules`;
  return sys.list(dir).flatMap((name) => {
    const session = `${dir}/${name}/session.sh`;
    const agent = sys.exists(session) ? sessionNames(sys.read(session))?.agent : undefined;
    return agent ? [agent] : [];
  });
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

/**
 * Sets up the client repository the working directory is in, run by its
 * owner on a Mac `machine` has set up for the agent: the settings file, the
 * SessionStart hook entry and the workflow, which the owner then commits;
 * the agent's push access, offering to invite it and accept the invitation;
 * the work board (issue types, labels, Project, fields and views); and one signed
 * test commit GitHub must show as Verified by the agent.
 * Every change waits for a yes.
 */
/** onboard's arguments: up to two logins, then `--features a,b` (first time) or `--add <feature>`. */
export function onboardArgs(args: readonly string[]): { named: string[]; features?: Feature[]; add?: Feature } {
  const named: string[] = [];
  let features: Feature[] | undefined;
  let add: Feature | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const value = args[i + 1];
    if (arg === '--features' || arg === '--add') {
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
  return { named, ...(features ? { features } : {}), ...(add ? { add } : {}) };
}

export async function onboard(sys: Sys, io: Output, args: readonly string[] = []): Promise<number> {
  const { named, features: chosen, add } = onboardArgs(args);
  if (sys.env.PROCESS_RULES_AGENT) {
    io.err('onboard: run it in your own terminal, not in an agent session');
    return 1;
  }
  const { root, slug } = repoAt(sys);
  const confirm = async (question: string): Promise<boolean> =>
    /^y(es)?$/i.test((await sys.ask(`${question} [y/N] `)).trim());
  const stop = (step: string): number => {
    io.err(`onboard: stopped at "${step}"; nothing after it was changed`);
    return 1;
  };

  const settingsFile = `${root}/${SETTINGS_PATH}`;
  let owner: string;
  let agent: string;
  let features: Feature[];
  let pendingSettings: string | undefined;
  if (sys.exists(settingsFile)) {
    const settings = loadSettings(sys, root);
    if (chosen) {
      io.err(`onboard: ${SETTINGS_PATH} already lists its features; turn one more on with --add <feature>`);
      return 1;
    }
    const [namedOwner, namedAgent] = named;
    if ((namedOwner && !sameLogin(namedOwner, settings.owner)) || (namedAgent && !sameLogin(namedAgent, settings.agent))) {
      io.err(`onboard: ${SETTINGS_PATH} already names owner ${settings.owner} and agent ${settings.agent}; edit or delete it to change them`);
      return 1;
    }
    // GitHub's spelling, which the keychain, the session file and commits use.
    owner = (await account(sys, settings.owner)).login;
    agent = (await account(sys, settings.agent)).login;
    let raw = JSON.parse(sys.read(settingsFile)) as Record<string, unknown>;
    features = featuresIn(raw);
    // Settings an older release wrote: a feature by its older name, or the Figma library key, which belongs in a secret.
    const renamed = renamedLines(raw).length > 0;
    if (renamed || raw.figma !== undefined) {
      const library = (raw.figma as { library?: unknown } | null)?.library;
      const changes = [
        ...(renamed ? ['rename the design feature to figma'] : []),
        ...(raw.figma !== undefined ? ['take out "figma", since the library key belongs in the FIGMA_LIBRARY Actions secret'] : []),
      ];
      if (!(await confirm(`Update ${SETTINGS_PATH}: ${changes.join(' and ')}?`))) return stop('settings file');
      const { figma: _figma, ...rest } = raw;
      raw = { ...rest, ...(rest.features === undefined ? {} : { features }) };
      sys.write(settingsFile, `${JSON.stringify(raw, null, 2)}\n`);
      // Printed as a command only when it is a file key, so copying it runs nothing else.
      if (typeof library === 'string' && FIGMA_FILE_KEY.test(library)) {
        io.out(`! set the FIGMA_LIBRARY Actions secret to the key taken out: gh secret set FIGMA_LIBRARY --repo ${slug} --body ${library}`);
      } else if (library !== undefined) {
        io.out('! the "figma.library" taken out was not a Figma file key; set the FIGMA_LIBRARY Actions secret to the design library\'s file key');
      }
    }
    if (add && !features.includes(add)) {
      if (!(await confirm(`Turn ${add} on in ${SETTINGS_PATH}, once its setup below is done?`))) return stop('settings file');
      features = FEATURES.filter((feature) => features.includes(feature) || feature === add);
      // Written only once the feature's setup has finished, so settings never claim a half-set-up feature.
      pendingSettings = `${JSON.stringify({ ...raw, features }, null, 2)}\n`;
    }
  } else {
    if (add) {
      io.err(`onboard: there is no ${SETTINGS_PATH} to add to; run process-rules onboard <owner> <agent> first`);
      return 1;
    }
    features = chosen ?? [...FEATURES];
    const namedOwner = named[0] ?? (await choose(sys, io, 'owner, who approves', [await ghLogin(sys)]));
    const namedAgent = named[1] ?? (await choose(sys, io, 'agent, which builds', agentsSetUp(sys)));
    if (!namedOwner || !namedAgent) {
      io.err('onboard: name the owner and the agent account: process-rules onboard <owner> <agent>');
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
    if (!(await confirm(`Write ${SETTINGS_PATH}: owner ${owner} approves, agent ${agent} builds, with ${features.join(', ')} on?`))) {
      return stop('settings file');
    }
    sys.mkdir(`${root}/.github`);
    sys.write(settingsFile, `${JSON.stringify({ owner, agent, features }, null, 2)}\n`);
  }
  io.out(`✓ ${SETTINGS_PATH}: owner ${owner}, agent ${agent}; on: ${features.join(', ')}`);
  const on = (feature: Feature): boolean => features.includes(feature);
  const workflowNeeded = on('pr-identity') || on('work-rules') || on('figma') || on('decisions') || on('review');

  const hooksFile = `${root}/${HOOKS_PATH}`;
  const existing = sys.exists(hooksFile) ? sys.read(hooksFile) : undefined;
  // Worked out before asking, so a file onboard cannot edit is refused before any question.
  const claude = claudeSettings(existing);
  if (claude.changes.length > 0) {
    if (!(await confirm(`${existing === undefined ? 'Write' : 'Update'} ${HOOKS_PATH}: ${claude.changes.join('; ')}?`))) {
      return stop('hook entry');
    }
    sys.mkdir(`${root}/.claude`);
    sys.write(hooksFile, claude.text);
  }
  io.out(`✓ ${HOOKS_PATH}: GitHub locked out until session-start gives the agent identity, and the guard on gh and git`);

  const paths = pathsFor(sys.home, agent);
  const token = readToken(sys, agent);
  const ready = token && checkToken(token, await tokenInfo(sys, token), agent, sys.now());
  const keyProblem = keyPairProblem(sys, paths.key);
  if (!token || !ready || ready.problem !== undefined || keyProblem) {
    io.err(`onboard: this Mac is not set up for ${agent}; run process-rules machine ${agent}, then onboard again`);
    return 1;
  }

  let reach = await access(sys, slug, token);
  // A public repository, or an organisation's base permission, lets the agent read without pushing.
  if (reach.kind === 'none' || reach.kind === 'read') {
    let invite = await invitation(sys, slug, token);
    if (invite === undefined) {
      const sees = reach.kind === 'none' ? 'cannot see' : 'can read but not push to';
      if (!(await confirm(`${agent} ${sees} ${slug}. Give it write access, as you, through gh?`))) {
        return stop('agent access');
      }
      const added = sys.exec('gh', ['api', '-X', 'PUT', `repos/${slug}/collaborators/${agent}`, '-f', 'permission=push']);
      if (added.code !== 0) {
        io.err(`onboard: gh could not add ${agent}: ${added.stderr.trim()}`);
        io.err(`  Add it yourself: ${slug} → Settings → Collaborators → Add people → ${agent}, role Write.`);
        return 1;
      }
      // An organisation member gets access at once; anyone else gets an invitation.
      reach = await access(sys, slug, token);
      invite = reach.kind === 'push' ? undefined : await invitation(sys, slug, token);
    }
    if (invite !== undefined) {
      if (!(await confirm(`Accept ${agent}'s invitation to ${slug}, as ${agent}?`))) return stop('agent access');
      const accepted = await sys.http(`${API}/user/repository_invitations/${invite}`, { method: 'PATCH', token });
      if (accepted.status !== 204) {
        io.err(`onboard: GitHub did not accept the invitation (HTTP ${accepted.status})`);
        return 1;
      }
      reach = await access(sys, slug, token);
    }
  }
  if (reach.kind !== 'push') {
    const why = {
      none: `${agent} still cannot see ${slug}; check the invitation reached ${agent}`,
      read: `${agent} can read ${slug} but still not push; check the invitation reached ${agent}, or give it the Write role`,
    };
    io.err(`onboard: ${reach.kind === 'refused' ? reach.reason : why[reach.kind]}`);
    return 1;
  }
  io.out(`✓ ${agent} can push to ${slug}`);

  // The shared checks run only for features that need them.
  if (workflowNeeded) {
    const workflowFile = `${root}/${WORKFLOW_PATH}`;
    const version = packageVersion();
    const update = workflowUpdate(sys.exists(workflowFile) ? sys.read(workflowFile) : undefined, reach.branch, version, on('figma'));
    if (update.kind !== 'same') {
      const what = {
        write: `Write ${WORKFLOW_PATH}, which runs the shared process-rules checks`,
        'replace-older': `Replace the older ${WORKFLOW_PATH}, which lets every run write to issues, with this release's, which lets the weekly run alone`,
        replace: `Replace ${WORKFLOW_PATH}, which runs the shared process-rules checks`,
        repin: `In ${WORKFLOW_PATH}, ${[
          ...(update.kind === 'repin' && update.from ? [`move the version pins from v${update.from} to v${version}`] : []),
          ...(update.kind === 'repin' && update.branch ? [`run pushes on the default branch, ${update.branch}`] : []),
          ...(update.kind === 'repin' && update.secrets ? [on('figma') ? 'pass the FIGMA_TOKEN and FIGMA_LIBRARY secrets' : 'stop passing Figma secrets, with figma off'] : []),
        ].join(' and ') || `set the version in its header comment to v${version}`}, leaving the rest as it is`,
      }[update.kind];
      if (!(await confirm(`${what}?`))) {
        return stop('workflow');
      }
      sys.mkdir(`${root}/.github/workflows`);
      sys.write(workflowFile, update.text);
    }
    io.out(`✓ ${WORKFLOW_PATH}`);
    const unpassed = on('figma') ? jobsWithoutLibrary(sys.read(workflowFile)) : [];
    if (unpassed.length > 0) {
      io.out(`! In ${WORKFLOW_PATH}, ${unpassed.join(' and ')} pass${unpassed.length === 1 ? 'es' : ''} the shared checks no FIGMA_LIBRARY secret, so the design check stays off there; add FIGMA_LIBRARY: \${{ secrets.FIGMA_LIBRARY }} under ${unpassed.length === 1 ? 'its' : 'their'} secrets`);
    }
  }

  // Every adopter: the identity guard holds where the Claude Code hooks did not run.
  {
    const hook = prePushHook(sys, root);
    const line = 'process-rules pre-push "$@"';
    const what = 'which checks an agent session pushes to GitHub as the agent, and the work rules';
    if (hook.state === 'outside') {
      // A hooks folder shared by other repositories (a global core.hooksPath) is the owner's to change.
      io.out(`! git runs hooks from ${hook.path}, outside this repository; add this line to its pre-push hook: ${line}`);
    } else if (hook.state === 'missing' || hook.state === 'older') {
      const verb = hook.state === 'older' ? 'Replace the older process-rules pre-push git hook' : 'Write the pre-push git hook';
      if (!(await confirm(`${verb} ${hook.path}, ${what}?`))) {
        return stop('pre-push hook');
      }
      sys.write(hook.file, PRE_PUSH_HOOK, 0o755);
      io.out(`✓ pre-push hook ${hook.path}`);
    } else if (hook.state === 'ours') {
      io.out(`✓ pre-push hook ${hook.path}`);
    } else {
      io.out(`! ${hook.path} is your own; add this line to it: ${line}`);
    }
  }

  const projectTitle = (JSON.parse(sys.read(settingsFile)) as { project?: unknown }).project;
  if (on('board') && !(await setUpBoard(sys, io, confirm, slug, owner, typeof projectTitle === 'string' ? projectTitle : undefined))) return 1;
  if (pendingSettings) {
    sys.write(settingsFile, pendingSettings);
    io.out(`✓ ${add} on in ${SETTINGS_PATH}`);
  }

  if (!(await confirm(`Push one signed test commit to a throwaway branch of ${slug} as ${agent}, check it is Verified, then delete the branch?`))) {
    return stop('test commit');
  }
  const { id } = await account(sys, agent);
  const verified = await testCommit(sys, io, { agent, id, token, slug });
  if (verified !== 0) return verified;
  // Optional, and last, so a run stopped earlier and run again still lists the file to commit.
  const rules = ownerRules(sys, root, owner);
  let codeowners: string | undefined;
  if (rules) {
    io.out(`! ${ownerRulesProblem(rules, owner, agent)}`);
    const drop = rules.dropped > 0 ? `, and drop ${rules.dropped === 1 ? 'the rule' : `the ${rules.dropped} rules`} left with no owners, so ${rules.dropped === 1 ? 'its' : 'their'} paths fall to the rules before` : '';
    if (await confirm(`Remove ${owner} from ${rules.lines.length === 1 ? 'that rule' : 'those rules'} in ${rules.path}${drop}?`)) {
      sys.write(`${root}/${rules.path}`, rules.text);
      codeowners = rules.path;
      io.out(`✓ ${rules.path}: ${owner} removed`);
    } else {
      io.out(`! ${rules.path} left as it is`);
    }
  }
  const files = [SETTINGS_PATH, HOOKS_PATH, ...(workflowNeeded ? [WORKFLOW_PATH] : []), ...(codeowners ? [codeowners] : [])];
  io.out(`onboard: done. Commit ${files.slice(0, -1).join(', ')} and ${files.at(-1)}; agent sessions then work as ${agent}.`);
  io.out(`For Claude cloud sessions: connect claude.ai's GitHub as ${agent}, and put what process-rules cloud-setup prints in the cloud environment's Setup script.`);
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
  const url = `https://github.com/${slug}.git`;
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
    const made = git('commit-tree', '-S', 'FETCH_HEAD^{tree}', '-p', 'FETCH_HEAD', '-m', `process-rules: signing check for ${agent}`);
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
    io.out(`Test commit https://github.com/${slug}/commit/${sha}`);
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
