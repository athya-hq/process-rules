import { SETTINGS_PATH, repoAt } from './agent.ts';
import { relative, resolve } from 'node:path';

import { type BriefIssue, type BriefReason, type LintContext, type Yaml, addToProject, deletedSince, judgeBrief, lintDraft, loadYaml, openBrief, readBrief, repoPath } from './brief.ts';
import type { Output, Sys } from './types.ts';
import { sessionToken } from './work.ts';

/**
 * The hand-off gate. A session working on A trips over B, which is not A's fault; spun out to a session with no
 * stake, B gets a better fix, since the session on A wants A unblocked and bends every judgement to that. No program
 * can see a realisation, so this does not try. It sees two of its footprints: the branch edits the client's shared
 * plumbing (fixing B here), or one push stage keeps failing while the tree keeps changing (B blocking A). Either
 * one, and the push needs a declaration: own work (one sentence, the cheap answer), handed off (a Brief issue that
 * lints), carrying (that brief, what was verified, and why it was not handed off: the dearest), or dismissed (the
 * owner's decision, cited). It reprices; it does not judge.
 */

/** What `.github/niyam.json`'s `"handoff"` names; none named turns the gate off. */
export interface HandoffSettings {
  /** Shared plumbing: a folder ends in `/` and holds everything under it; anything else is one file, by its whole path. */
  plumbing: string[];
  /** The push history that shows a stage failing again and again, when the client keeps one. */
  history?: string;
  /** Stages of that history never counted, such as the gate's own. */
  ignoreStages: string[];
  /** Where the brief template is, for messages. */
  template?: string;
  /** The ref a push is compared with. */
  base: string;
}

/** Repository-relative path of the declarations, JSON lines, appended to. */
export const RUN_LOG = '.tmp/push/handoff-log.jsonl';
export const MIN_FAILURES = 3;
export const MIN_TREES = 2;

const where = `${SETTINGS_PATH}: "handoff"`;

/** The `"handoff"` settings, or undefined when the repository names none. Throws on a malformed entry. */
export function handoffSettings(raw: unknown): HandoffSettings | undefined {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).handoff : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const { plumbing, history, ignoreStages = [], template, base = 'origin/main', ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new Error(`${where} has an unknown key "${extra}"; it takes "plumbing", "history", "ignoreStages", "template" and "base"`);
  const paths = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === 'string' && repoPath(p) !== null);
  if (!paths(plumbing) || plumbing.length === 0) throw new Error(`${where}.plumbing must be a non-empty list of paths in the repository, a folder ending in "/"`);
  for (const [key, one] of [['history', history], ['template', template]] as const) {
    if (one !== undefined && (typeof one !== 'string' || repoPath(one) === null)) throw new Error(`${where}.${key} must be a path in the repository`);
  }
  if (!Array.isArray(ignoreStages) || !ignoreStages.every((stage) => typeof stage === 'string')) throw new Error(`${where}.ignoreStages must be a list of stage names`);
  if (typeof base !== 'string' || !base || base.startsWith('-')) throw new Error(`${where}.base must be a ref, such as "origin/main"`);
  return {
    plumbing,
    ignoreStages: ignoreStages as string[],
    base,
    ...(typeof history === 'string' ? { history } : {}),
    ...(typeof template === 'string' ? { template } : {}),
  };
}

