import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import {
  CLOSED_EXIT,
  MERGED_EXIT,
  addCandidates,
  ciSignals,
  dedupe,
  excerpt,
  failureType,
  findingSignals,
  normalizeBody,
  prSignals,
  readFindings,
  signalArgs,
  signalSettings,
  threadSignals,
  type RawSignal,
} from './pr-signals.ts';
import { connection, nextCursor, restList } from './pages.ts';

const REPO = '/repos/example-org/example-app';
const HEAD = 'a'.repeat(40);

describe('signalArgs', () => {
  it('reads a pull request number, with --ci-only anywhere', () => {
    assert.deepEqual(signalArgs(['7']), { pr: 7, ciOnly: false });
    assert.deepEqual(signalArgs(['--ci-only', '#7']), { pr: 7, ciOnly: true });
  });

  for (const [args, message] of [
    [[], /needs a pull request number/],
    [['07'], /unexpected argument "07"/],
    [['7', '8'], /unexpected argument "8"/],
    [['7', '--ci-only', '--ci-only'], /unexpected argument "--ci-only"/],
  ] as const) {
    it(`refuses ${JSON.stringify(args)}`, () => assert.throws(() => signalArgs(args), message));
  }
});

describe('signalSettings', () => {
  it('reads the bots and findings file, and none named as none', () => {
    assert.deepEqual(signalSettings({ owner: 'o', agent: 'a' }), { bots: [] });
    assert.deepEqual(signalSettings(null), { bots: [] });
    assert.deepEqual(signalSettings({ signals: { bots: ['review-bot', 'other[bot]'], findings: '.tmp/review/findings.json' } }), {
      bots: ['review-bot', 'other[bot]'],
      findings: '.tmp/review/findings.json',
    });
    assert.deepEqual(signalSettings({ signals: {} }), { bots: [] });
  });

  for (const [signals, message] of [
    [[], /"signals" must be an object/],
    ['x', /"signals" must be an object/],
    [null, /"signals" must be an object/],
    [{ bot: [] }, /unknown key "bot"; it takes "bots" and "findings"/],
    [{ bots: 'review-bot' }, /bots must be a list of GitHub logins/],
    [{ bots: ['not a login'] }, /bots must be a list of GitHub logins/],
    [{ bots: [3] }, /bots must be a list of GitHub logins/],
    [{ findings: '/etc/passwd' }, /findings must be a path inside the repository/],
    [{ findings: '../x.json' }, /findings must be a path inside the repository/],
    [{ findings: '' }, /findings must be a path inside the repository/],
    [{ findings: 3 }, /findings must be a path inside the repository/],
  ] as const) {
    it(`refuses ${JSON.stringify(signals)}`, () => assert.throws(() => signalSettings({ signals }), message));
  }
});

describe('normalizeBody', () => {
  it('drops the markers that differ between where a finding was reported', () => {
    assert.equal(normalizeBody('[cubic] P1: The **limit**\n  is `wrong` severity: high'), 'the limit is wrong');
  });
});

const thread = (body: string, more: Partial<RawSignal> = {}): RawSignal => ({ source: 'review-thread', thread: 'PRRT_1', comment: 'PRRC_1', author: 'someone', file: 'src/a.ts', line: 3, body, ...more });
const local = (body: string, more: Partial<RawSignal> = {}): RawSignal => ({ source: 'local-findings', file: 'src/a.ts', line: 3, body, ...more });

