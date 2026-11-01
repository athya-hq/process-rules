import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { expireVetoes, reviewsDue, watchReviews } from './reviews.ts';

const SLUG = 'example-org/example-app';
const DECISIONS = `/repos/${SLUG}/issues?state=open&type=Decision&per_page=100`;

const issue = (number: number, body: string | null, labels: string[] = [], author = 'example-owner') => ({
  number,
  node_id: `I_${number}`,
  user: { login: author },
  title: `Decision ${number}`,
  body,
  html_url: `https://github.com/${SLUG}/issues/${number}`,
  labels: labels.map((name) => ({ name })),
});

describe('reviewsDue', () => {
  function session(page1: unknown[], page2?: unknown[], editors: Record<number, string> = {}): FakeSys {
    const sys = new FakeSys();
    sys.env = { GH_TOKEN: 'ghp_good' };
    sys.route('GET', `${DECISIONS}&page=1`, { status: 200, json: page1 });
    if (page2) sys.route('GET', `${DECISIONS}&page=2`, { status: 200, json: page2 });
    sys.route('POST', '/graphql', () => {
      const ids = ((sys.requests.at(-1)?.body as { variables: { ids: string[] } }).variables.ids);
      const nodes = ids.map((id) => {
        const number = Number(id.slice(2));
        return { number, editor: editors[number] ? { login: editors[number] } : null };
      });
      return { status: 200, json: { data: { nodes } } };
    });
    return sys;
  }

  it('prints each decision whose review date has come, as a JSON line', async () => {
    const sys = session([
      issue(5, 'Kind: Bet\nReview: 2026-10-30', ['mechanical']),
      issue(6, 'Kind: Risk\nReview: 2026-11-30'),
      issue(7, 'No fields'),
      issue(8, null),
    ]);
    const { io, out, err } = capture();
    assert.equal(await reviewsDue(sys, io), 0);
    assert.deepEqual(out.map((line) => JSON.parse(line)), [
      { number: 5, title: 'Decision 5', url: `https://github.com/${SLUG}/issues/5`, kind: 'Bet', review: '2026-10-30', labels: ['mechanical'], body: 'Kind: Bet\nReview: 2026-10-30' },
    ]);
    assert.deepEqual(err, ['reviews-due: 1 decision due for review on 2026-10-30']);
    assert.equal(sys.requests[0]?.token, 'ghp_good');
  });

  it("leaves out decisions someone else wrote or edited, or that wait on the owner", async () => {
    const sys = session(
      [
        issue(5, 'Review: 2026-10-01', [], 'mallory'),
        issue(6, 'Review: 2026-10-01'),
        issue(7, 'Review: 2026-10-01', ['veto']),
        issue(8, 'Review: 2026-10-01', ['needs-owner']),
        { ...issue(9, 'Review: 2026-10-01'), user: null },
        issue(10, 'Review: 2026-10-01', [], 'ExampleBot'),
      ],
      undefined,
      { 6: 'mallory' },
    );
    sys.route('GET', `/repos/${SLUG}/issues/8/events?per_page=100&page=1`, { status: 200, json: [] });
    const { io, out, err } = capture();
    await reviewsDue(sys, io);
    assert.deepEqual(out.map((line) => JSON.parse(line).number), [10]);
    assert.deepEqual(err, [
      '#5: not reviewed; only example-owner or ExampleBot may write a decision the routine reviews',
      '#6: not reviewed; only example-owner or ExampleBot may write a decision the routine reviews',
      '#9: not reviewed; only example-owner or ExampleBot may write a decision the routine reviews',
      'reviews-due: 1 decision due for review on 2026-10-30',
    ]);
  });

  it('with two owners and two agents, reviews a decision any of them wrote and last edited, and no one else\'s', async () => {
    const sys = session([issue(5, 'Review: 2026-10-01', [], 'Second-Owner'), issue(6, 'Review: 2026-10-01', [], 'OtherBot'), issue(7, 'Review: 2026-10-01', [], 'mallory')], undefined, { 5: 'otherbot', 6: 'second-owner' });
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: ['example-owner', 'Second-Owner'], agent: [AGENT, 'OtherBot'] }));
    const { io, out, err } = capture();
    assert.equal(await reviewsDue(sys, io), 0);
    assert.deepEqual(out.map((line) => (JSON.parse(line) as { number: number }).number), [5, 6]);
    assert.equal(err[0], '#7: not reviewed; only example-owner, Second-Owner, ExampleBot or OtherBot may write a decision the routine reviews');
  });

  it('lists a decision the weekly job labeled for want of a verdict, until the agent answers it', async () => {
    const sys = session([
      issue(5, 'Review: 2026-10-01', ['needs-owner']),
      issue(6, 'Review: 2026-10-01', ['needs-owner']),
      issue(7, 'Review: 2026-10-01', ['needs-owner', 'veto']),
      issue(8, 'Review: 2026-10-01', ['needs-owner']),
    ]);
    const byJob = [{ event: 'labeled', label: { name: 'needs-owner' }, actor: { login: 'github-actions[bot]' }, created_at: '2026-10-09T00:00:00Z' }];
    sys.route('GET', `/repos/${SLUG}/issues/5/events?per_page=100&page=1`, { status: 200, json: byJob });
    sys.route('GET', `/repos/${SLUG}/issues/6/events?per_page=100&page=1`, { status: 200, json: byJob });
    sys.route('GET', `/repos/${SLUG}/issues/8/events?per_page=100&page=1`, { status: 200, json: [{ ...byJob[0], actor: { login: 'example-owner' } }] });
    sys.route('GET', `/repos/${SLUG}/issues/5/comments?per_page=100&page=1`, {
      status: 200,
      json: [
        { body: 'Held for example-owner: before the job', user: { login: AGENT }, created_at: '2026-10-08T00:00:00Z' },
        { body: 'Kept: says mallory', user: { login: 'mallory' }, created_at: '2026-10-10T00:00:00Z' },
      ],
    });
    sys.route('GET', `/repos/${SLUG}/issues/6/comments?per_page=100&page=1`, {
      status: 200,
      json: [{ body: 'Held for example-owner: it touches billing', user: { login: AGENT }, created_at: '2026-10-16T00:00:00Z' }],
    });
    const { io, out } = capture();
    await reviewsDue(sys, io);
    assert.deepEqual(out.map((line) => JSON.parse(line).number), [5]);
  });

  it('reads who edited the decisions 100 at a time', async () => {
    const many = Array.from({ length: 100 }, (_, i) => issue(100 + i, 'Review: 2027-01-01'));
    const sys = session(many, [issue(9, 'Review: 2026-01-01')]);
    await reviewsDue(sys, capture().io);
    const lookups = sys.requests.filter((r) => r.url.endsWith('/graphql')).map((r) => (r.body as { variables: { ids: string[] } }).variables.ids.length);
    assert.deepEqual(lookups, [100, 1]);
  });

  it('names a Review date that is not a date', async () => {
    const { io, err } = capture();
    await reviewsDue(session([issue(5, 'Review: next week'), issue(6, 'Review: 2026-13-45')]), io);
    assert.deepEqual(err.slice(0, 2), [
      '#5: its Review date "next week" is not YYYY-MM-DD; fix it so the decision can come up',
      '#6: its Review date "2026-13-45" is not YYYY-MM-DD; fix it so the decision can come up',
    ]);
  });

  it('reads every page, and names a decision with no kind', async () => {
    const many = Array.from({ length: 100 }, (_, i) => issue(100 + i, 'Review: 2027-01-01'));
    const sys = session(many, [issue(9, 'Review: 2026-01-01')]);
    const { io, out, err } = capture();
    await reviewsDue(sys, io);
    assert.equal(JSON.parse(out[0] ?? '{}').kind, null);
    assert.deepEqual(err, ['reviews-due: 1 decision due for review on 2026-10-30']);
  });

  it('counts in the plural', async () => {
    const { io, err } = capture();
    await reviewsDue(session([]), io);
    assert.deepEqual(err, ['reviews-due: 0 decisions due for review on 2026-10-30']);
  });

  it('needs the agent token, and GitHub', async () => {
    await assert.rejects(reviewsDue(new FakeSys(), capture().io), /reviews-due needs GH_TOKEN/);
    const sys = session([]);
    sys.route('GET', `${DECISIONS}&page=1`, { status: 401, json: null });
    await assert.rejects(reviewsDue(sys, capture().io), /cannot list open decisions \(HTTP 401\)/);
  });
});