/** Whether `file` is shared plumbing: under a folder entry, on a segment boundary, or one file entry by its whole path. */
export function isPlumbing(file: string, plumbing: readonly string[]): boolean {
  const path = file.replace(/^\.\//, '');
  return plumbing.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

/** One run of the client's push history, as much of it as the gate reads. */
export interface HookRun {
  kind: string;
  exitCode: number;
  branch?: string | null;
  fingerprint?: string | null;
  stages: { name: string; status: string }[];
}

/**
 * The runs of the push history: every field its writer always writes, with the right type, or the line is not a
 * run. A corrupt line is counted, never evidence, and never stops a push.
 */
export function parseHistory(text: string): { runs: HookRun[]; malformed: number } {
  const runs: HookRun[] = [];
  let malformed = 0;
  const nullableText = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let run: Record<string, unknown> | null = null;
    try {
      run = JSON.parse(line) as Record<string, unknown> | null;
    } catch {
      // Counted below.
    }
    const stage = (s: unknown): boolean => {
      const one = s as Record<string, unknown> | null;
      return typeof one?.name === 'string' && typeof one.startMs === 'number' && typeof one.durationMs === 'number' && typeof one.status === 'string';
    };
    const ok =
      typeof run === 'object' &&
      run !== null &&
      typeof run.schema === 'number' &&
      typeof run.id === 'string' &&
      typeof run.invocation === 'string' &&
      typeof run.startedAt === 'string' &&
      typeof run.durationMs === 'number' &&
      typeof run.kind === 'string' &&
      typeof run.exitCode === 'number' &&
      Array.isArray(run.stages) &&
      run.stages.every(stage) &&
      nullableText(run.branch) &&
      nullableText(run.fingerprint);
    if (ok) runs.push(run as unknown as HookRun);
    else malformed++;
  }
  return { runs, malformed };
}

export interface Repeated {
  fired: boolean;
  stage: string | null;
  failures: number;
  trees: number;
}

/**
 * Fires when one stage was the one a push died at (failed, or timed out) three times on this branch, across two
 * working trees or more: the code kept changing and the same thing kept failing. Runs of other branches, and of
 * no branch, are not this push's. A run with no fingerprint counts as a failure but not as another tree.
 */
export function repeatedFailure(runs: readonly HookRun[], branch: string, ignore: readonly string[]): Repeated {
  const counts = new Map<string, number>();
  const trees = new Map<string, Set<string>>();
  for (const run of runs) {
    if (run.kind !== 'pre-push' || run.exitCode === 0 || run.branch !== branch) continue;
    const stage = run.stages.find((one) => one.status === 'failed' || one.status === 'timed_out')?.name;
    if (stage === undefined || ignore.includes(stage)) continue;
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
    const seen = trees.get(stage) ?? new Set<string>();
    if (run.fingerprint) seen.add(run.fingerprint);
    trees.set(stage, seen);
  }
  let worst: Repeated = { fired: false, stage: null, failures: 0, trees: 0 };
  for (const [stage, failures] of counts) {
    const distinct = trees.get(stage)?.size ?? 0;
    if (failures >= MIN_FAILURES && distinct >= MIN_TREES && failures > worst.failures) worst = { fired: true, stage, failures, trees: distinct };
  }
  return worst;
}

export const CALL_SITES = ['push-skill', 'pre-push-hook', 'hook-verify'] as const;
export const DISPOSITIONS = ['own-work', 'handed-off', 'carrying', 'dismissed', 'gate-pass', 'gate-refused', 'gate-skipped'] as const;
/** The dispositions a session declares; the rest are the gate's own record. */
export const DECLARED = ['own-work', 'handed-off', 'carrying', 'dismissed'] as const;
export const SPAWNED = ['chip', 'manual', 'unavailable', 'n/a'] as const;

export interface Entry {
  ts: string;
  callSite: (typeof CALL_SITES)[number];
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  triggers: string[];
  disposition: (typeof DISPOSITIONS)[number];
  reason: string;
  briefs: string[];
  spawned: (typeof SPAWNED)[number];
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The declarations, each line whole or not counted. */
export function parseRunLog(text: string): { entries: Entry[]; malformed: number } {
  const entries: Entry[] = [];
  let malformed = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown> | null = null;
    try {
      e = JSON.parse(line) as Record<string, unknown> | null;
    } catch {
      // Counted below.
    }
    const ok =
      typeof e === 'object' &&
      e !== null &&
      typeof e.ts === 'string' &&
      oneOf(CALL_SITES, e.callSite) &&
      typeof e.branch === 'string' &&
      typeof e.baseRef === 'string' &&
      typeof e.baseSha === 'string' &&
      typeof e.headSha === 'string' &&
      texts(e.triggers) &&
      oneOf(DISPOSITIONS, e.disposition) &&
      typeof e.reason === 'string' &&
      texts(e.briefs) &&
      oneOf(SPAWNED, e.spawned);
    if (ok) entries.push(e as unknown as Entry);
    else malformed++;
  }
  return { entries, malformed };
}

/** Whether a dismissal's reason cites where the owner decided: an issue (#N or a URL), an id such as ABC-12, an ADR, or a commit. */
export function citesAuthority(reason: string): boolean {
  return /(?:^|[^\w])#\d+/.test(reason) || /\bhttps?:\/\/\S+/.test(reason) || /\b[A-Z]{2,}-\d+\b/.test(reason) || /\b[0-9a-f]{7,40}\b/.test(reason);
}

export interface Triggers {
  plumbing: { fired: boolean; paths: string[] };
  repeated: Repeated;
}

export function fired(triggers: Triggers): string[] {
  return [...(triggers.plumbing.fired ? ['plumbing-edit'] : []), ...(triggers.repeated.fired ? ['repeated-stage-failure'] : [])];
}

function describe(triggers: Triggers): string {
  const { paths } = triggers.plumbing;
  return [
    ...(triggers.plumbing.fired ? [`this branch changes ${paths.length} shared-plumbing file(s) (${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''})`] : []),
    ...(triggers.repeated.fired ? [`the push has failed ${triggers.repeated.failures} times at stage "${triggers.repeated.stage}" across ${triggers.repeated.trees} working trees`] : []),
  ].join(' and ');
}

export type GateReason =
  | 'no-trigger'
  | 'declared'
  | 'empty-run-log'
  | 'no-push-skill-entry'
  | 'stale-head-sha'
  | 'stale-base-sha'
  | 'trigger-not-declared'
  | 'missing-reason'
  | 'uncited-dismissal'
  | 'missing-brief'
  | 'brief-not-an-issue'
  | 'declaration-not-concluded'
  | BriefReason;

export interface GateInput {
  triggers: Triggers;
  baseSha: string;
  headSha: string;
  branch: string;
  entries: readonly Entry[];
  changedFiles: readonly string[];
  /** Read the briefs with; loaded only when a declaration names one, since most pushes read none. */
  yaml?: Yaml;
  pathExists(path: string): boolean;
  pathDeletedSince(sha: string, path: string): boolean;
  isAncestorOfHead(sha: string): boolean;
  readIssue(number: number): Promise<BriefIssue | null>;
  template?: string;
}

export interface GateResult {
  ok: boolean;
  reason: GateReason;
  detail: string;
  matched: Entry | null;
}

const short = (sha: string): string => sha.slice(0, 7) || '(none)';

/**
 * Whether the push may go: no trigger fired, or the newest declaration the session made (never one the gate or a
 * check wrote) covers this head, this base and every trigger that fired, and holds what its disposition owes.
 */
export async function assertDeclared(input: GateInput): Promise<GateResult> {
  const names = fired(input.triggers);
  const no = (reason: GateReason, detail: string): GateResult => ({ ok: false, reason, detail, matched: null });
  if (names.length === 0) return { ok: true, reason: 'no-trigger', detail: 'this push changes no shared plumbing and shows no stage failing again and again', matched: null };
  const why = describe(input.triggers);
  if (input.entries.length === 0) return no('empty-run-log', `${why}, and ${RUN_LOG} holds no declaration of whether this was your own work or something you tripped over`);
  const fromSession = input.entries.filter((e) => e.callSite === 'push-skill');
  if (fromSession.length === 0) {
    return no('no-push-skill-entry', `${why}, and no declaration there was made by the session (callSite "push-skill"; there: ${[...new Set(input.entries.map((e) => e.callSite))].sort().join(', ')}); a gate or check run cannot declare for it`);
  }
  const atHead = fromSession.filter((e) => e.headSha === input.headSha);
  if (atHead.length === 0) return no('stale-head-sha', `the newest declaration covered head ${short((fromSession.at(-1) as Entry).headSha)}, but this push carries ${short(input.headSha)}; declare again over the commits being pushed`);
  const exact = atHead.filter((e) => e.baseSha === input.baseSha);
  if (exact.length === 0) return no('stale-base-sha', `the declaration at head ${short(input.headSha)} was made against base ${short((atHead.at(-1) as Entry).baseSha)}, but this push compares with ${short(input.baseSha)}; declare again`);
  // The repeated-failure trigger can start firing at a head already declared: a retried push adds failures without moving it.
  const covering = exact.filter((e) => names.every((name) => e.triggers.includes(name)));
  if (covering.length === 0) {
    const newest = exact.at(-1) as Entry;
    return no('trigger-not-declared', `${why}, but the newest declaration at this head covered only [${newest.triggers.join(', ') || 'none'}]; ${names.filter((n) => !newest.triggers.includes(n)).join(', ')} fired after it, so declare again`);
  }
  const newest = covering.at(-1) as Entry;
  if (!oneOf(DECLARED, newest.disposition)) return no('declaration-not-concluded', `the newest declaration at ${short(input.headSha)} is "${newest.disposition}", the gate's own record, not a declaration`);
  if (newest.disposition === 'own-work' || newest.disposition === 'dismissed') {
    if (!newest.reason.trim()) return no('missing-reason', `"${newest.disposition}" was declared with no --reason; say in one sentence why, so a reviewer sees the scope decision`);
    if (newest.disposition === 'dismissed' && !citesAuthority(newest.reason)) {
      return no('uncited-dismissal', `"dismissed" says the owner overrode this, so its --reason cites where: an issue or pull request (#123 or a link), an id such as ABC-123, or a commit. Got: "${newest.reason}"`);
    }
    return { ok: true, reason: 'declared', detail: `${why}; declared "${newest.disposition}": ${newest.reason}`, matched: newest };
  }
  if (newest.briefs.length === 0) return no('missing-brief', `"${newest.disposition}" was declared with no --brief; write one${input.template ? ` from ${input.template}` : ''} and open it with --open-brief <draft.md>`);
  for (const brief of newest.briefs) {
    const number = /^#([1-9]\d*)$/.exec(brief)?.[1];
    if (number === undefined) return no('brief-not-an-issue', `declared brief "${brief}" is not a Brief issue; open one with --open-brief <draft.md>, or declare one as #N`);
    const verdict = judgeBrief(brief, await input.readIssue(Number(number)), {
      branch: input.branch,
      disposition: newest.disposition === 'carrying' ? 'carrying' : 'handed-off',
      lint: { yaml: (input.yaml ??= await loadYaml()), pathExists: input.pathExists, pathDeletedSince: input.pathDeletedSince, changedFiles: input.changedFiles, ...(input.template ? { template: input.template } : {}) },
      isAncestorOfHead: input.isAncestorOfHead,
    });
    if (!verdict.ok) return no(verdict.reason, verdict.detail);
  }
  return { ok: true, reason: 'declared', detail: `${why}; declared "${newest.disposition}" with ${newest.briefs.join(', ')}`, matched: newest };
}

/** The repository, its settings and what git says about this branch against `base`. */
interface Here {
  root: string;
  slug: string;
  raw: Record<string, unknown>;
  settings: HandoffSettings;
  /** The remote-tracking branch the push is compared with. */
  base: string;
  git(args: string[]): { ok: boolean; out: string };
}

/**
 * The repository's settings, and the `"handoff"` that decides, or undefined when none is named. The base's copy
 * decides when it names one, read from the ref asked for or the remote's default branch, never a ref the branch's
 * own settings name: a branch cannot turn the gate off, or shorten its list, in the push the gate judges.
 */
function settingsHere(sys: Sys, base?: string): { root: string; slug: string; raw: Record<string, unknown>; settings: HandoffSettings | undefined } {
  const { root, slug } = repoAt(sys);
  const path = `${root}/${SETTINGS_PATH}`;
  const raw = sys.exists(path) ? (JSON.parse(sys.read(path)) as Record<string, unknown>) : {};
  const tree = handoffSettings(raw);
  const remoteHead = sys.exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  const at = base ?? (remoteHead.code === 0 && remoteHead.stdout.trim() ? remoteHead.stdout.trim() : 'origin/main');
  const shown = sys.exec('git', ['show', `${at}:${SETTINGS_PATH}`], { cwd: root });
  let atBase: HandoffSettings | undefined;
  try {
    atBase = shown.code === 0 ? handoffSettings(JSON.parse(shown.stdout)) : undefined;
  } catch {
    // A base whose settings do not read decides nothing; the branch's own then do.
  }
  return { root, slug, raw, settings: atBase ?? tree };
}

function here(sys: Sys, asked?: string): Here {
  const { root, slug, raw, settings } = settingsHere(sys, asked);
  if (!settings) throw new Error(`${SETTINGS_PATH} names no "handoff": the gate is off in this repository`);
  const git = (args: string[]): { ok: boolean; out: string } => {
    const run = sys.exec('git', args, { cwd: root });
    return { ok: run.code === 0, out: run.stdout.trim() };
  };
  const base = asked ?? settings.base;
  // A ref the branch can point at itself, such as HEAD, would compare the push with itself and see nothing.
  const full = git(['rev-parse', '--symbolic-full-name', base]);
  if (!full.ok || !full.out.startsWith('refs/remotes/')) throw new Error(`the base "${base}" is not a remote-tracking branch, such as origin/main: the gate compares a push with what the remote has`);
  return { root, slug, raw, settings, base, git };
}

function must(h: Here, args: string[], what: string): string {
  const run = h.git(args);
  if (!run.ok) throw new Error(`git cannot tell ${what}`);
  return run.out;
}

/** The branch, its changed files, the triggers, and the base and head commits, against `base`. */
export function collect(sys: Sys, h: Here, base: string): { branch: string; changedFiles: string[]; triggers: Triggers; baseSha: string; headSha: string } {
  const branch = must(h, ['rev-parse', '--abbrev-ref', 'HEAD'], 'the branch');
  const changedFiles = must(h, ['diff', '--name-only', `${base}...HEAD`], `what this branch changes against ${base}`).split('\n').filter(Boolean);
  // The settings file is plumbing itself: it says what plumbing is.
  const paths = changedFiles.filter((file) => file === SETTINGS_PATH || isPlumbing(file, h.settings.plumbing));
  const history = h.settings.history && sys.exists(`${h.root}/${h.settings.history}`) ? parseHistory(sys.read(`${h.root}/${h.settings.history}`)).runs : [];
  return {
    branch,
    changedFiles,
    triggers: { plumbing: { fired: paths.length > 0, paths }, repeated: repeatedFailure(history, branch, h.settings.ignoreStages) },
    baseSha: must(h, ['merge-base', base, 'HEAD'], `where this branch left ${base}`),
    headSha: must(h, ['rev-parse', 'HEAD'], 'the head commit'),
  };
}

function lintContext(h: Here, changedFiles: readonly string[]): Omit<LintContext, 'disposition' | 'template' | 'yaml'> & { isAncestorOfHead(sha: string): boolean } {
  const existsAt = (rev: string, path: string): boolean => h.git(['cat-file', '-e', `${rev}:${path}`]).ok;
  const isAncestorOfHead = (sha: string): boolean => h.git(['merge-base', '--is-ancestor', sha, 'HEAD']).ok;
  return {
    changedFiles,
    pathExists: (path) => existsAt('HEAD', path),
    pathDeletedSince: (sha, path) => deletedSince({ existsAt, isAncestor: isAncestorOfHead }, sha, path),
    isAncestorOfHead,
  };
}

const append = (sys: Sys, root: string, entry: Entry): void => {
  sys.mkdir(`${root}/.tmp/push`);
  sys.append(`${root}/${RUN_LOG}`, `${JSON.stringify(entry)}\n`);
};

/** The gate at a push: refuses unless a declaration covers it, and records its own verdict. */
export async function gate(sys: Sys, io: Output, base: string | undefined, callSite: Entry['callSite'] = 'pre-push-hook'): Promise<number> {
  // A repository that names no shared plumbing has turned the gate off.
  if (!settingsHere(sys, base).settings) return 0;
  const h = here(sys, base);
  const ref = h.base;
  const { branch, changedFiles, triggers, baseSha, headSha } = collect(sys, h, ref);
  const log = sys.exists(`${h.root}/${RUN_LOG}`) ? parseRunLog(sys.read(`${h.root}/${RUN_LOG}`)).entries : [];
  const context = lintContext(h, changedFiles);
  const token = sessionToken(sys);
  const verdict = await assertDeclared({
    triggers,
    baseSha,
    headSha,
    branch,
    entries: log,
    ...context,
    readIssue: async (n) => (token ? readBrief(sys, token, h.slug, n) : null),
    ...(h.settings.template ? { template: h.settings.template } : {}),
  });
  append(sys, h.root, {
    ts: sys.now().toISOString(),
    callSite,
    branch,
    baseRef: ref,
    baseSha,
    headSha,
    triggers: fired(triggers),
    disposition: verdict.ok ? (verdict.reason === 'no-trigger' ? 'gate-skipped' : 'gate-pass') : 'gate-refused',
    reason: verdict.detail,
    briefs: verdict.matched?.briefs ?? [],
    spawned: 'n/a',
  });
  if (verdict.ok) {
    if (verdict.reason !== 'no-trigger') io.out(`✓ handoff: ${verdict.detail}`);
    return 0;
  }
  io.err(`✗ handoff: ${verdict.detail}`);
  io.err(`  what fired: niyam handoff --detect --base ${ref}`);
  io.err(`  then declare: niyam handoff --record --base ${ref} --disposition <own-work|handed-off|carrying|dismissed> --reason "..."`);
  return 1;
}

/** The options `handoff` and `brief` take, each once, with a value that is not the next option. */
function options(args: readonly string[], known: readonly string[], flags: readonly string[]): Map<string, string | true> {
  const found = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (found.has(name)) throw new Error(`${name} is given twice`);
    if (flags.includes(name) && eq < 0) {
      found.set(name, true);
      continue;
    }
    if (!known.includes(name)) throw new Error(`unexpected argument "${token}"`);
    const value = eq > 0 ? token.slice(eq + 1) : args[++i];
    if (value === undefined || !value.trim() || value.startsWith('--')) throw new Error(`${name} needs a value`);
    found.set(name, value);
  }
  return found;
}

