import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { reviewThread, threadArgs } from './review-thread.ts';

const THREAD = 'PRRT_kwDOabc123';

/** An agent session, with GitHub showing THREAD on pull request #40 of this repository. */
function session(pull: Record<string, unknown> = {}, isResolved = false): FakeSys {
  const sys = new FakeSys();
  sys.env = { PROCESS_RULES_AGENT: AGENT, GH_TOKEN: 'ghp_good' };
  sys.acceptToken('ghp_good', AGENT);
  sys.route('POST', '/graphql', () => {
    const query = (sys.requests.at(-1)?.body as { query: string }).query;
    if (query.startsWith('query')) {
      return { status: 200, json: { data: { node: { isResolved, pullRequest: { number: 40, author: { login: AGENT }, repository: { nameWithOwner: 'example-org/example-app' }, ...pull } } } } };
    }
    return { status: 200, json: { data: { done: true } } };
  });
  return sys;
}

async function run(sys: FakeSys, args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await reviewThread(sys, io, args), out, err };
}

const mutations = (sys: FakeSys): { query: string; variables: Record<string, string> }[] =>
  sys.requests.flatMap((r) => (r.url.endsWith('/graphql') && (r.body as { query: string }).query.startsWith('mutation') ? [r.body as { query: string; variables: Record<string, string> }] : []));

describe('threadArgs', () => {
  it('reads a thread id with a reply, resolve, or both', () => {
    assert.deepEqual(threadArgs([THREAD, '--reply', 'Fixed.', '--resolve']), { thread: THREAD, reply: 'Fixed.', resolve: true });
    assert.deepEqual(threadArgs([THREAD, '--resolve']), { thread: THREAD, resolve: true });
  });

  for (const [args, message] of [
    [[], /needs a review thread id \(PRRT_…\)$/],
    [['12'], /needs a review thread id \(PRRT_…\), not "12"$/],
    [[THREAD], /needs --reply <text>, --resolve, or both/],
    [[THREAD, '--reply'], /--reply needs the text of the reply/],
    [[THREAD, '--reply', ' '], /--reply needs the text of the reply/],
    [[THREAD, '--reply', 'a', '--reply', 'b'], /--reply needs the text of the reply/],
    [[THREAD, '--resolve', '--resolve'], /unexpected argument "--resolve"/],
    [[THREAD, '--delete'], /unexpected argument "--delete"/],
  ] as const) {
    it(`refuses ${JSON.stringify(args)}`, () => {
      assert.throws(() => threadArgs(args), message);
    });
  }
});

