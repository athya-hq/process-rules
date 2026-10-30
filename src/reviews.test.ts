import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSys, capture } from './fake.test.ts';
import { expireVetoes, reviewsDue } from './reviews.ts';

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
  const VETOED = `/repos/${SLUG}/issues?state=all&labels=veto&per_page=100&page=1`;
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
