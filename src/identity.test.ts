import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { prIdentity } from './identity.ts';

const EVENT = '/tmp/event.json';
const COMMITS = '/repos/example-org/example-app/pulls/7/commits?per_page=100';
const EMAIL = '42+ExampleBot@users.noreply.github.com';

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

/** A pull request run in Actions: the event, the actor, and the commits GitHub lists. */
function actions(event: Record<string, unknown>, actor: string, commits: Record<string, unknown>[]): FakeSys {
  const sys = new FakeSys();
  sys.env = { GITHUB_EVENT_PATH: EVENT, GITHUB_ACTOR: actor, GITHUB_REPOSITORY: 'example-org/example-app', GH_TOKEN: 'ghs_run' };
  sys.files.set(EVENT, JSON.stringify(event));
  sys.route('GET', `${COMMITS}&page=1`, { status: 200, json: commits });
  return sys;
}

async function check(sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await prIdentity(sys, io), out, err };
}

const opened = { action: 'opened', pull_request: { number: 7 } };

describe('prIdentity', () => {
  it('passes Verified agent commits pushed by the agent', async () => {
    const sys = actions(opened, 'examplebot', [commit('a1', 'agent'), commit('a2', 'agent')]);
    assert.deepEqual(await check(sys), { code: 0, out: ['✓ pr-identity: 2 commits by ExampleBot, each Verified; pushed by examplebot'], err: [] });
    assert.ok(sys.requests.filter((r) => r.url.includes('/pulls/')).every((r) => r.token === 'ghs_run'));
    assert.equal(sys.cwd, ROOT);
  });

  it("passes the owner's own commits", async () => {
    const sys = actions(opened, 'example-owner', [commit('o1', 'owner')]);
    assert.deepEqual((await check(sys)).out, ['✓ pr-identity: 0 commits by ExampleBot, each Verified; pushed by example-owner']);
  });

  it('fails agent commits pushed by the owner', async () => {
    const sys = actions(opened, 'example-owner', [commit('a1', 'agent')]);
    assert.deepEqual(await check(sys), {
      code: 1,
      out: [],
      err: ['✗ example-owner pushed commits that claim ExampleBot; agent work must be pushed by ExampleBot', 'pr-identity: #7 fails the identity check'],
    });
  });

  it('fails a commit that claims the agent without its signature', async () => {
    const sys = actions(opened, AGENT, [commit('abcdef123', 'spoof'), commit('b2', 'agent', false)]);
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
    const sys = actions(opened, AGENT, [owned]);
    assert.deepEqual((await check(sys)).err[0], '✗ d4d4d4d claims ExampleBot but is not Verified as ExampleBot (committer example-owner, valid)');
  });

  it('lets the owner reopen or edit an agent pull request', async () => {
    for (const action of ['reopened', 'edited']) {
      const sys = actions({ action, pull_request: { number: 7 } }, 'example-owner', [commit('a1', 'agent')]);
      assert.equal((await check(sys)).code, 0, action);
    }
  });

  it('names a commit with no committer or verification', async () => {
    const sys = actions(opened, AGENT, [{ sha: 'c3', author: { login: AGENT } }]);
    assert.equal((await check(sys)).err[0], '✗ c3 claims ExampleBot but is not Verified as ExampleBot (committer none, no verification)');
  });

  it("lets the owner push their own commits onto the agent's pull request", async () => {
    const sys = actions({ action: 'synchronize', before: 'a2', pull_request: { number: 7 } }, 'example-owner', [
      commit('a1', 'agent'),
      commit('a2', 'agent'),
      commit('o3', 'owner'),
    ]);
    assert.equal((await check(sys)).code, 0);
  });

  it('counts every commit as new after a force push', async () => {
    const sys = actions({ action: 'synchronize', before: 'gone', pull_request: { number: 7 } }, 'example-owner', [
      commit('a1', 'agent'),
      commit('o3', 'owner'),
    ]);
    assert.equal((await check(sys)).code, 1);
  });

  it('reads every page of commits', async () => {
    const page = Array.from({ length: 100 }, (_, i) => commit(`o${i}`, 'owner'));
    const sys = actions(opened, 'example-owner', page);
    sys.route('GET', `${COMMITS}&page=2`, { status: 200, json: [commit('a9', 'agent')] });
    assert.equal((await check(sys)).code, 1);
  });

  it('fails closed at the 250 commits GitHub lists', async () => {
    const page = Array.from({ length: 100 }, (_, i) => commit(`o${i}`, 'owner'));
    const sys = actions(opened, 'example-owner', page);
    for (const n of [2, 3, 4]) sys.route('GET', `${COMMITS}&page=${n}`, { status: 200, json: page });
    assert.deepEqual(await check(sys), {
      code: 1,
      out: [],
      err: ['✗ #7 has 250 or more commits, more than GitHub lists; split it so every commit can be checked', 'pr-identity: #7 fails the identity check'],
    });
    assert.equal(sys.requests.filter((r) => r.url.includes('/commits?')).length, 3);
  });

  it('skips events that are not pull requests', async () => {
    const sys = actions({ ref: 'refs/heads/main' }, 'example-owner', []);
    assert.deepEqual(await check(sys), { code: 0, out: ['pr-identity: not a pull request; nothing to check'], err: [] });
  });

  it('needs the Actions environment', async () => {
    await assert.rejects(check(new FakeSys()), /pr-identity runs in GitHub Actions/);
  });

  it('throws when GitHub will not list the commits', async () => {
    const sys = actions(opened, AGENT, []);
    sys.route('GET', `${COMMITS}&page=1`, { status: 403, json: null });
    await assert.rejects(check(sys), /cannot list the commits of #7 \(HTTP 403\)/);
  });
});
