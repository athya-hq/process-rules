import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { prIdentity } from './identity.ts';

const EVENT = '/tmp/event.json';
const REPO = '/repos/example-org/example-app';
const COMMITS = `${REPO}/pulls/7/commits?per_page=100`;
const ACTIVITY = `${REPO}/activity?ref=refs%2Fheads%2Fwork&per_page=100`;
const compare = (from: string, to: string, page = 1) => `${REPO}/compare/${from}...${to}?per_page=100&page=${page}`;
const EMAIL = '42+ExampleBot@users.noreply.github.com';
const BASE = 'base0';
const ZERO = '0'.repeat(40);

function commit(sha: string, by: 'agent' | 'owner' | 'spoof', verified = true): Record<string, unknown> {
  const login = by === 'owner' ? 'example-owner' : AGENT;
  return {
    sha,
    author: by === 'owner' ? { login } : by === 'spoof' ? null : { login },
    committer: by === 'spoof' ? { login: 'example-owner' } : { login },
    commit: {
      author: { email: by === 'owner' ? 'owner@example.com' : EMAIL.toUpperCase() },
      verification: { verified: by === 'spoof' ? false : verified, reason: by === 'spoof' ? 'unknown_key' : verified ? 'valid' : 'unsigned' },
    },
  };
}

interface Push {
  type: string;
  actor: string | null;
  before: string;
  after: string;
  /** The commits a compare from the push's starting point to `after` lists. */
  brings: string[];
}

/** A pull request run in Actions: the event, the actor, the commits GitHub lists and the pushes it recorded, oldest first. */
function actions(action: string, actor: string, commits: Record<string, unknown>[], pushes: Push[] = []): FakeSys {
  const sys = new FakeSys();
  sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_ACTOR: actor, GITHUB_REPOSITORY: 'example-org/example-app', GH_TOKEN: 'ghs_run' };
  sys.files.set(EVENT, JSON.stringify({ action, pull_request: { number: 7, base: { sha: BASE }, head: { ref: 'work', repo: { full_name: 'example-org/example-app' } } } }));
  sys.route('GET', `${COMMITS}&page=1`, { status: 200, json: commits });
  sys.route('GET', ACTIVITY, {
    status: 200,
    json: [...pushes].reverse().map((push) => ({ activity_type: push.type, actor: push.actor ? { login: push.actor } : null, before: push.before, after: push.after })),
  });
  for (const push of pushes) {
    const from = push.type === 'push' && push.before !== ZERO ? push.before : BASE;
    sys.route('GET', compare(from, push.after), { status: 200, json: { commits: push.brings.map((sha) => ({ sha })) } });
  }
  return sys;
}

async function check(sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await prIdentity(sys, io), out, err };
}

const created = (actor: string, brings: string[], after = 'h1'): Push => ({ type: 'branch_creation', actor, before: ZERO, after, brings });
const pushed = (actor: string, before: string, after: string, brings: string[]): Push => ({ type: 'push', actor, before, after, brings });