describe('reviewThread', () => {
  it("replies on, then resolves, a thread on the agent's own pull request", async () => {
    const sys = session();
    assert.deepEqual(await run(sys, [THREAD, '--reply', 'Fixed in abc123.', '--resolve']), {
      code: 0,
      out: [`✓ replied on ${THREAD} (#40)`, `✓ resolved ${THREAD} (#40)`],
      err: [],
    });
    const [reply, resolve] = mutations(sys);
    assert.match(reply?.query ?? '', /addPullRequestReviewThreadReply/);
    assert.deepEqual(reply?.variables, { id: THREAD, body: 'Fixed in abc123.' });
    assert.match(resolve?.query ?? '', /resolveReviewThread/);
    assert.ok(sys.requests.every((r) => r.token === 'ghp_good'));
  });

  it('only replies, or only resolves, as asked', async () => {
    const replied = session();
    assert.deepEqual((await run(replied, [THREAD, '--reply', 'Not changed: the reason.'])).out, [`✓ replied on ${THREAD} (#40)`]);
    assert.equal(mutations(replied).length, 1);
    const resolved = session();
    assert.deepEqual((await run(resolved, [THREAD, '--resolve'])).out, [`✓ resolved ${THREAD} (#40)`]);
  });

  it('leaves a resolved thread be', async () => {
    const sys = session({}, true);
    assert.deepEqual((await run(sys, [THREAD, '--resolve'])).out, [`✓ ${THREAD} (#40) was already resolved`]);
    assert.equal(mutations(sys).length, 0);
  });

  for (const [name, pull, problem] of [
    ['another account opened', { author: { login: 'example-owner' } }, `${THREAD} is on #40, which example-owner opened, not ${AGENT}`],
    ['a deleted account opened', { author: null }, `${THREAD} is on #40, which a deleted account opened, not ${AGENT}`],
    ['another repository has', { repository: { nameWithOwner: 'other-org/other-app' } }, `${THREAD} is on other-org/other-app#40, not a pull request in example-org/example-app`],
  ] as const) {
    it(`refuses a thread on a pull request ${name}`, async () => {
      const sys = session(pull);
      assert.deepEqual(await run(sys, [THREAD, '--resolve']), { code: 1, out: [], err: [`✗ ${problem}`, 'review-thread: refused'] });
      assert.equal(mutations(sys).length, 0);
    });
  }

  it('refuses an id that is not a review thread', async () => {
    const sys = session();
    sys.route('POST', '/graphql', { status: 200, json: { data: { node: null } } });
    assert.deepEqual((await run(sys, [THREAD, '--resolve'])).err, [`✗ ${THREAD} is not a review thread GitHub shows ${AGENT}`, 'review-thread: refused']);
  });

  it("refuses a token that is not the agent's, and a session with none", async () => {
    const owner = session();
    owner.env.GH_TOKEN = 'ghp_owner';
    owner.acceptToken('ghp_owner', 'example-owner');
    assert.deepEqual((await run(owner, [THREAD, '--resolve'])).err, [`✗ review-thread answers as ${AGENT}, but this session's token is example-owner`, 'review-thread: refused']);
    const refused = session();
    refused.env.GH_TOKEN = 'ghp_unknown';
    assert.match((await run(refused, [THREAD, '--resolve'])).err[0] ?? '', /this session's token is refused$/);
    const none = session();
    delete none.env.GH_TOKEN;
    assert.deepEqual((await run(none, [THREAD, '--resolve'])).err, ['✗ this session has no token; run process-rules doctor', 'review-thread: refused']);
    assert.equal(owner.requests.filter((r) => r.url.endsWith('/graphql')).length, 0);
  });

  it('with two agents, answers as either on a pull request either opened, and refuses an owner', async () => {
    const team = (login: string, author: string): FakeSys => {
      const sys = session({ author: { login: author } });
      sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: ['example-owner', 'Second-Owner'], agent: [AGENT, 'OtherBot'] }));
      sys.acceptToken('ghp_good', login);
      return sys;
    };
    assert.equal((await run(team('OtherBot', AGENT), [THREAD, '--resolve'])).code, 0);
    assert.equal((await run(team(AGENT, 'otherbot'), [THREAD, '--resolve'])).code, 0);
    assert.deepEqual((await run(team('OtherBot', 'Second-Owner'), [THREAD, '--resolve'])).err, [
      `✗ ${THREAD} is on #40, which Second-Owner opened, not ${AGENT} or OtherBot`,
      'review-thread: refused',
    ]);
    assert.deepEqual((await run(team('Second-Owner', AGENT), [THREAD, '--resolve'])).err, [
      `✗ review-thread answers as ${AGENT} or OtherBot, but this session's token is Second-Owner`,
      'review-thread: refused',
    ]);
  });

  it('throws when GitHub refuses, naming what it refused', async () => {
    const forbidden = session();
    forbidden.route('POST', '/graphql', { status: 403, json: null });
    await assert.rejects(run(forbidden, [THREAD, '--resolve']), /GitHub refused to read review thread PRRT_kwDOabc123 \(HTTP 403\)/);
    const errors = session();
    errors.route('POST', '/graphql', { status: 200, json: { data: null, errors: [{ message: 'Resource not accessible by integration' }] } });
    await assert.rejects(run(errors, [THREAD, '--resolve']), /\(HTTP 200: Resource not accessible by integration\)/);
  });
});
