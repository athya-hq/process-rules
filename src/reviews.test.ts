import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSys, capture } from './fake.test.ts';
import { expireVetoes, reviewsDue } from './reviews.ts';

const SLUG = 'example-org/example-app';
const DECISIONS = `/repos/${SLUG}/issues?state=open&type=Decision&per_page=100`;

const issue = (number: number, body: string | null, labels: string[] = []) => ({
  number,
  title: `Decision ${number}`,
  body,
  html_url: `https://github.com/${SLUG}/issues/${number}`,
  labels: labels.map((name) => ({ name })),
});

describe('reviewsDue', () => {
  function session(page1: unknown[], page2?: unknown[]): FakeSys {
    const sys = new FakeSys();
    sys.env = { GH_TOKEN: 'ghp_good' };
    sys.route('GET', `${DECISIONS}&page=1`, { status: 200, json: page1 });
    if (page2) sys.route('GET', `${DECISIONS}&page=2`, { status: 200, json: page2 });
    return sys;
  }

  it('prints each decision whose review date has come, as a JSON line', async () => {
    const sys = session([
      issue(5, 'Kind: Bet\nReview: 2026-10-30', ['veto']),
      issue(6, 'Kind: Risk\nReview: 2026-11-30'),
      issue(7, 'No fields'),
      issue(8, null),
    ]);
    const { io, out, err } = capture();
    assert.equal(await reviewsDue(sys, io), 0);
    assert.deepEqual(out.map((line) => JSON.parse(line)), [
      { number: 5, title: 'Decision 5', url: `https://github.com/${SLUG}/issues/5`, kind: 'Bet', review: '2026-10-30', labels: ['veto'], body: 'Kind: Bet\nReview: 2026-10-30' },
    ]);
    assert.deepEqual(err, ['reviews-due: 1 decision due for review on 2026-10-30']);
    assert.equal(sys.requests[0]?.token, 'ghp_good');
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
  const VETOED = `/repos/${SLUG}/issues?state=all&labels=veto&per_page=100`;
  const events = (number: number, at: string) => [
    { event: 'labeled', label: { name: 'veto' }, created_at: '2026-01-01T00:00:00Z' },
    { event: 'labeled', label: { name: 'needs-owner' }, created_at: at },
    { event: 'commented', created_at: at },
    { event: 'labeled', label: { name: 'veto' }, created_at: at },
  ].map((event) => ({ ...event, issue: number }));

  function github(): FakeSys {
    const sys = new FakeSys();
    sys.route('GET', VETOED, { status: 200, json: [issue(5, ''), issue(6, ''), issue(7, '')] });
    sys.route('GET', `/repos/${SLUG}/issues/5/events?per_page=100`, { status: 200, json: events(5, '2026-10-20T00:00:00Z') });
    sys.route('GET', `/repos/${SLUG}/issues/6/events?per_page=100`, { status: 200, json: events(6, '2026-10-28T00:00:00Z') });
    sys.route('GET', `/repos/${SLUG}/issues/7/events?per_page=100`, { status: 200, json: [] });
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

  for (const [name, change, message] of [
    ['listing', (sys: FakeSys) => sys.route('GET', VETOED, { status: 500, json: null }), /cannot list vetoable decisions \(HTTP 500\)/],
    ['reading events', (sys: FakeSys) => sys.route('GET', `/repos/${SLUG}/issues/5/events?per_page=100`, { status: 404, json: null }), /cannot read #5's events \(HTTP 404\)/],
    ['removing', (sys: FakeSys) => sys.route('DELETE', `/repos/${SLUG}/issues/5/labels/veto`, { status: 403, json: null }), /cannot remove veto from #5 \(HTTP 403\)/],
  ] as const) {
    it(`throws when ${name} fails`, async () => {
      const sys = github();
      change(sys);
      await assert.rejects(expireVetoes(sys, capture().io, SLUG, 'ghs_run'), message);
    });
  }
});