describe('dedupe', () => {
  it('folds one concern at one line, keeping the thread, its sources and the severity', () => {
    const [one, ...rest] = dedupe([local('P1: Limit is wrong', { severity: 'P1' }), thread('limit is wrong')], []);
    assert.equal(rest.length, 0);
    assert.deepEqual(one, { ...thread('limit is wrong'), id: 'SIG-001', severity: 'P1', sources: ['local-findings', 'review-thread'] });
  });

  it("folds a bot's thread and the local finding at one line, worded differently", () => {
    const signals = dedupe([thread('The limit is off by one.', { author: 'review-bot[bot]' }), local('Off-by-one in the loop bound')], ['review-bot']);
    assert.deepEqual(
      signals.map((s) => [s.id, s.source, s.sources]),
      [['SIG-001', 'review-thread', ['review-thread', 'local-findings']]],
    );
  });

  it("keeps apart different findings: another line, a person's thread, a pull-request-level bot finding", () => {
    const signals = dedupe(
      [
        thread('a', { author: 'someone' }),
        local('b'),
        local('c', { line: 9 }),
        thread('d', { author: 'review-bot', file: null, line: null }),
        local('e', { file: null, line: null }),
        { source: 'review-thread', thread: 'PRRT_2', file: 'src/a.ts', line: 9, body: 'f' },
      ],
      ['review-bot'],
    );
    assert.deepEqual(
      signals.map((s) => s.id),
      ['SIG-001', 'SIG-002', 'SIG-003', 'SIG-004', 'SIG-005', 'SIG-006'],
    );
  });

  it('keeps the first of two findings with no thread, and the thread of the first when both have one', () => {
    const [kept] = dedupe([local('same'), { source: 'ci-failure', file: 'src/a.ts', line: 3, body: 'same', severity: 'x' }], []);
    assert.deepEqual([kept?.source, kept?.severity, kept?.thread], ['local-findings', 'x', undefined]);
    const [first] = dedupe([thread('same', { thread: 'PRRT_a' }), thread('same', { thread: 'PRRT_b' })], []);
    assert.equal(first?.thread, 'PRRT_a');
    const [carried] = dedupe([local('same'), thread('same', { thread: 'PRRT_c' }), local('same')], []);
    assert.deepEqual([carried?.thread, carried?.sources], ['PRRT_c', ['local-findings', 'review-thread']]);
  });
});

describe('addCandidates', () => {
  it('adds resolved threads nearby or alike, with the history of each file once', () => {
    const asked: string[] = [];
    const [near, alike, none] = addCandidates(
      dedupe([thread('a new concern here'), thread('the cache key misses the tenant id', { file: 'src/b.ts', line: 90 }), thread('unrelated', { file: null, line: null })], []),
      [
        { file: 'src/a.ts', line: 10, preview: 'something else entirely', createdAt: 't1' },
        { file: 'src/c.ts', line: 1, preview: 'cache key misses the tenant', createdAt: 't2' },
        { file: 'src/a.ts', line: 14, preview: 'too far away', createdAt: 't1' },
        { file: null, line: null, preview: 'short' },
      ],
      (file, since) => {
        asked.push(`${file}@${since}`);
        return file === 'src/c.ts' ? '' : 'diff --git a/src/a.ts';
      },
    );
    assert.deepEqual(near?.candidates, [{ file: 'src/a.ts', line: 10, preview: 'something else entirely', createdAt: 't1', matchedBy: 'proximity', diff: 'diff --git a/src/a.ts' }]);
    assert.deepEqual(alike?.candidates, [{ file: 'src/c.ts', line: 1, preview: 'cache key misses the tenant', createdAt: 't2', matchedBy: 'body' }]);
    assert.equal(none?.candidates, undefined);
    assert.deepEqual(asked, ['src/a.ts@t1', 'src/c.ts@t2']);
  });

  it('says both when a resolved thread is near and alike', () => {
    const [one] = addCandidates(dedupe([thread('the limit is wrong here')], []), [{ file: 'src/a.ts', line: 4, preview: 'the limit is wrong' }], () => '');
    assert.equal(one?.candidates?.[0]?.matchedBy, 'both');
  });
});

describe('readFindings', () => {
  it('tells a clean review from no review and from a failed one', () => {
    assert.deepEqual(readFindings(null), { status: 'absent', findings: [] });
    assert.deepEqual(readFindings('{"issues":[]}'), { status: 'ok', findings: [] });
    assert.deepEqual(readFindings('{}'), { status: 'ok', findings: [] });
    assert.deepEqual(readFindings('{"issues":[],"metadata":{"status":"failed","exit":137}}'), { status: 'failed', findings: [], reason: 'the review exited 137' });
    assert.deepEqual(readFindings('{"issues":[{"title":"t"}],"metadata":{"status":"failed","failureReason":"killed"}}'), { status: 'failed', findings: [{ title: 't' }], reason: 'killed' });
    assert.deepEqual(readFindings('{"metadata":{"status":"failed"}}'), { status: 'failed', findings: [], reason: 'the review exited non-zero' });
    assert.deepEqual(readFindings('not json'), { status: 'failed', findings: [], reason: 'the findings file is not JSON' });
  });
});