const MODES = ['--detect', '--record', '--assert-fresh'];
const VALUES = ['--base', '--disposition', '--reason', '--brief', '--open-brief', '--call-site', '--spawned'];

export interface HandoffArgs {
  mode: 'detect' | 'record' | 'assert-fresh';
  base?: string;
  disposition?: (typeof DECLARED)[number];
  reason: string;
  briefs: string[];
  openBrief?: string;
  callSite?: Entry['callSite'];
  spawned: Entry['spawned'];
}

/** `handoff`'s arguments: one mode, and the options it takes; anything else is refused. */
export function handoffArgs(args: readonly string[]): HandoffArgs {
  const found = options(args, VALUES, MODES);
  const modes = MODES.filter((mode) => found.has(mode));
  if (modes.length !== 1) throw new Error('handoff takes one of --detect, --record or --assert-fresh');
  const mode = (modes[0] as string).slice(2) as HandoffArgs['mode'];
  const value = (name: string): string | undefined => found.get(name) as string | undefined;
  const only = (allowed: string[]): void => {
    const stray = VALUES.find((name) => found.has(name) && !allowed.includes(name));
    if (stray) throw new Error(`--${mode} does not take ${stray}`);
  };
  const disposition = value('--disposition');
  const callSite = value('--call-site');
  const spawned = value('--spawned') ?? 'n/a';
  if (mode === 'detect') only(['--base']);
  if (mode === 'assert-fresh') only(['--base', '--call-site']);
  if (mode === 'record') {
    if (!oneOf(DECLARED, disposition)) throw new Error(`--record needs --disposition ${DECLARED.join('|')}${disposition ? `, not "${disposition}"` : ''}`);
    if (value('--open-brief') !== undefined && !value('--reason')) throw new Error('--open-brief needs --reason: the gate refuses a declaration without one, so no issue is opened');
  }
  if (callSite !== undefined && !oneOf(CALL_SITES, callSite)) throw new Error(`--call-site takes ${CALL_SITES.join('|')}, not "${callSite}"`);
  if (mode === 'assert-fresh' && callSite === 'push-skill') throw new Error('--assert-fresh cannot run as "push-skill": the gate cannot write its own evidence');
  if (!oneOf(SPAWNED, spawned)) throw new Error(`--spawned takes ${SPAWNED.join('|')}, not "${spawned}"`);
  const base = value('--base');
  const reason = value('--reason');
  const openBrief = value('--open-brief');
  return {
    mode,
    ...(base === undefined ? {} : { base }),
    ...(disposition === undefined ? {} : { disposition: disposition as (typeof DECLARED)[number] }),
    reason: reason ?? '',
    briefs: (value('--brief') ?? '').split(',').map((b) => b.trim()).filter(Boolean),
    ...(openBrief === undefined ? {} : { openBrief }),
    ...(callSite === undefined ? {} : { callSite: callSite as Entry['callSite'] }),
    spawned: spawned as Entry['spawned'],
  };
}

