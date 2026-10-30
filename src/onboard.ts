import {
  API,
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
  tokenInfo,
} from './agent.ts';
import { setUpBoard } from './board.ts';
import { type Feature, FEATURES, featuresIn, parseFeatures } from './features.ts';
import { packageVersion } from './version.ts';
import type { Output, Sys } from './types.ts';

/** This product's repository: clients call its shared workflow. */
export const PRODUCT = 'athya-hq/process-rules';
export const HOOKS_PATH = '.claude/settings.json';
export const WORKFLOW_PATH = '.github/workflows/process-rules.yml';
/** The pre-push git hook: the work rules before an agent session pushes. */
export const PRE_PUSH_HOOK = [
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
].join('\n');
/**
 * What the client's SessionStart hook runs. Cloud sessions are left alone,
 * before anything else: they reach GitHub as the account connected to them
 * and have no CLI. Without the CLI on a machine, or when it fails to run,
 * nothing can lock GitHub, so the session is told to stop instead.
 */
export const HOOK_COMMAND =
  'if [ "$CLAUDE_CODE_REMOTE" = true ]; then :; ' +
  'elif command -v process-rules >/dev/null 2>&1 && process-rules session-start; then :; ' +
  'else echo "process-rules: STOP. The process-rules CLI is missing or did not run here, so this session cannot be given the agent identity and gh and git would act as the owner. Do not push, fetch, or run gh in this session; tell the owner."; fi';

/** The hook commands older releases wrote, which onboard replaces with this release's. */
export const OLDER_HOOK_COMMANDS = [
  'command -v process-rules >/dev/null 2>&1 && process-rules session-start || ' +
    'echo "process-rules: STOP. The process-rules CLI is not installed here, so this session cannot be given the agent identity and gh and git would act as the owner. Do not push, fetch, or run gh in this session; tell the owner."',
];

/**
 * The client's workflow: the shared checks on every pull request, on pushes
 * to the default branch and weekly, at the process-rules release `version`.
 * Upgrading is changing that version, which appears twice, two lines apart.
 */
export function workflow(branch: string, version: string): string {
  return [
    `# Written by process-rules onboard: the shared process-rules checks at v${version}.`,
    '# To upgrade, change the version on both lines that name it.',
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
    '  process-rules:',
    '    # Write to issues for this job only: the weekly run comments and opens undo issues.',
    '    permissions:',
    '      contents: read',
    '      issues: write',
    '      pull-requests: read',
    `    uses: ${PRODUCT}/.github/workflows/checks.yml@v${version}`,
    '    with:',
    `      process-rules-ref: v${version}`,
    '    secrets:',
    '      FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}',
    '',
  ].join('\n');
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

/** Whether the SessionStart hooks in a Claude Code settings object run exactly `HOOK_COMMAND`. */
function hasHook(settings: object): boolean {
  return sessionStartHooks(settings).some((hook) => hook.command === HOOK_COMMAND);
}

/** The command entries under SessionStart, as written in the settings object (so they can be changed in place). */
function sessionStartHooks(settings: object): { command?: unknown }[] {
  const groups = (settings as { hooks?: { SessionStart?: unknown } }).hooks?.SessionStart;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    const hooks = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) ? hooks.filter((hook): hook is { command?: unknown } => typeof hook === 'object' && hook !== null) : [];
  });
}