describe('findingSignals', () => {
  it("keeps the pull request's findings and drops another branch's", () => {
    assert.deepEqual(
      findingSignals(
        [
          { title: 'Limit', description: 'is wrong', file: 'src/a.ts', line: 3, priority: 'P1' },
          { title: 'Old', path: 'src/gone.ts', line: 1 },
          { title: 'Whole PR', severity: 'P3' },
          { title: 'Blank path', file: '  ' },
        ],
        new Set(['src/a.ts']),
      ),
      {
        kept: [
          { source: 'local-findings', file: 'src/a.ts', line: 3, body: 'Limit — is wrong', severity: 'P1' },
          { source: 'local-findings', file: null, line: null, body: 'Whole PR', severity: 'P3' },
          { source: 'local-findings', file: null, line: null, body: 'Blank path' },
        ],
        dropped: 1,
      },
    );
  });
});

describe('excerpt and failureType', () => {
  it('keeps the error lines of a log, 40 at most', () => {
    assert.equal(excerpt('ok\nerror TS2322: no\nall good\n✗ failed test'), 'error TS2322: no\n✗ failed test');
    assert.equal(excerpt(Array.from({ length: 50 }, (_, i) => `error ${i}`).join('\n')).split('\n').length, 40);
    assert.equal(excerpt('2026-11-14T17:05:17.9145970Z ✗ #32 names no slice\n2026-11-14T17:05:17Z fine'), '✗ #32 names no slice');
  });

  it('names the kind of failure', () => {
    assert.deepEqual(
      ['error TS2322', 'eslint: no-unused', 'vitest: 1 failed', 'build failed', 'exit 1'].map(failureType),
      ['typecheck', 'lint', 'test', 'build', 'other'],
    );
  });
});

describe('threadSignals', () => {
  it('makes open threads signals and keeps resolved ones to compare with, skipping a thread with no comment', () => {
    assert.deepEqual(
      threadSignals([
        { id: 'PRRT_1', resolved: false, first: { id: 'PRRC_1', author: 'bot', body: 'Fix it', path: 'a.ts', line: 2, createdAt: 't' } },
        { id: 'PRRT_2', resolved: true, first: { id: 'PRRC_2', body: 'x'.repeat(300), path: null, line: null } },
        { id: 'PRRT_3', resolved: false },
      ]),
      {
        signals: [{ source: 'review-thread', thread: 'PRRT_1', comment: 'PRRC_1', body: 'Fix it', file: 'a.ts', line: 2, author: 'bot', createdAt: 't' }],
        resolved: [{ file: null, line: null, preview: 'x'.repeat(200) }],
      },
    );
  });
});