/** A draft path inside the repository, or null: its text goes to GitHub, so nothing from elsewhere may be read. */
function draftAt(h: Here, sys: Sys, draft: string): string | null {
  const rel = relative(h.root, resolve(sys.cwd, draft));
  return repoPath(rel);
}

/** Lints a draft for this branch and opens it as a Brief issue on the repository's Project; the issue's ref, or a problem. */
async function openDraft(sys: Sys, io: Output, h: Here, draft: string, disposition: 'handed-off' | 'carrying', branch: string, changedFiles: readonly string[]): Promise<string | undefined> {
  const rel = draftAt(h, sys, draft);
  if (rel === null) {
    io.err(`✗ the brief draft must be a file in the repository: ${draft}; no issue was opened`);
    return undefined;
  }
  if (!sys.exists(`${h.root}/${rel}`)) {
    io.err(`✗ no brief draft at ${draft}; no issue was opened`);
    return undefined;
  }
  const lint = lintDraft(sys.read(`${h.root}/${rel}`), branch, { ...lintContext(h, changedFiles), yaml: await loadYaml(), disposition, ...(h.settings.template ? { template: h.settings.template } : {}) });
  if (!lint.ok) {
    io.err(`✗ ${draft}: ${lint.problems.join('; ')}`);
    io.err('no issue was opened');
    return undefined;
  }
  const token = sessionToken(sys);
  if (!token) {
    io.err('✗ this session has no token; run niyam doctor. No issue was opened');
    return undefined;
  }
  const opened = await openBrief(sys, token, h.slug, lint.draft);
  const project = typeof h.raw.project === 'string' ? h.raw.project : undefined;
  // The issue is the brief once it exists, so it is recorded even when the board add fails: a rerun would open another.
  try {
    if (project) await addToProject(sys, token, h.slug, opened.id, project);
    io.out(`✓ opened #${opened.number}${project ? ` on "${project}"` : ''}: ${opened.url}`);
  } catch (error) {
    io.err(`⚠ opened ${opened.url} but could not add it to "${project as string}" (${error instanceof Error ? error.message : String(error)}); add it by hand`);
  }
  return `#${opened.number}`;
}