/**
 * Sets up the client repository the working directory is in, run by its
 * owner on a Mac `machine` has set up for the agent: the settings file, the
 * SessionStart hook entry and the workflow, which the owner then commits;
 * the agent's push access, offering to invite it and accept the invitation;
 * the work board (issue types, labels, Project and fields); and one signed
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
    const raw = JSON.parse(sys.read(settingsFile)) as Record<string, unknown>;
    features = featuresIn(raw);
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
    const [namedOwner, namedAgent] = named;
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
  const workflowNeeded = on('pr-identity') || on('work-rules') || on('design') || on('decisions') || on('review');

  const hooksFile = `${root}/${HOOKS_PATH}`;
  const hooks: unknown = sys.exists(hooksFile) ? JSON.parse(sys.read(hooksFile)) : {};
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    throw new Error(`${HOOKS_PATH} is not a JSON object`);
  }
  // An entry an older release wrote is replaced where it stands, not added to.
  const older = sessionStartHooks(hooks).filter((hook) => typeof hook.command === 'string' && OLDER_HOOK_COMMANDS.includes(hook.command));
  if (older.length > 0) {
    if (!(await confirm(`Replace the older process-rules SessionStart hook in ${HOOKS_PATH} with this release's?`))) {
      return stop('hook entry');
    }
    for (const hook of older) hook.command = HOOK_COMMAND;
    sys.write(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
  } else if (!hasHook(hooks)) {
    if (!(await confirm(`Add the SessionStart hook that runs process-rules session-start to ${HOOKS_PATH}?`))) {
      return stop('hook entry');
    }
    const settings = hooks as { hooks?: Record<string, unknown[]> };
    settings.hooks ??= {};
    settings.hooks.SessionStart = [
      ...(settings.hooks.SessionStart ?? []),
      { hooks: [{ type: 'command', command: HOOK_COMMAND }] },
    ];
    sys.mkdir(`${root}/.claude`);
    sys.write(hooksFile, `${JSON.stringify(settings, null, 2)}\n`);
  }
  io.out(`✓ ${HOOKS_PATH}: SessionStart runs process-rules session-start`);

  const paths = pathsFor(sys.home, agent);
  const token = readToken(sys, agent);
  const ready = token && checkToken(token, await tokenInfo(sys, token), agent, sys.now());
  const keyProblem = keyPairProblem(sys, paths.key);
  if (!token || !ready || ready.problem !== undefined || keyProblem) {
    io.err(`onboard: this Mac is not set up for ${agent}; run process-rules machine ${agent}, then onboard again`);
    return 1;
  }

  let reach = await access(sys, slug, token);
  if (reach.kind === 'none') {
    let invite = await invitation(sys, slug, token);
    if (invite === undefined) {
      if (!(await confirm(`${agent} cannot see ${slug}. Give it write access, as you, through gh?`))) {
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
      invite = reach.kind === 'none' ? await invitation(sys, slug, token) : undefined;
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
      read: `${agent} can read ${slug} but not push; give it the Write role`,
    };
    io.err(`onboard: ${reach.kind === 'refused' ? reach.reason : why[reach.kind]}`);
    return 1;
  }
  io.out(`✓ ${agent} can push to ${slug}`);

  // The shared checks run only for features that need them.
  if (workflowNeeded) {
    const workflowFile = `${root}/${WORKFLOW_PATH}`;
    const wanted = workflow(reach.branch, packageVersion());
    if (!sys.exists(workflowFile) || sys.read(workflowFile) !== wanted) {
      const verb = sys.exists(workflowFile) ? 'Replace' : 'Write';
      if (!(await confirm(`${verb} ${WORKFLOW_PATH}, which runs the shared process-rules checks?`))) {
        return stop('workflow');
      }
      sys.mkdir(`${root}/.github/workflows`);
      sys.write(workflowFile, wanted);
    }
    io.out(`✓ ${WORKFLOW_PATH}`);
  }

  if (on('work-rules')) {
    const hookPath = sys.exec('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: root }).stdout.trim();
    const hookFile = hookPath.startsWith('/') ? hookPath : `${root}/${hookPath}`;
    const gitDir = sys.exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }).stdout.trim();
    const line = 'process-rules pre-push "$@"';
    if (!hookFile.startsWith(`${root}/`) && !hookFile.startsWith(`${gitDir}/`)) {
      // A hooks folder shared by other repositories (a global core.hooksPath) is the owner's to change.
      io.out(`! git runs hooks from ${hookPath}, outside this repository; add this line to its pre-push hook: ${line}`);
    } else if (!sys.exists(hookFile)) {
      if (!(await confirm(`Write the pre-push git hook ${hookPath}, which runs the work rules before an agent session pushes?`))) {
        return stop('pre-push hook');
      }
      sys.write(hookFile, PRE_PUSH_HOOK, 0o755);
      io.out(`✓ pre-push hook ${hookPath}`);
    } else if (/^\s*(?:exec\s+)?process-rules\s+pre-push\b/m.test(sys.read(hookFile))) {
      io.out(`✓ pre-push hook ${hookPath}`);
    } else {
      io.out(`! ${hookPath} is your own; add this line to it: ${line}`);
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
  const files = [SETTINGS_PATH, HOOKS_PATH, ...(workflowNeeded ? [WORKFLOW_PATH] : [])];
  io.out(`onboard: done. Commit ${files.slice(0, -1).join(', ')} and ${files.at(-1)}; agent sessions then work as ${agent}.`);
  return 0;
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
    const { json } = await sys.http(`${API}/repos/${slug}/commits/${sha}`, { token });
    const commit = json as {
      committer?: { login?: string } | null;
      commit?: { verification?: { verified?: boolean; reason?: string } };
    } | null;
    const verification = commit?.commit?.verification;
    const committer = commit?.committer?.login;
    io.out(`Test commit https://github.com/${slug}/commit/${sha}`);
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