describe('pages', () => {
  it('reads a connection to its end, and refuses one that would end it early or never', async () => {
    const pages = [
      { nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      { nodes: null, pageInfo: { hasNextPage: true, endCursor: 'c2' } },
      { nodes: [2], pageInfo: { hasNextPage: false } },
    ];
    const asked: (string | null)[] = [];
    assert.deepEqual(
      await connection('the list', async (after) => {
        asked.push(after);
        return pages[asked.length - 1] ?? {};
      }),
      [1, 2],
    );
    assert.deepEqual(asked, [null, 'c1', 'c2']);
    assert.throws(() => nextCursor(null, undefined, 'the list'), /the list: a page did not say whether more follow/);
    assert.throws(() => nextCursor(null, { hasNextPage: 'yes' }, 'the list'), /did not say whether more follow/);
    assert.throws(() => nextCursor(null, { hasNextPage: true, endCursor: '' }, 'the list'), /more follow but gives no cursor/);
    assert.throws(() => nextCursor('c1', { hasNextPage: true, endCursor: 'c1' }, 'the list'), /gave back the cursor just read/);
    await assert.rejects(connection('the list', async () => ({ nodes: [], pageInfo: { hasNextPage: true, endCursor: String(Math.random()) } }), 3), /the list: more than 3 pages/);
  });

  it('reads a REST list to a short page, under a key when asked, and refuses any other answer', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${REPO}/x?per_page=100&page=1`, { status: 200, json: Array.from({ length: 100 }, (_, i) => i) });
    sys.route('GET', `${REPO}/x?per_page=100&page=2`, { status: 200, json: [100] });
    assert.equal((await restList(sys, 't', 'repos/example-org/example-app/x')).length, 101);
    sys.route('GET', `${REPO}/y?a=1&per_page=100&page=1`, { status: 200, json: { runs: ['r'] } });
    assert.deepEqual(await restList(sys, 't', 'repos/example-org/example-app/y?a=1', 'runs'), ['r']);
    sys.route('GET', `${REPO}/z?per_page=100&page=1`, { status: 200, json: { runs: 'r' } });
    await assert.rejects(restList(sys, 't', 'repos/example-org/example-app/z', 'runs'), /cannot read repos\/example-org\/example-app\/z \(HTTP 200\)/);
    sys.route('GET', `${REPO}/z?per_page=100&page=1`, { status: 404, json: null });
    await assert.rejects(restList(sys, 't', 'repos/example-org/example-app/z'), /\(HTTP 404\)/);
    await assert.rejects(restList(sys, 't', 'repos/example-org/example-app/x', undefined, 1), /more than 1 pages/);
  });
});

/** A session reading pull request #7, open at HEAD, with what each test routes. */
function session(pull: Record<string, unknown> = {}): FakeSys {
  const sys = new FakeSys();
  sys.env = { NIYAM_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
  sys.route('GET', `${REPO}/pulls/7`, { status: 200, json: { state: 'open', merged_at: null, head: { sha: HEAD }, ...pull } });
  sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [] } });
  sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, { status: 200, json: { statuses: [] } });
  sys.route('GET', `${REPO}/pulls/7/files?per_page=100&page=1`, { status: 200, json: [{ filename: 'src/a.ts' }] });
  sys.route('POST', '/graphql', () => ({
    status: 200,
    json: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { id: 'PRRT_open', isResolved: false, comments: { nodes: [{ id: 'PRRC_open', author: { login: 'review-bot' }, body: 'The limit is off by one.', path: 'src/a.ts', line: 3, createdAt: '2026-11-14T00:00:00Z' }] } },
                { id: 'PRRT_done', isResolved: true, comments: { nodes: [{ id: 'PRRC_done', author: null, body: 'Rename it.', path: 'src/a.ts', originalLine: 8, createdAt: '2026-11-13T00:00:00Z' }] } },
                { id: 'PRRT_empty', isResolved: false, comments: { nodes: [] } },
                { id: 'PRRT_bare', isResolved: false },
              ],
            },
          },
        },
      },
    },
  }));
  sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, signals: { bots: ['review-bot'], findings: '.tmp/review/findings.json' } }));
  return sys;
}

async function run(sys: FakeSys, args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await prSignals(sys, io, args), out, err };
}

const parsed = (result: { out: string[] }): { signals: { id: string; source: string; sources: string[]; thread?: string; comment?: string; body: string; candidates?: unknown[] }[]; [key: string]: unknown } =>
  JSON.parse(result.out.join('\n')) as never;

describe('prSignals', () => {
  it("prints open threads, folding the bot's local copy into its thread, with resolved ones to compare with", async () => {
    const sys = session();
    sys.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [{ title: 'Off-by-one', file: 'src/a.ts', line: 3 }, { title: 'Stale', file: 'src/old.ts', line: 1 }] }));
    const result = await run(sys, ['7']);
    assert.equal(result.code, 0);
    const out = parsed(result);
    assert.deepEqual(
      out.signals.map((s) => [s.id, s.source, s.sources, s.thread, s.comment]),
      [['SIG-001', 'review-thread', ['review-thread', 'local-findings'], 'PRRT_open', 'PRRC_open']],
    );
    assert.deepEqual(out.resolved, [{ file: 'src/a.ts', line: 8, preview: 'Rename it.', createdAt: '2026-11-13T00:00:00Z' }]);
    assert.deepEqual([out.ok, out.pr, out.cloud, out.duplicates, out.findings], [true, 7, false, 1, { status: 'ok', droppedOffDiff: 1 }]);
    assert.equal(out.signals[0]?.candidates?.length, 1);
    assert.deepEqual(result.err, []);
    const query = sys.requests.find((r) => r.url.endsWith('/graphql'))?.body as { variables: Record<string, unknown> };
    assert.deepEqual(query.variables, { owner: 'example-org', name: 'example-app', pr: 7 });
  });

  it('refuses a merged pull request before reading anything, so a stale findings file makes no signal', async () => {
    const sys = session({ state: 'closed', merged_at: '2026-11-14T01:00:00Z' });
    sys.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [{ title: 'Stale', file: 'src/a.ts', line: 3 }] }));
    const result = await run(sys, ['7']);
    assert.equal(result.code, MERGED_EXIT);
    assert.deepEqual(result.err, ['✗ #7 merged at 2026-11-14T01:00:00Z; nothing to answer']);
    assert.deepEqual(parsed(result), { ok: false, reason: 'pr-not-open', pr: 7, state: 'MERGED', mergedAt: '2026-11-14T01:00:00Z', phase: 'start' } as never);
    assert.deepEqual(
      sys.requests.map((r) => r.url),
      [`https://api.github.com${REPO}/pulls/7`],
    );
  });

  it('refuses a closed pull request, and one that merged while its signals were read', async () => {
    const closed = await run(session({ state: 'closed' }), ['7']);
    assert.deepEqual([closed.code, closed.err], [CLOSED_EXIT, ['✗ #7 is closed without merging; nothing to answer']]);
    const sys = session();
    let reads = 0;
    sys.route('GET', `${REPO}/pulls/7`, () => ({ status: 200, json: { state: reads++ ? 'closed' : 'open', merged_at: reads > 1 ? '2026-11-14T02:00:00Z' : null, head: { sha: HEAD } } }));
    const late = await run(sys, ['7']);
    assert.equal(late.code, MERGED_EXIT);
    assert.deepEqual(late.err, ['✗ #7 merged at 2026-11-14T02:00:00Z; nothing to answer (it changed while the signals were read)']);
    assert.equal((parsed(late) as { phase?: string }).phase, 'before-print');
  });

  it('refuses a page of threads that says more follow but gives no cursor', async () => {
    const sys = session();
    sys.route('POST', '/graphql', { status: 200, json: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } } } });
    await assert.rejects(run(sys, ['7']), /the review threads of #7: a page says more follow but gives no cursor/);
  });

  it('throws when GitHub cannot show the pull request or its threads', async () => {
    const none = session();
    none.route('GET', `${REPO}/pulls/7`, { status: 404, json: null });
    await assert.rejects(run(none, ['7']), /cannot read pull request #7 in example-org\/example-app \(HTTP 404\)/);
    const missing = session();
    missing.route('POST', '/graphql', { status: 200, json: { data: { repository: { pullRequest: null } } } });
    await assert.rejects(run(missing, ['7']), /GitHub shows no pull request #7 in example-org\/example-app/);
    const refused = session();
    refused.route('POST', '/graphql', { status: 200, json: { data: null, errors: [{ message: 'Bad credentials' }] } });
    await assert.rejects(run(refused, ['7']), /GitHub refused to read the review threads of #7 \(HTTP 200: Bad credentials\)/);
    const forbidden = session();
    forbidden.route('POST', '/graphql', { status: 403, json: null });
    await assert.rejects(run(forbidden, ['7']), /\(HTTP 403\)$/);
  });

  it('says a failed local review failed, never that it found nothing', async () => {
    const sys = session();
    sys.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [], metadata: { status: 'failed', exit: 137 } }));
    const result = await run(sys, ['7']);
    assert.deepEqual(parsed(result).findings, { status: 'failed', reason: 'the review exited 137' });
    assert.deepEqual(result.err, ["⚠ the local review failed (the review exited 137): its findings are missing, so lean on the bots' threads"]);
    assert.ok(!sys.requests.some((r) => r.url.includes('/files')));
  });

  it('reads no findings file when none is there or the settings name none', async () => {
    assert.deepEqual(parsed(await run(session(), ['7'])).findings, { status: 'absent' });
    const unnamed = session();
    unnamed.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    assert.equal(parsed(await run(unnamed, ['7'])).findings, undefined);
    const bare = session();
    bare.files.delete(`${ROOT}/.github/niyam.json`);
    assert.equal((await run(bare, ['7'])).code, 0);
  });

  it('with --ci-only reads the checks alone', async () => {
    const sys = session();
    sys.files.set(`${ROOT}/.tmp/review/findings.json`, JSON.stringify({ issues: [{ title: 'x', file: 'src/a.ts', line: 1 }] }));
    const out = parsed(await run(sys, ['7', '--ci-only']));
    assert.deepEqual([out.signals, out.resolved, out.findings], [[], [], undefined]);
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql')));
  });

  it('cuts a long file history short', async () => {
    const sys = session();
    sys.execOverride = (call) => (call.command === 'git' && call.args[0] === 'log' ? { code: 0, stdout: 'x'.repeat(5000), stderr: '' } : undefined);
    sys.route('POST', '/graphql', {
      status: 200,
      json: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { id: 'PRRT_open', isResolved: false, comments: { nodes: [{ id: 'PRRC_open', body: 'Near.', path: 'src/a.ts', line: 3 }] } },
                  { id: 'PRRT_done', isResolved: true, comments: { nodes: [{ id: 'PRRC_done', body: 'Old.', path: 'src/a.ts', line: 4, createdAt: 't' }] } },
                ],
              },
            },
          },
        },
      },
    });
    const [candidate] = (parsed(await run(sys, ['7'])).signals[0]?.candidates ?? []) as { diff?: string }[];
    assert.equal(candidate?.diff, `${'x'.repeat(4000)}\n…[cut]`);
    sys.execOverride = (call) => (call.command === 'git' && call.args[0] === 'log' ? { code: 128, stdout: '', stderr: 'bad' } : undefined);
    const [none] = (parsed(await run(sys, ['7'])).signals[0]?.candidates ?? []) as { diff?: string }[];
    assert.equal(none?.diff, undefined);
  });

  it('refuses a session with no token', async () => {
    const sys = session();
    delete sys.env.GH_TOKEN;
    assert.deepEqual(await run(sys, ['7']), { code: 1, out: [], err: ['✗ this session has no token; run niyam doctor'] });
  });
});

