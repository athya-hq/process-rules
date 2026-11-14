import { API, SETTINGS_PATH, isLogin, repoAt } from './agent.ts';
import { connection, restList, type Page } from './pages.ts';
import type { Output, Sys } from './types.ts';
import { sessionToken } from './work.ts';

/** Where a signal came from: a review thread, a failing check, or the client's local review findings file. */
export type Source = 'review-thread' | 'ci-failure' | 'local-findings';

/** One concern about the pull request, after duplicates are folded together. */
export interface Signal {
  id: string;
  source: Source;
  /** Every source that reported it. */
  sources: Source[];
  /** The id `niyam review-thread` takes: the thread's node id (PRRT_…), or in a cloud session its first comment's REST id. */
  thread?: string;
  /** The id `review-thread --comment-id` takes for the thread's first comment: its node id, or in a cloud session its REST id. */
  comment?: string;
  author?: string;
  file: string | null;
  line: number | null;
  body: string;
  createdAt?: string;
  severity?: string;
  check?: string;
  failureType?: 'lint' | 'typecheck' | 'test' | 'build' | 'other';
  /** Resolved threads that may be the same concern: a hint for the reader, never a verdict. */
  candidates?: Candidate[];
}

/** A resolved thread, kept so a new finding can be told apart from one already answered. */
export interface Resolved {
  file: string | null;
  line: number | null;
  preview: string;
  createdAt?: string;
  author?: string;
}

export interface Candidate extends Resolved {
  matchedBy: 'proximity' | 'body' | 'both';
  /** `git log -p` of the file since the resolved thread was opened, cut short: where to look, not proof. */
  diff?: string;
}

/** A signal before its id and sources are given. */
export type RawSignal = Omit<Signal, 'id' | 'sources'> & { sources?: Source[] };

/** What `.github/niyam.json`'s `"signals"` names: review bots, and the local review's findings file. */
export interface SignalSettings {
  /** Logins of review bots whose thread and local finding at one line are the same review, worded twice. */
  bots: string[];
  /** A findings file the client's local review writes, relative to the repository. */
  findings?: string;
}

/** Exit codes when the pull request is not open: nothing to answer. */
export const MERGED_EXIT = 3;
export const CLOSED_EXIT = 4;

/** `<pr> [--ci-only]`, refusing anything else. */
export function signalArgs(args: readonly string[]): { pr: number; ciOnly: boolean } {
  let pr: number | undefined;
  let ciOnly = false;
  for (const arg of args) {
    if (arg === '--ci-only' && !ciOnly) ciOnly = true;
    else if (pr === undefined && /^#?[1-9]\d*$/.test(arg)) pr = Number(arg.replace('#', ''));
    else throw new Error(`unexpected argument "${arg}"`);
  }
  if (pr === undefined) throw new Error('pr-signals needs a pull request number');
  return { pr, ciOnly };
}

/** The `"signals"` settings; none named is no bots and no findings file. Throws on a malformed entry. */
export function signalSettings(raw: unknown): SignalSettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).signals : undefined;
  if (value === undefined) return { bots: [] };
  const where = `${SETTINGS_PATH}: "signals"`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const { bots = [], findings, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new Error(`${where} has an unknown key "${extra}"; it takes "bots" and "findings"`);
  if (!Array.isArray(bots) || !bots.every((bot) => typeof bot === 'string' && isLogin(bot.replace(/\[bot\]$/, '')))) {
    throw new Error(`${where}.bots must be a list of GitHub logins`);
  }
  if (findings !== undefined && (typeof findings !== 'string' || !findings || findings.startsWith('/') || findings.split('/').includes('..'))) {
    throw new Error(`${where}.findings must be a path inside the repository, such as ".tmp/review/findings.json"`);
  }
  return { bots: bots as string[], ...(findings === undefined ? {} : { findings }) };
}

/**
 * A finding's body for comparing: lower case, one space between words, without the markers that differ between
 * where it was reported ("[bot]", "P1:", "severity: high", markdown).
 */