describe('expireVetoes', () => {
  const VETOED = `/repos/${SLUG}/issues?state=all&type=Decision&labels=veto&per_page=100&page=1`;
  const events = (number: number, at: string) => [
    { event: 'labeled', label: { name: 'veto' }, created_at: '2026-01-01T00:00:00Z' },
    { event: 'labeled', label: { name: 'needs-owner' }, created_at: at },
    { event: 'commented', created_at: at },
    { event: 'labeled', label: { name: 'veto' }, created_at: at },
  ].map((event) => ({ ...event, issue: number }));

  function github(): FakeSys {
    const sys = new FakeSys();
    sys.route('GET', VETOED, { status: 200, json: [issue(5, ''), issue(6, ''), issue(7, '')] });
    sys.route('GET', `/repos/${SLUG}/issues/5/events?per_page=100&page=1`, { status: 200, json: events(5, '2026-10-20T00:00:00Z') });
    sys.route('GET', `/repos/${SLUG}/issues/6/events?per_page=100&page=1`, { status: 200, json: events(6, '2026-10-28T00:00:00Z') });
    sys.route('GET', `/repos/${SLUG}/issues/7/events?per_page=100&page=1`, { status: 200, json: [] });
    sys.route('DELETE', `/repos/${SLUG}/issues/5/labels/veto`, { status: 200, json: [] });
    return sys;
  }

  it('removes veto once its week has passed, and only then', async () => {
    const sys = github();
    const { io, out } = capture();
    await expireVetoes(sys, io, SLUG, 'ghs_run');
    assert.deepEqual(out, ['#5: the week to veto has passed; removed veto']);
    assert.deepEqual(sys.requests.filter((r) => r.method === 'DELETE').map((r) => [r.url, r.token]), [
      [`https://api.github.com/repos/${SLUG}/issues/5/labels/veto`, 'ghs_run'],
    ]);
  });

  it('reads every page of vetoed decisions and of their events', async () => {
    const sys = github();
    sys.route('GET', VETOED, { status: 200, json: Array.from({ length: 100 }, (_, i) => issue(200 + i, '')) });
    for (let i = 0; i < 100; i++) sys.route('GET', `/repos/${SLUG}/issues/${200 + i}/events?per_page=100&page=1`, { status: 200, json: [] });
    sys.route('GET', VETOED.replace('&page=1', '&page=2'), { status: 200, json: [issue(5, '')] });
    const busy = Array.from({ length: 100 }, () => ({ event: 'commented', created_at: '2026-10-29T00:00:00Z' }));
    sys.route('GET', `/repos/${SLUG}/issues/5/events?per_page=100&page=1`, { status: 200, json: busy });
    sys.route('GET', `/repos/${SLUG}/issues/5/events?per_page=100&page=2`, { status: 200, json: events(5, '2026-10-20T00:00:00Z') });
    const { io, out } = capture();
    await expireVetoes(sys, io, SLUG, 'ghs_run');
    assert.deepEqual(out, ['#5: the week to veto has passed; removed veto']);
  });

  for (const [name, change, message] of [
    ['listing', (sys: FakeSys) => sys.route('GET', VETOED, { status: 500, json: null }), /cannot list vetoable decisions \(HTTP 500\)/],
    ['reading events', (sys: FakeSys) => sys.route('GET', `/repos/${SLUG}/issues/5/events?per_page=100&page=1`, { status: 404, json: null }), /cannot read #5's events \(HTTP 404\)/],
    ['removing', (sys: FakeSys) => sys.route('DELETE', `/repos/${SLUG}/issues/5/labels/veto`, { status: 403, json: null }), /cannot remove veto from #5 \(HTTP 403\)/],
  ] as const) {
    it(`throws when ${name} fails`, async () => {
      const sys = github();
      change(sys);
      await assert.rejects(expireVetoes(sys, capture().io, SLUG, 'ghs_run'), message);
    });
  }
});

describe('watchReviews', () => {
  const OPEN = `/repos/${SLUG}/issues?state=open&type=Decision&per_page=100&page=1`;
  const FLAGGED = `/repos/${SLUG}/issues?state=all&type=Decision&labels=needs-owner&per_page=100&page=1`;
  const SETTINGS = { owners: ['example-owner'], agents: [AGENT] };
  const comment = (login: string, body: string, at: string) => ({ body, user: { login }, created_at: at });
  const labeled = (login: string, at: string) => [
    { event: 'labeled', label: { name: 'veto' }, actor: { login: 'github-actions[bot]' }, created_at: '2026-10-29T00:00:00Z' },
    { event: 'labeled', label: { name: 'needs-owner' }, actor: { login }, created_at: at },
  ];

  function github(open: unknown[], flagged: unknown[] = [], comments: Record<number, unknown[]> = {}, events: Record<number, unknown[]> = {}, editors: Record<number, string> = {}): FakeSys {
    const sys = new FakeSys();
    sys.route('GET', OPEN, { status: 200, json: open });
    sys.route('GET', FLAGGED, { status: 200, json: flagged });
    for (const [number, list] of Object.entries(comments)) sys.route('GET', `/repos/${SLUG}/issues/${number}/comments?per_page=100&page=1`, { status: 200, json: list });
    for (const [number, list] of Object.entries(events)) sys.route('GET', `/repos/${SLUG}/issues/${number}/events?per_page=100&page=1`, { status: 200, json: list });
    for (const one of [...open, ...flagged] as { number: number }[]) {
      sys.route('POST', `/repos/${SLUG}/issues/${one.number}/labels`, { status: 200, json: [] });
      sys.route('POST', `/repos/${SLUG}/issues/${one.number}/comments`, { status: 201, json: {} });
      sys.route('DELETE', `/repos/${SLUG}/issues/${one.number}/labels/needs-owner`, { status: 200, json: [] });
    }
    sys.route('POST', '/graphql', () => {
      const ids = (sys.requests.at(-1)?.body as { variables: { ids: string[] } }).variables.ids;
      return { status: 200, json: { data: { nodes: ids.map((id) => ({ number: Number(id.slice(2)), editor: editors[Number(id.slice(2))] ? { login: editors[Number(id.slice(2))] } : null })) } } };
    });
    return sys;
  }

  const written = (sys: FakeSys) => sys.requests.filter((r) => r.method !== 'GET' && !r.url.endsWith('/graphql')).map((r) => `${r.method} ${r.url.replace(`https://api.github.com/repos/${SLUG}`, '')}`);

  it('labels needs-owner a decision over a week past its review with no verdict from the agent since', async () => {
    const sys = github(
      [
        issue(5, 'Review: 2026-10-20'),
        issue(6, 'Review: 2026-10-20'),
        issue(7, 'Review: 2026-10-20'),
        issue(8, 'Review: 2026-10-25'),
        issue(9, 'Review: 2026-10-23'),
        issue(10, 'Review: 2026-10-01', ['veto']),
        issue(11, 'Review: 2026-10-01', ['needs-owner']),
        issue(12, 'Review: 2026-10-01', [], 'mallory'),
        issue(13, 'Review: 2026-10-01'),
        issue(14, 'Review: someday'),
        issue(15, 'Review: 2026-13-45'),
        issue(16, 'No review'),
      ],
      [],
      {
        5: [],
        6: [comment(AGENT, 'Kept: checked the config. Next review: 2026-12-01.', '2026-10-21T09:00:00Z')],
        7: [comment('mallory', 'Kept: trust me', '2026-10-21T09:00:00Z'), comment(AGENT, 'Settled: an old review', '2026-10-01T00:00:00Z'), comment(AGENT, 'Held for example-owner: money', '2026-10-22T00:00:00Z')],
      },
      {},
      { 13: 'mallory' },
    );
    const { io, out } = capture();
    await watchReviews(sys, io, SLUG, 'ghs_run', SETTINGS);
    assert.deepEqual(out, [
      '#5: its review, 2026-10-20, is over a week past with no verdict from the agent; labeled needs-owner',
      '#7: its review, 2026-10-20, is over a week past with no verdict from the agent; labeled needs-owner',
    ]);
    assert.deepEqual(written(sys), ['POST /issues/5/labels', 'POST /issues/5/comments', 'POST /issues/7/labels', 'POST /issues/7/comments']);
    const told = sys.requests.find((r) => r.url.endsWith('/issues/5/comments') && r.method === 'POST')?.body as { body: string };
    assert.equal(
      told.body,
      'Review overdue: its review date, 2026-10-20, is over a week past, and ExampleBot has written no `Kept:` or `Settled:` on it since. Check that the review routine exists and runs as ExampleBot. This label goes once its verdict comes.',
    );
    assert.equal(sys.requests.find((r) => r.method === 'POST')?.token, 'ghs_run');
  });

  it('reads no editors or comments when nothing is overdue', async () => {
    const sys = github([issue(8, 'Review: 2026-10-25')]);
    await watchReviews(sys, capture().io, SLUG, 'ghs_run', SETTINGS);
    assert.deepEqual(sys.requests.map((r) => r.url.replace(`https://api.github.com/repos/${SLUG}`, '')), [
      '/issues?state=all&type=Decision&labels=needs-owner&per_page=100&page=1',
      '/issues?state=open&type=Decision&per_page=100&page=1',
    ]);
  });

  it('takes off the label it added once the agent gives a verdict, and leaves anyone else\'s', async () => {
    const sys = github(
      [issue(21, 'Review: 2026-10-01', ['needs-owner']), issue(22, 'Review: 2026-10-01', ['needs-owner'])],
      [issue(20, 'Review: 2026-10-01', ['needs-owner']), issue(21, 'Review: 2026-10-01', ['needs-owner']), issue(22, 'Review: 2026-10-01', ['needs-owner']), issue(23, '', ['needs-owner']), issue(24, '', ['needs-owner'])],
      {
        20: [comment(AGENT, 'Settled: carried out in #30.', '2026-10-25T00:00:00Z')],
        21: [comment('mallory', 'Settled: done', '2026-10-25T00:00:00Z'), comment(AGENT, 'Held for example-owner: money', '2026-10-26T00:00:00Z')],
        22: [comment(AGENT, 'Kept: reviewed again. Next review: 2027-01-01.', '2026-10-25T00:00:00Z')],
        23: [comment(AGENT, 'Kept: before the label', '2026-10-01T00:00:00Z')],
      },
      {
        20: labeled('github-actions[bot]', '2026-10-09T00:00:00Z'),
        21: labeled('github-actions[bot]', '2026-10-09T00:00:00Z'),
        22: labeled('example-owner', '2026-10-09T00:00:00Z'),
        23: labeled('github-actions[bot]', '2026-10-09T00:00:00Z'),
        24: [],
      },
    );
    const { io, out } = capture();
    await watchReviews(sys, io, SLUG, 'ghs_run', SETTINGS);
    assert.deepEqual(out, ['#20: the review routine gave its verdict; removed needs-owner']);
    assert.deepEqual(written(sys), ['DELETE /issues/20/labels/needs-owner']);
  });

  it('labels again, in the same run, a decision whose label it took off but is still overdue', async () => {
    const sys = github(
      [issue(20, 'Review: 2026-10-20', ['needs-owner'])],
      [issue(20, 'Review: 2026-10-20', ['needs-owner'])],
      { 20: [comment(AGENT, 'Kept: but the date was not moved', '2026-10-18T00:00:00Z')] },
      { 20: labeled('github-actions[bot]', '2026-10-10T00:00:00Z') },
    );
    const { io, out } = capture();
    await watchReviews(sys, io, SLUG, 'ghs_run', SETTINGS);
    assert.deepEqual(out, [
      '#20: the review routine gave its verdict; removed needs-owner',
      '#20: its review, 2026-10-20, is over a week past with no verdict from the agent; labeled needs-owner',
    ]);
  });

  for (const [name, change, message] of [
    ['listing flagged decisions', (sys: FakeSys) => sys.route('GET', FLAGGED, { status: 500, json: null }), /cannot list decisions waiting on the owner \(HTTP 500\)/],
    ['listing open decisions', (sys: FakeSys) => sys.route('GET', OPEN, { status: 500, json: null }), /cannot list open decisions \(HTTP 500\)/],
    ['reading comments', (sys: FakeSys) => sys.route('GET', `/repos/${SLUG}/issues/5/comments?per_page=100&page=1`, { status: 404, json: null }), /cannot read #5's comments \(HTTP 404\)/],
    ['labeling', (sys: FakeSys) => sys.route('POST', `/repos/${SLUG}/issues/5/labels`, { status: 403, json: null }), /cannot label #5 needs-owner \(HTTP 403\)/],
    ['commenting', (sys: FakeSys) => sys.route('POST', `/repos/${SLUG}/issues/5/comments`, { status: 403, json: null }), /cannot comment on #5 \(HTTP 403\)/],
    ['removing the label', (sys: FakeSys) => sys.route('DELETE', `/repos/${SLUG}/issues/20/labels/needs-owner`, { status: 403, json: null }), /cannot remove needs-owner from #20 \(HTTP 403\)/],
  ] as const) {
    it(`throws when ${name} fails`, async () => {
      const sys = github(
        [issue(5, 'Review: 2026-10-01')],
        [issue(20, '', ['needs-owner'])],
        { 5: [], 20: [comment(AGENT, 'Settled: done', '2026-10-25T00:00:00Z')] },
        { 20: labeled('github-actions[bot]', '2026-10-09T00:00:00Z') },
      );
      change(sys);
      await assert.rejects(watchReviews(sys, capture().io, SLUG, 'ghs_run', SETTINGS), message);
    });
  }
});