describe('ciSignals', () => {
  it("gives each failing check's error lines, from its job's log when GitHub Actions ran it", async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: {
        check_runs: [
          { id: 11, name: 'ci / test', conclusion: 'failure', app: { slug: 'github-actions' } },
          { id: 12, name: 'ci / lint', conclusion: 'success', app: { slug: 'github-actions' } },
          { id: 13, name: 'Cubic', conclusion: 'failure', app: { slug: 'cubic' }, output: { title: 'Review failed', summary: '' } },
          { id: 14, name: 'ci / build', conclusion: 'timed_out', app: { slug: 'github-actions' } },
          { id: 15, name: 'ci / pending', conclusion: null, app: { slug: 'github-actions' } },
        ],
      },
    });
    sys.route('GET', `${REPO}/actions/jobs/11/logs`, { status: 200, json: null, text: 'setup\nerror TS2322: wrong type\ndone' });
    sys.route('GET', `${REPO}/actions/jobs/14/logs`, { status: 410, json: null });
    sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, {
      status: 200,
      json: { statuses: [{ context: 'deploy', state: 'error', description: 'build failed' }, { context: 'other', state: 'success' }] },
    });
    assert.deepEqual(await ciSignals(sys, 't', 'example-org/example-app', HEAD), [
      { source: 'ci-failure', check: 'ci / test', file: null, line: null, body: 'error TS2322: wrong type', failureType: 'typecheck' },
      { source: 'ci-failure', check: 'Cubic', file: null, line: null, body: 'Cubic: failure\nReview failed', failureType: 'other' },
      { source: 'ci-failure', check: 'ci / build', file: null, line: null, body: 'ci / build: timed_out', failureType: 'build' },
      { source: 'ci-failure', check: 'deploy', file: null, line: null, body: 'deploy: error\nbuild failed', failureType: 'build' },
    ]);
    assert.equal(sys.requests.find((r) => r.url.endsWith('/jobs/11/logs'))?.token, 't');
  });

  it('never lets a pass of the same name hide a failure, and folds one failure reported twice', async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, {
      status: 200,
      json: {
        check_runs: [
          { id: 21, name: 'Work rules', conclusion: 'failure', app: { slug: 'github-actions' } },
          { id: 22, name: 'Work rules', conclusion: 'failure', app: { slug: 'github-actions' } },
          { id: 23, name: 'Work rules', conclusion: 'success', app: { slug: 'github-actions' } },
        ],
      },
    });
    sys.route('GET', `${REPO}/actions/jobs/21/logs`, { status: 200, json: null, text: '2026-11-14T17:05:12.8364488Z ✗ #7 names no slice' });
    sys.route('GET', `${REPO}/actions/jobs/22/logs`, { status: 200, json: null, text: '2026-11-14T17:05:17.9145970Z ✗ #7 names no slice' });
    const failures = await ciSignals(sys, 't', 'example-org/example-app', HEAD);
    assert.deepEqual(
      failures.map((s) => s.body),
      ['✗ #7 names no slice', '✗ #7 names no slice'],
    );
    assert.equal(dedupe(failures, []).length, 1);
  });

  it('keeps the name when a log has no error lines, and refuses a check it cannot read', async () => {
    const sys = session();
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [{ id: 11, name: 'ci', conclusion: 'cancelled', app: { slug: 'github-actions' } }] } });
    sys.route('GET', `${REPO}/actions/jobs/11/logs`, { status: 200, json: null });
    assert.deepEqual((await ciSignals(sys, 't', 'example-org/example-app', HEAD)).map((s) => s.body), ['ci: cancelled']);
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [{ name: 'no id' }] } });
    await assert.rejects(ciSignals(sys, 't', 'example-org/example-app', HEAD), /lists a check run with no id or name/);
    sys.route('GET', `${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`, { status: 200, json: { check_runs: [] } });
    sys.route('GET', `${REPO}/commits/${HEAD}/status?per_page=100&page=1`, { status: 200, json: { statuses: [{ context: 'x' }] } });
    await assert.rejects(ciSignals(sys, 't', 'example-org/example-app', HEAD), /lists a status with no name or state/);
  });
});