export function normalizeBody(body: string): string {
  return body
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\bp[0-9]\b\s*:?/g, ' ')
    .replace(/\bseverity\b\s*:?\s*\w+/g, ' ')
    .replace(/[`*_~>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const bare = (login: string): string => login.toLowerCase().replace(/\[bot\]$/, '');

/**
 * Folds signals that are one concern into one, numbered SIG-001 on: those at one file and line with the same
 * body, and a bot's thread and the local finding at one concrete file and line, the same review worded twice. A
 * pull-request-level finding (no file or line) folds only on its body, so two different ones never merge. The
 * thread's copy wins, as it is the one review-thread answers; otherwise the first.
 */
export function dedupe(raw: readonly RawSignal[], bots: readonly string[]): Signal[] {
  const bot = new Set(bots.map(bare));
  const fromBot = (s: RawSignal): boolean => s.source === 'local-findings' || (s.source === 'review-thread' && s.author !== undefined && bot.has(bare(s.author)));
  const same = (a: RawSignal, b: RawSignal): boolean =>
    a.file === b.file && a.line === b.line && (normalizeBody(a.body) === normalizeBody(b.body) || (a.file !== null && a.line !== null && fromBot(a) && fromBot(b)));
  const merged: RawSignal[] = [];
  for (const signal of raw) {
    const at = merged.findIndex((kept) => same(kept, signal));
    if (at < 0) {
      merged.push({ ...signal, sources: [signal.source] });
      continue;
    }
    const kept = merged[at] as RawSignal;
    const winner = signal.source === 'review-thread' && kept.source !== 'review-thread' ? signal : kept;
    const loser = winner === kept ? signal : kept;
    merged[at] = {
      ...winner,
      ...(winner.thread ?? loser.thread ? { thread: (winner.thread ?? loser.thread) as string } : {}),
      ...(winner.severity ?? loser.severity ? { severity: (winner.severity ?? loser.severity) as string } : {}),
      sources: [...new Set([...(kept.sources ?? [kept.source]), signal.source])],
    };
  }
  return merged.map((signal, i) => ({ ...signal, id: `SIG-${String(i + 1).padStart(3, '0')}`, sources: signal.sources ?? [signal.source] }));
}

const NEAR_LINES = 10;
const MIN_OVERLAP = 12;

/**
 * Adds to each signal the resolved threads that may be the same concern: within ten lines in the same file, or a
 * body one holds the other of (12 characters or more), and the file's history since, from `history`. A hint only.
 */
export function addCandidates(signals: Signal[], resolved: readonly Resolved[], history: (file: string, since: string) => string): Signal[] {
  const seen = new Map<string, string>();
  for (const signal of signals) {
    const body = normalizeBody(signal.body);
    const found: Candidate[] = [];
    for (const item of resolved) {
      const near = signal.file !== null && item.file === signal.file && signal.line !== null && item.line !== null && Math.abs(item.line - signal.line) <= NEAR_LINES;
      const preview = normalizeBody(item.preview);
      const alike = preview.length >= MIN_OVERLAP && (body.includes(preview) || preview.includes(body));
      if (!near && !alike) continue;
      const candidate: Candidate = { ...item, matchedBy: near && alike ? 'both' : near ? 'proximity' : 'body' };
      if (item.file && item.createdAt) {
        const key = `${item.file}@${item.createdAt}`;
        if (!seen.has(key)) seen.set(key, history(item.file, item.createdAt));
        const diff = seen.get(key);
        if (diff) candidate.diff = diff;
      }
      found.push(candidate);
    }
    if (found.length) signal.candidates = found;
  }
  return signals;
}

/** One finding in the local findings file. */
export interface Finding {
  title?: string;
  description?: string;
  file?: string;
  path?: string;
  line?: number;
  priority?: string;
  severity?: string;
}

/**
 * The local findings file's state: `ok`, a review that finished (no findings is a clean review); `failed`, one that
 * crashed or was killed, whose empty list proves nothing; `absent`, no file.
 */
export type FindingsRead = { status: 'ok' | 'absent'; findings: Finding[] } | { status: 'failed'; findings: Finding[]; reason: string };

/** Reads the findings file's text, or null when there is none. A file that says its review failed never reads as clean. */
export function readFindings(text: string | null): FindingsRead {
  if (text === null) return { status: 'absent', findings: [] };
  let parsed: { issues?: unknown; metadata?: { status?: unknown; failureReason?: unknown; exit?: unknown } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { status: 'failed', findings: [], reason: 'the findings file is not JSON' };
  }
  const findings = Array.isArray(parsed?.issues) ? (parsed.issues as Finding[]) : [];
  if (parsed?.metadata?.status === 'failed') {
    const { failureReason, exit } = parsed.metadata;
    return { status: 'failed', findings, reason: typeof failureReason === 'string' ? failureReason : `the review exited ${typeof exit === 'number' ? exit : 'non-zero'}` };
  }
  return { status: 'ok', findings };
}

/** The pull request as `pr-signals` reads it. */
interface Pull {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt: string | null;
  head: string;
}

async function readPull(sys: Sys, token: string, slug: string, pr: number): Promise<Pull> {
  const { status, json } = await sys.http(`${API}/repos/${slug}/pulls/${pr}`, { token });
  const pull = json as { state?: unknown; merged_at?: unknown; head?: { sha?: unknown } } | null;
  if (status !== 200 || typeof pull?.state !== 'string' || typeof pull.head?.sha !== 'string') throw new Error(`cannot read pull request #${pr} in ${slug} (HTTP ${status})`);
  const mergedAt = typeof pull.merged_at === 'string' ? pull.merged_at : null;
  return { state: mergedAt ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED', mergedAt, head: pull.head.sha };
}

/** Refuses a pull request that is not open: a stale findings file must not make signals for a merged one. */
function notOpen(io: Output, pr: number, pull: Pull, phase: 'start' | 'before-print'): number | undefined {
  if (pull.state === 'OPEN') return undefined;
  const why = pull.state === 'MERGED' ? `#${pr} merged at ${pull.mergedAt as string}` : `#${pr} is closed without merging`;
  io.err(`✗ ${why}; nothing to answer${phase === 'before-print' ? ' (it changed while the signals were read)' : ''}`);
  io.out(JSON.stringify({ ok: false, reason: 'pr-not-open', pr, state: pull.state, mergedAt: pull.mergedAt, phase }, null, 2));
  return pull.state === 'MERGED' ? MERGED_EXIT : CLOSED_EXIT;
}

async function graphql(sys: Sys, token: string, query: string, variables: Record<string, unknown>, what: string): Promise<unknown> {
  const { status, json } = await sys.http(`${API}/graphql`, { method: 'POST', token, body: { query, variables } });
  const reply = json as { data?: unknown; errors?: { message?: string }[] } | null;
  if (status !== 200 || !reply?.data || reply.errors?.length) {
    throw new Error(`GitHub refused to ${what} (HTTP ${status}${reply?.errors?.[0]?.message ? `: ${reply.errors[0].message}` : ''})`);
  }
  return reply.data;
}

export const THREADS_QUERY =
  'query($owner: String!, $name: String!, $pr: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved comments(first: 1) { nodes { id author { login } body path line originalLine createdAt } } } } } } }';

/** A thread as both transports give it: its id, whether it is resolved, and its first comment. */
interface Thread {
  id: string;
  resolved: boolean;
  first?: { id: string; author?: string; body: string; path: string | null; line: number | null; createdAt?: string };
}

interface GraphThread {
  id: string;
  isResolved: boolean;
  comments?: { nodes?: { id: string; author?: { login?: string } | null; body?: string; path?: string | null; line?: number | null; originalLine?: number | null; createdAt?: string }[] };
}

/** The threads over GraphQL, every page read. */
async function graphThreads(sys: Sys, token: string, slug: string, pr: number): Promise<Thread[]> {
  const [owner, name] = slug.split('/') as [string, string];
  const nodes = await connection<GraphThread>(`the review threads of #${pr}`, async (after) => {
    const data = (await graphql(sys, token, THREADS_QUERY, { owner, name, pr, ...(after === null ? {} : { after }) }, `read the review threads of #${pr}`)) as {
      repository?: { pullRequest?: { reviewThreads?: Page<GraphThread> } | null } | null;
    };
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`GitHub shows no pull request #${pr} in ${slug}`);
    return threads;
  });
  return nodes.map((node) => {
    const first = node.comments?.nodes?.[0];
    return {
      id: node.id,
      resolved: node.isResolved,
      ...(first
        ? {
            first: {
              id: first.id,
              ...(first.author?.login ? { author: first.author.login } : {}),
              body: first.body ?? '',
              path: first.path ?? null,
              line: first.line ?? first.originalLine ?? null,
              ...(first.createdAt ? { createdAt: first.createdAt } : {}),
            },
          }
        : {}),
    };
  });
}

/** A review comment over REST. */
export interface RestComment {
  id: number;
  inReplyTo: number | null;
  author?: string;
  body: string;
  path: string | null;
  line: number | null;
  createdAt?: string;
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Every review comment on the pull request, replies too, over REST. */
export async function restComments(sys: Sys, token: string, slug: string, pr: number): Promise<RestComment[]> {
  return (await restList(sys, token, `repos/${slug}/pulls/${pr}/comments`)).map((raw) => {
    const c = raw as { id?: unknown; in_reply_to_id?: unknown; user?: { login?: unknown } | null; body?: unknown; path?: unknown; line?: unknown; original_line?: unknown; created_at?: unknown };
    if (!isId(c?.id)) throw new Error(`a review comment on #${pr} has no id`);
    const line = typeof c.line === 'number' ? c.line : typeof c.original_line === 'number' ? c.original_line : null;
    return {
      id: c.id,
      inReplyTo: isId(c.in_reply_to_id) ? c.in_reply_to_id : null,
      ...(typeof c.user?.login === 'string' ? { author: c.user.login } : {}),
      body: typeof c.body === 'string' ? c.body : '',
      path: typeof c.path === 'string' ? c.path : null,
      line,
      ...(typeof c.created_at === 'string' ? { createdAt: c.created_at } : {}),
    };
  });
}

/**
 * The cloud proxy's thread list (`ccr/review_threads`): every thread, unpaged, each named by its comments' REST
 * ids, the first naming the thread. An entry it cannot read throws.
 */
export async function proxyThreads(sys: Sys, token: string, slug: string, pr: number): Promise<{ resolved: boolean; comments: number[] }[]> {
  const route = `repos/${slug}/pulls/${pr}/ccr/review_threads`;
  const { status, json } = await sys.http(`${API}/${route}`, { token });
  if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read ${route} (HTTP ${status})`);
  return json.map((entry: { resolved?: unknown; comment_ids?: unknown } | null) => {
    const ids = entry?.comment_ids;
    if (typeof entry?.resolved !== 'boolean' || !Array.isArray(ids) || ids.length === 0 || !ids.every(isId)) throw new Error(`${route} lists a thread it does not name`);
    return { resolved: entry.resolved, comments: ids as number[] };
  });
}

/** The threads in a cloud session, where the proxy refuses GraphQL: a thread is its first comment's REST id. */
async function cloudThreads(sys: Sys, token: string, slug: string, pr: number): Promise<Thread[]> {
  const byId = new Map((await restComments(sys, token, slug, pr)).map((c) => [c.id, c]));
  return (await proxyThreads(sys, token, slug, pr)).map(({ resolved, comments }) => {
    const first = byId.get(comments[0] as number);
    return {
      id: String(comments[0]),
      resolved,
      ...(first
        ? {
            first: {
              id: String(first.id),
              ...(first.author ? { author: first.author } : {}),
              body: first.body,
              path: first.path,
              line: first.line,
              ...(first.createdAt ? { createdAt: first.createdAt } : {}),
            },
          }
        : {}),
    };
  });
}

/** Open threads as signals; resolved ones as what a new finding is compared with. A thread with no comment is skipped. */
export function threadSignals(threads: readonly Thread[]): { signals: RawSignal[]; resolved: Resolved[] } {
  const signals: RawSignal[] = [];
  const resolved: Resolved[] = [];
  for (const { id, resolved: done, first } of threads) {
    if (!first) continue;
    const shared = { file: first.path, line: first.line, ...(first.author ? { author: first.author } : {}), ...(first.createdAt ? { createdAt: first.createdAt } : {}) };
    if (done) resolved.push({ ...shared, preview: first.body.slice(0, 200) });
    else signals.push({ source: 'review-thread', thread: id, comment: first.id, body: first.body, ...shared });
  }
  return { signals, resolved };
}

/** Check-run conclusions and status states that are a failure. */
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'error']);
/** Log lines kept as a failure's excerpt: errors only. */
const ERROR_LINE = /error|fail|✖|✗|✘|cannot|missing|expected/i;
const EXCERPT_LINES = 40;

export function failureType(text: string): NonNullable<Signal['failureType']> {
  const t = text.toLowerCase();
  if (/tsc|type(check)?|ts\d{3,}/.test(t)) return 'typecheck';
  if (/eslint|lint/.test(t)) return 'lint';
  if (/test|vitest|jest|expect\(/.test(t)) return 'test';
  if (/build|compile|bundl/.test(t)) return 'build';
  return 'other';
}

/** The time GitHub Actions starts each log line with. */
const LOG_TIME = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

/** The error lines of a log, at most 40, without the time each starts with. */
export function excerpt(log: string): string {
  return log
    .split('\n')
    .map((line) => line.replace(LOG_TIME, ''))
    .filter((line) => ERROR_LINE.test(line))
    .slice(0, EXCERPT_LINES)
    .join('\n');
}

/**
 * The head commit's failing check runs and statuses, each with the error lines of its log when GitHub Actions ran
 * it (a check run's id is its job's), else its name, conclusion and summary. Every page is read: a check left out
 * reads as one that passed.
 */
export async function ciSignals(sys: Sys, token: string, slug: string, head: string): Promise<RawSignal[]> {
  const commit = `repos/${slug}/commits/${head}`;
  const runs = await restList(sys, token, `${commit}/check-runs`, 'check_runs');
  const statuses = await restList(sys, token, `${commit}/status`, 'statuses');
  // Every failing run is kept, even when a run of that name passed: two workflows can name a job alike, and a
  // pass must never hide a failure. The same failure reported twice has the same lines, and dedupe folds it.
  const signals: RawSignal[] = [];
  for (const raw of runs) {
    const run = raw as { id?: unknown; name?: unknown; conclusion?: unknown; app?: { slug?: unknown } | null; output?: { title?: unknown; summary?: unknown } | null };
    if (!isId(run?.id) || typeof run.name !== 'string') throw new Error(`${commit} lists a check run with no id or name`);
    if (typeof run.conclusion !== 'string' || !FAILED.has(run.conclusion)) continue;
    let body = [`${run.name}: ${run.conclusion}`, run.output?.title, run.output?.summary].filter((part) => typeof part === 'string' && part).join('\n');
    if (run.app?.slug === 'github-actions') {
      const log = await sys.http(`${API}/repos/${slug}/actions/jobs/${run.id}/logs`, { token, text: true });
      const lines = log.status === 200 ? excerpt(log.text ?? '') : '';
      if (lines) body = lines;
    }
    signals.push({ source: 'ci-failure', check: run.name, file: null, line: null, body, failureType: failureType(body) });
  }
  for (const raw of statuses) {
    const status = raw as { context?: unknown; state?: unknown; description?: unknown };
    if (typeof status?.context !== 'string' || typeof status.state !== 'string') throw new Error(`${commit} lists a status with no name or state`);
    if (!FAILED.has(status.state)) continue;
    const body = [`${status.context}: ${status.state}`, status.description].filter((part) => typeof part === 'string' && part).join('\n');
    signals.push({ source: 'ci-failure', check: status.context, file: null, line: null, body, failureType: failureType(body) });
  }
  return signals;
}

/** The local findings as signals, without those citing a file the pull request does not change: another branch's. */
export function findingSignals(findings: readonly Finding[], changed: ReadonlySet<string>): { kept: RawSignal[]; dropped: number } {
  const kept: RawSignal[] = [];
  let dropped = 0;
  for (const finding of findings) {
    const file = (finding.file ?? finding.path ?? '').trim();
    if (file && !changed.has(file)) {
      dropped++;
      continue;
    }
    const severity = finding.priority ?? finding.severity;
    kept.push({
      source: 'local-findings',
      file: file || null,
      line: typeof finding.line === 'number' ? finding.line : null,
      body: [finding.title, finding.description].filter(Boolean).join(' — '),
      ...(severity ? { severity } : {}),
    });
  }
  return { kept, dropped };
}

const DIFF_CHARS = 4000;

/**
 * Prints, as one JSON object, a pull request's open review threads, its failing checks (error lines only) and the
 * local review's findings, duplicates folded, each thread with the ids `review-thread` takes; resolved threads come
 * with it, to tell a new finding from one answered. Refuses a pull request that is not open, before reading anything
 * and again before printing. In a Claude cloud session the threads come over the proxy's REST routes.
 */
export async function prSignals(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  const { pr, ciOnly } = signalArgs(args);
  const { root, slug } = repoAt(sys);
  const settingsPath = `${root}/${SETTINGS_PATH}`;
  const settings = signalSettings(sys.exists(settingsPath) ? (JSON.parse(sys.read(settingsPath)) as unknown) : {});
  const token = sessionToken(sys);
  if (!token) {
    io.err('✗ this session has no token; run niyam doctor');
    return 1;
  }
  const cloud = sys.env.CLAUDE_CODE_REMOTE === 'true';
  const pull = await readPull(sys, token, slug, pr);
  const refused = notOpen(io, pr, pull, 'start');
  if (refused !== undefined) return refused;

  const threads = ciOnly ? { signals: [], resolved: [] } : threadSignals(await (cloud ? cloudThreads : graphThreads)(sys, token, slug, pr));
  const ci = await ciSignals(sys, token, slug, pull.head);
  let findings: { status: FindingsRead['status']; reason?: string; droppedOffDiff?: number } | undefined;
  let local: RawSignal[] = [];
  if (!ciOnly && settings.findings) {
    const path = `${root}/${settings.findings}`;
    const read = readFindings(sys.exists(path) ? sys.read(path) : null);
    findings = { status: read.status, ...(read.status === 'failed' ? { reason: read.reason } : {}) };
    if (read.findings.length) {
      const changed = new Set((await restList(sys, token, `repos/${slug}/pulls/${pr}/files`)).map((file) => String((file as { filename?: unknown } | null)?.filename)));
      const { kept, dropped } = findingSignals(read.findings, changed);
      local = kept;
      if (dropped) findings.droppedOffDiff = dropped;
    }
    if (read.status === 'failed') io.err(`⚠ the local review failed (${read.reason}): its findings are missing, so lean on the bots' threads`);
  }

  const raw = [...threads.signals, ...ci, ...local];
  const signals = addCandidates(dedupe(raw, settings.bots), threads.resolved, (file, since) => {
    const log = sys.exec('git', ['log', '-p', `--after=${since}`, '--', file], { cwd: root });
    if (log.code !== 0) return '';
    return log.stdout.length > DIFF_CHARS ? `${log.stdout.slice(0, DIFF_CHARS)}\n…[cut]` : log.stdout;
  });

  // Reading takes a while, and a green pull request can merge meanwhile.
  const late = notOpen(io, pr, await readPull(sys, token, slug, pr), 'before-print');
  if (late !== undefined) return late;
  io.out(
    JSON.stringify(
      { ok: true, pr, cloud, signals, resolved: threads.resolved, duplicates: raw.length - signals.length, ...(findings ? { findings } : {}) },
      null,
      2,
    ),
  );
  return 0;
}