/**
 * `niyam handoff`: --detect says which triggers fire; --record appends the session's declaration, opening its
 * brief first with --open-brief; --assert-fresh is the gate, as the pre-push hook runs it.
 */
export async function handoff(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  const parsed = handoffArgs(args);
  if (parsed.mode === 'assert-fresh') return gate(sys, io, parsed.base, parsed.callSite);
  const h = here(sys, parsed.base);
  const { base } = h;
  const { branch, changedFiles, triggers, baseSha, headSha } = collect(sys, h, base);
  if (parsed.mode === 'detect') {
    io.out(JSON.stringify({ branch, baseRef: base, changedFiles: changedFiles.length, triggers, fired: fired(triggers), runLog: RUN_LOG }, null, 2));
    return 0;
  }
  const disposition = parsed.disposition as (typeof DECLARED)[number];
  const briefs = [...parsed.briefs];
  if (parsed.openBrief !== undefined) {
    if (disposition !== 'handed-off' && disposition !== 'carrying') {
      io.err(`✗ --open-brief goes with --disposition handed-off or carrying, not "${disposition}"`);
      return 1;
    }
    const opened = await openDraft(sys, io, h, parsed.openBrief, disposition, branch, changedFiles);
    if (opened === undefined) return 1;
    if (!briefs.includes(opened)) briefs.push(opened);
  }
  const entry: Entry = {
    ts: sys.now().toISOString(),
    callSite: parsed.callSite ?? 'push-skill',
    branch,
    baseRef: base,
    baseSha,
    headSha,
    triggers: fired(triggers),
    disposition,
    reason: parsed.reason,
    briefs,
    spawned: parsed.spawned,
  };
  append(sys, h.root, entry);
  io.out(JSON.stringify({ recorded: entry, runLog: RUN_LOG }, null, 2));
  return 0;
}