describe('prSignals in a Claude cloud session', () => {
  /** The proxy's routes for #7: thread 123 open with a reply, 130 resolved, 140 whose comment is gone. */
  function cloud(): FakeSys {
    const sys = session();
    sys.env.CLAUDE_CODE_REMOTE = 'true';
    sys.route('POST', '/graphql', { status: 403, json: { message: 'GraphQL is refused' } });
    sys.route('GET', `${REPO}/pulls/7/comments?per_page=100&page=1`, {
      status: 200,
      json: [
        { id: 123, user: { login: 'review-bot[bot]' }, body: 'The limit is off by one.', path: 'src/a.ts', original_line: 3, created_at: '2026-11-14T00:00:00Z' },
        { id: 124, in_reply_to_id: 123, user: { login: AGENT }, body: 'Looking.' },
        { id: 130, body: 'Rename it.', path: 'src/a.ts', line: 30 },
      ],
    });
    sys.route('GET', `${REPO}/pulls/7/ccr/review_threads`, {
      status: 200,
      json: [
        { resolved: false, comment_ids: [123, 124] },
        { resolved: true, comment_ids: [130] },
        { resolved: false, comment_ids: [140] },
      ],
    });
    return sys;
  }

  it("reads the threads over the proxy's REST routes, naming each by its first comment's number", async () => {
    const sys = cloud();
    const out = parsed(await run(sys, ['7']));
    assert.equal(out.cloud, true);
    assert.deepEqual(
      out.signals.map((s) => [s.source, s.thread, s.comment, s.body]),
      [['review-thread', '123', '123', 'The limit is off by one.']],
    );
    assert.deepEqual(out.resolved, [{ file: 'src/a.ts', line: 30, preview: 'Rename it.' }]);
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql')));
  });

  it('refuses a thread list or comment it cannot read', async () => {
    const bad = cloud();
    bad.route('GET', `${REPO}/pulls/7/ccr/review_threads`, { status: 200, json: [{ resolved: false, comment_ids: [] }] });
    await assert.rejects(run(bad, ['7']), /ccr\/review_threads lists a thread it does not name/);
    const down = cloud();
    down.route('GET', `${REPO}/pulls/7/ccr/review_threads`, { status: 502, json: null });
    await assert.rejects(run(down, ['7']), /cannot read repos\/example-org\/example-app\/pulls\/7\/ccr\/review_threads \(HTTP 502\)/);
    const nameless = cloud();
    nameless.route('GET', `${REPO}/pulls/7/comments?per_page=100&page=1`, { status: 200, json: [{ body: 'no id' }] });
    await assert.rejects(run(nameless, ['7']), /a review comment on #7 has no id/);
  });
});