describe('prIdentity', () => {
  it('passes Verified agent commits the agent pushed', async () => {
    const sys = actions('opened', AGENT, [commit('a1', 'agent'), commit('a2', 'agent')], [created('examplebot', ['a1', 'a2'])]);
    assert.deepEqual(await check(sys), { code: 0, out: ['✓ pr-identity: 2 commits by ExampleBot, each Verified and pushed by ExampleBot'], err: [] });
    assert.ok(sys.requests.filter((r) => r.url.includes(REPO)).every((r) => r.token === 'ghs_run'));
    assert.equal(sys.cwd, ROOT);
  });

  it("passes the owner's own commits", async () => {
    const sys = actions('opened', 'example-owner', [commit('o1', 'owner')], [created('example-owner', ['o1'])]);
    assert.deepEqual((await check(sys)).out, ['✓ pr-identity: 0 commits by ExampleBot, each Verified and pushed by ExampleBot']);
  });

  it('fails agent commits the owner pushed', async () => {
    const sys = actions('opened', 'example-owner', [commit('a1', 'agent'), commit('a2', 'agent')], [created('example-owner', ['a1', 'a2'])]);
    assert.deepEqual(await check(sys), {
      code: 1,
      out: [],
      err: ['✗ example-owner pushed a1, a2, which claim ExampleBot; agent work must be pushed by ExampleBot', 'pr-identity: #7 fails the identity check'],
    });
  });

  describe('judges who pushed, never who started the run', () => {
    const ownerPushed = '✗ example-owner pushed a1, which claims ExampleBot; agent work must be pushed by ExampleBot';

    it('keeps failing when a bot edits after the owner pushed', async () => {
      for (const [action, actor] of [['opened', 'example-owner'], ['edited', 'cubic-dev-ai[bot]'], ['labeled', AGENT], ['reopened', AGENT]] as const) {
        const sys = actions(action, actor, [commit('a1', 'agent')], [created('example-owner', ['a1'])]);
        assert.deepEqual(await check(sys), { code: 1, out: [], err: [ownerPushed, 'pr-identity: #7 fails the identity check'] }, `${action} by ${actor}`);
      }
    });

    it('keeps passing when the owner edits after the agent pushed', async () => {
      for (const [action, actor] of [['opened', AGENT], ['edited', 'example-owner'], ['labeled', 'example-owner']] as const) {
        const sys = actions(action, actor, [commit('a1', 'agent')], [created(AGENT, ['a1'])]);
        assert.equal((await check(sys)).code, 0, `${action} by ${actor}`);
      }
    });

    it('fails an owner force push over agent commits, whoever runs it again', async () => {
      for (const actor of ['example-owner', AGENT]) {
        const sys = actions('synchronize', actor, [commit('a1', 'agent')], [
          created(AGENT, ['a0'], 'h1'),
          { type: 'force_push', actor: 'example-owner', before: 'h1', after: 'h2', brings: ['a1'] },
        ]);
        assert.deepEqual((await check(sys)).err[0], ownerPushed, `run by ${actor}`);
      }
    });

    it('does not credit the agent that opens the pull request with a push GitHub has not recorded yet', async () => {
      const sys = actions('opened', AGENT, [commit('a1', 'agent')]);
      assert.deepEqual(await check(sys), {
        code: 1,
        out: [],
        err: [
          '✗ no push GitHub has recorded to work brought a1, which claims ExampleBot; re-run once GitHub records the push',
          'pr-identity: #7 fails the identity check',
        ],
      });
      assert.deepEqual(sys.slept, [10_000, 10_000, 10_000, 10_000, 10_000]);
      assert.equal(sys.requests.filter((r) => r.url.includes('/activity')).length, 6);
    });

    it('waits for GitHub to record the push', async () => {
      for (const [pusher, code] of [[AGENT, 0], ['example-owner', 1]] as const) {
        const sys = actions('synchronize', AGENT, [commit('a1', 'agent')]);
        let reads = 0;
        sys.route('GET', ACTIVITY, () => ({
          status: 200,
          json: ++reads < 3 ? [] : [{ activity_type: 'branch_creation', actor: { login: pusher }, before: ZERO, after: 'h1' }],
        }));
        sys.route('GET', compare(BASE, 'h1'), { status: 200, json: { commits: [{ sha: 'a1' }] } });
        assert.equal((await check(sys)).code, code, `pushed by ${pusher}`);
        assert.deepEqual(sys.slept, [10_000, 10_000]);
      }
    });
  });

  it('credits each commit to the push that first brought it', async () => {
    const sys = actions(
      'synchronize',
      'example-owner',
      [commit('a1', 'agent'), commit('o2', 'owner'), commit('a3', 'agent')],
      [created(AGENT, ['a1'], 'h1'), pushed('example-owner', 'h1', 'h2', ['o2']), pushed(AGENT, 'h2', 'h3', ['a1', 'o2', 'a3'])],
    );
    assert.equal((await check(sys)).code, 0);
  });

  it('keeps an owner push failing when the agent later pushes the same commit again', async () => {
    const sys = actions('synchronize', AGENT, [commit('a1', 'agent')], [
      created('example-owner', ['a1'], 'h1'),
      { type: 'force_push', actor: AGENT, before: 'h1', after: 'h2', brings: ['a1'] },
    ]);
    assert.match((await check(sys)).err[0] ?? '', /^✗ example-owner pushed a1/);
  });

  it('credits a force push with commits counted from the base', async () => {
    const sys = actions('synchronize', 'example-owner', [commit('a9', 'agent')], [
      created(AGENT, ['a1'], 'h1'),
      { type: 'force_push', actor: 'example-owner', before: 'h1', after: 'h9', brings: ['a9'] },
    ]);
    assert.match((await check(sys)).err[0] ?? '', /^✗ example-owner pushed a9/);
  });

  it('skips deletions', async () => {
    const sys = actions('opened', AGENT, [commit('a1', 'agent')], [
      { type: 'branch_deletion', actor: 'example-owner', before: 'h0', after: ZERO, brings: [] },
      created(AGENT, ['a1']),
    ]);
    assert.equal((await check(sys)).code, 0);
  });

  it('fails a push GitHub records with no actor, even when the agent pushes the commit again', async () => {
    const sys = actions('opened', AGENT, [commit('a1', 'agent')], [
      { type: 'push', actor: null, before: ZERO, after: 'hx', brings: ['a1'] },
      created(AGENT, ['a1']),
    ]);
    assert.deepEqual((await check(sys)).err[0], '✗ an account GitHub no longer names pushed a1, which claims ExampleBot; agent work must be pushed by ExampleBot');
  });

  it('fails a commit that claims the agent without its signature', async () => {
    const sys = actions('opened', AGENT, [commit('abcdef123', 'spoof'), commit('b2', 'agent', false)], [created(AGENT, ['abcdef123', 'b2'])]);
    const { code, err } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(err.slice(0, 2), [
      '✗ abcdef1 claims ExampleBot but is not Verified as ExampleBot (committer example-owner, unknown_key)',
      '✗ b2 claims ExampleBot but is not Verified as ExampleBot (committer ExampleBot, unsigned)',
    ]);
  });

  it('fails a Verified commit that claims the agent but was committed by the owner', async () => {
    const owned = commit('d4d4d4d', 'agent');
    owned.committer = { login: 'example-owner' };
    const sys = actions('opened', AGENT, [owned], [created(AGENT, ['d4d4d4d'])]);
    assert.deepEqual((await check(sys)).err[0], '✗ d4d4d4d claims ExampleBot but is not Verified as ExampleBot (committer example-owner, valid)');
  });

  it('names a commit with no committer or verification', async () => {
    const sys = actions('opened', AGENT, [{ sha: 'c3', author: { login: AGENT } }], [created(AGENT, ['c3'])]);
    assert.equal((await check(sys)).err[0], '✗ c3 claims ExampleBot but is not Verified as ExampleBot (committer none, no verification)');
  });

  it("reads a fork's pushes from the fork", async () => {
    const sys = actions('opened', AGENT, [commit('a1', 'agent')], [created('example-owner', ['a1'])]);
    const event = JSON.parse(sys.files.get(EVENT) ?? '{}');
    event.pull_request.head.repo = { full_name: 'someone/example-app' };
    sys.files.set(EVENT, JSON.stringify(event));
    sys.route('GET', '/repos/someone/example-app/activity?ref=refs%2Fheads%2Fwork&per_page=100', {
      status: 200,
      json: [{ activity_type: 'branch_creation', actor: { login: AGENT }, before: ZERO, after: 'h1' }],
    });
    sys.route('GET', '/repos/someone/example-app/compare/base0...h1?per_page=100&page=1', { status: 200, json: { commits: [{ sha: 'a1' }] } });
    assert.equal((await check(sys)).code, 0);
    assert.ok(sys.requests.some((r) => r.url.startsWith('https://api.github.com/repos/someone/example-app/activity')));
    assert.ok(!sys.requests.some((r) => r.url.startsWith(`https://api.github.com${REPO}/activity`)));
  });

  it('fails agent commits when the head repository is gone, and passes owner commits', async () => {
    const gone = (commits: Record<string, unknown>[]): FakeSys => {
      const sys = actions('opened', AGENT, commits, [created(AGENT, ['a1'])]);
      const event = JSON.parse(sys.files.get(EVENT) ?? '{}');
      event.pull_request.head.repo = null;
      sys.files.set(EVENT, JSON.stringify(event));
      return sys;
    };
    const sys = gone([commit('a1', 'agent')]);
    assert.deepEqual((await check(sys)).err[0], "✗ #7's head repository is gone, so no record says who pushed a1, which claims ExampleBot");
    assert.ok(!sys.requests.some((r) => r.url.includes('/activity')));
    assert.equal((await check(gone([commit('o1', 'owner')]))).code, 0);
  });

  it('asks nothing about pushes when no commit claims the agent', async () => {
    const sys = actions('opened', 'example-owner', [commit('o1', 'owner')]);
    sys.route('GET', ACTIVITY, { status: 403, json: null });
    assert.equal((await check(sys)).code, 0);
    assert.ok(!sys.requests.some((r) => r.url.includes('/activity')));
  });

  it('reads every page of commits, of pushes (by cursor) and of what a push brought', async () => {
    const page = Array.from({ length: 100 }, (_, i) => commit(`o${i}`, 'owner'));
    const sys = actions('reopened', 'example-owner', page);
    sys.route('GET', `${COMMITS}&page=2`, { status: 200, json: [commit('a9', 'agent')] });
    const next = 'https://api.github.com/repos/example-org/example-app/activity?ref=refs%2Fheads%2Fwork&per_page=100&after=CURSOR';
    sys.route('GET', ACTIVITY, {
      status: 200,
      json: [{ activity_type: 'branch_deletion', actor: null, before: 'x', after: ZERO }],
      headers: { link: `<${next}>; rel="next", <https://example.invalid>; rel="last"` },
    });
    sys.route('GET', next, { status: 200, json: [{ activity_type: 'branch_creation', actor: { login: AGENT }, before: ZERO, after: 'h1' }] });
    sys.route('GET', compare(BASE, 'h1'), { status: 200, json: { commits: Array.from({ length: 100 }, (_, i) => ({ sha: `x${i}` })) } });
    sys.route('GET', compare(BASE, 'h1', 2), { status: 200, json: { commits: [{ sha: 'a9' }] } });
    assert.equal((await check(sys)).code, 0, 'a9 is credited to the agent from the second page');
  });

  it('fails closed at the 250 commits GitHub lists', async () => {
    const page = Array.from({ length: 100 }, (_, i) => commit(`o${i}`, 'owner'));
    const sys = actions('opened', 'example-owner', page);
    for (const n of [2, 3, 4]) sys.route('GET', `${COMMITS}&page=${n}`, { status: 200, json: page });
    assert.deepEqual(await check(sys), {
      code: 1,
      out: [],
      err: ['✗ #7 has 250 or more commits, more than GitHub lists; split it so every commit can be checked', 'pr-identity: #7 fails the identity check'],
    });
    assert.equal(sys.requests.filter((r) => r.url.includes('/commits?')).length, 3);
  });

  it('skips events that are not pull requests', async () => {
    const sys = actions('opened', 'example-owner', []);
    sys.files.set(EVENT, JSON.stringify({ ref: 'refs/heads/main' }));
    assert.deepEqual(await check(sys), { code: 0, out: ['pr-identity: not a pull request; nothing to check'], err: [] });
  });

  it('needs the Actions environment', async () => {
    await assert.rejects(check(new FakeSys()), /pr-identity runs in GitHub Actions/);
  });

  for (const [name, change, message] of [
    ['list the commits', (sys: FakeSys) => sys.route('GET', `${COMMITS}&page=1`, { status: 403, json: null }), /cannot list the commits of #7 \(HTTP 403\)/],
    ['read the pushes', (sys: FakeSys) => sys.route('GET', ACTIVITY, { status: 404, json: null }), /cannot read the pushes to work \(HTTP 404\)/],
    ['compare a push', (sys: FakeSys) => sys.route('GET', compare(BASE, 'h1'), { status: 500, json: null }), /cannot compare base0...h1 \(HTTP 500\)/],
  ] as const) {
    it(`throws when GitHub will not ${name}`, async () => {
      const sys = actions('opened', AGENT, [commit('a1', 'agent')], [created(AGENT, ['a1'])]);
      change(sys);
      await assert.rejects(check(sys), message);
    });
  }

  it('reads a compare with no commits as bringing none', async () => {
    const sys = actions('reopened', AGENT, [commit('a1', 'agent')], [created(AGENT, [])]);
    sys.route('GET', compare(BASE, 'h1'), { status: 200, json: null });
    assert.match((await check(sys)).err[0] ?? '', /^✗ no push GitHub has recorded to work brought a1/);
  });
});

describe('prIdentity with two agents', () => {
  const OTHER = 'OtherBot';
  const OTHER_EMAIL = '43+OtherBot@users.noreply.github.com';
  const other = (sha: string, committer = OTHER): Record<string, unknown> => ({
    sha,
    author: { login: OTHER },
    committer: { login: committer },
    commit: { author: { email: OTHER_EMAIL }, verification: { verified: true, reason: 'valid' } },
  });
  const team = (commits: Record<string, unknown>[], pushes: Push[]): FakeSys => {
    const sys = actions('opened', AGENT, commits, pushes);
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: ['example-owner', 'Second-Owner'], agent: [AGENT, OTHER] }));
    sys.route('GET', `/users/${OTHER}`, { status: 200, json: { id: 43, login: OTHER } });
    return sys;
  };

  it("passes each agent's Verified commits, pushed by either agent", async () => {
    const sys = team([commit('a1', 'agent'), other('b1')], [created(AGENT, ['a1']), pushed('otherbot', 'h1', 'h2', ['b1'])]);
    assert.deepEqual(await check(sys), {
      code: 0,
      out: ['✓ pr-identity: 2 commits by ExampleBot or OtherBot, each Verified and pushed by ExampleBot or OtherBot'],
      err: [],
    });
    const mixed = team([other('b1')], [created(AGENT, ['b1'])]);
    assert.equal((await check(mixed)).code, 0, 'one agent may push the other\'s commits');
  });

  it('fails a commit claiming one agent but committed by the other, and agent work an owner pushed', async () => {
    const sys = team([other('b1', AGENT), other('b2')], [created('Second-Owner', ['b1', 'b2'])]);
    assert.deepEqual((await check(sys)).err, [
      '✗ b1 claims OtherBot but is not Verified as OtherBot (committer ExampleBot, valid)',
      '✗ Second-Owner pushed b1, b2, which claim OtherBot; agent work must be pushed by ExampleBot or OtherBot',
      'pr-identity: #7 fails the identity check',
    ]);
  });

  it('names every agent the unrecorded commits claim', async () => {
    const sys = team([commit('a1', 'agent'), other('b1')], []);
    sys.sleep = () => Promise.resolve();
    assert.deepEqual((await check(sys)).err, [
      '✗ no push GitHub has recorded to work brought a1, b1, which claim ExampleBot or OtherBot; re-run once GitHub records the push',
      'pr-identity: #7 fails the identity check',
    ]);
  });
});