/** `brief <draft.md>` opens the draft as a Brief issue; `brief --lint <draft.md>` only checks it. */
export function briefArgs(args: readonly string[]): { draft: string; lint: boolean } {
  const lint = args[0] === '--lint';
  const rest = lint ? args.slice(1) : args;
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith('--')) throw new Error('brief takes one draft file: niyam brief [--lint] <draft.md>');
  return { draft: rest[0], lint };
}

export async function brief(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  const { draft, lint } = briefArgs(args);
  const h = here(sys);
  const { branch, changedFiles } = collect(sys, h, h.base);
  if (!lint) return (await openDraft(sys, io, h, draft, 'handed-off', branch, changedFiles)) === undefined ? 1 : 0;
  const rel = draftAt(h, sys, draft);
  if (rel === null || !sys.exists(`${h.root}/${rel}`)) {
    io.err(`✗ no brief draft in the repository at ${draft}`);
    return 1;
  }
  const result = lintDraft(sys.read(`${h.root}/${rel}`), branch, { ...lintContext(h, changedFiles), yaml: await loadYaml(), disposition: 'handed-off', ...(h.settings.template ? { template: h.settings.template } : {}) });
  if (result.ok) {
    io.out(`✓ ${draft} is a brief this branch can open`);
    return 0;
  }
  for (const problem of result.problems) io.err(`✗ ${problem}`);
  return 1;
}

