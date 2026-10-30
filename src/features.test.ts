import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decisionsWeekly } from './decisions.ts';
import { prDesign } from './design.ts';
import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { FEATURES, featuresIn, isOn, offLine, parseFeatures } from './features.ts';
import { prIdentity } from './identity.ts';
import { reviewsDue } from './reviews.ts';
import { prePush, prWorkRules } from './work.ts';

const SETTINGS = `${ROOT}/.github/process-rules.json`;

describe('features', () => {
  it('keeps every feature on for settings that list none', () => {
    assert.deepEqual(featuresIn({ owner: 'o', agent: 'a' }), [...FEATURES]);
  });

  it('reads a list, always with identity, in a fixed order', () => {
    assert.deepEqual(featuresIn({ features: ['review', 'board'] }), ['identity', 'board', 'review']);
    assert.deepEqual(parseFeatures(''), ['identity']);
  });

  it('refuses features that are not a list of names', () => {
    assert.throws(() => featuresIn({ features: 'board' }), /"features" must be a list of feature names/);
    assert.throws(() => featuresIn({ features: [1] }), /"features" must be a list of feature names/);
    assert.throws(() => featuresIn({ features: ['boards'] }), /unknown feature "boards"/);
    assert.throws(() => featuresIn({ features: ['board,review'] }), /unknown feature "board,review"/);
    assert.deepEqual(featuresIn({ features: [] }), ['identity']);
  });

  it('reads whether a feature is on from the settings file', () => {
    const sys = new FakeSys();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    assert.equal(isOn(sys, ROOT, 'identity'), true);
    assert.equal(isOn(sys, ROOT, 'board'), false);
    assert.equal(offLine('pr-design', 'design'), 'pr-design: design is off in .github/process-rules.json; nothing to check');
  });
});

describe('checks of features that are off', () => {
  /** A client with identity alone on, in Actions or in an agent session. */
  function identityOnly(): FakeSys {
    const sys = new FakeSys();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    sys.files.set('/tmp/event.json', JSON.stringify({ action: 'opened', pull_request: { number: 7, body: 'Slice: #1', user: { login: AGENT }, base: { sha: 'b' }, head: { ref: 'w', repo: null } } }));
    sys.env = {
      GITHUB_EVENT_PATH: '/tmp/event.json',
      GITHUB_ACTOR: AGENT,
      GITHUB_REPOSITORY: 'example-org/example-app',
      GH_TOKEN: 'ghs_run',
      FIGMA_TOKEN: 'figd',
      PROCESS_RULES_AGENT: AGENT,
    };
    return sys;
  }

  for (const [command, check, line] of [
    ['pr-identity', prIdentity, 'pr-identity: pr-identity is off in .github/process-rules.json; nothing to check'],
    ['pr-work-rules', prWorkRules, 'pr-work-rules: work-rules is off in .github/process-rules.json; nothing to check'],
    ['pr-design', prDesign, 'pr-design: design is off in .github/process-rules.json; nothing to check'],
    ['decisions-weekly', decisionsWeekly, 'decisions-weekly: decisions is off in .github/process-rules.json; nothing to check'],
  ] as const) {
    it(`${command} passes, saying so, and asks GitHub nothing`, async () => {
      const sys = identityOnly();
      const { io, out } = capture();
      assert.equal(await check(sys, io), 0);
      assert.deepEqual(out, [line]);
      assert.deepEqual(sys.requests, []);
    });
  }

  it('reviews-due lists nothing', async () => {
    const sys = identityOnly();
    const { io, out, err } = capture();
    assert.equal(await reviewsDue(sys, io), 0);
    assert.deepEqual({ out, err }, { out: [], err: ['reviews-due: review is off in .github/process-rules.json; nothing to check'] });
  });

  it('pre-push lets an agent push, even with no token, saying so', async () => {
    const sys = identityOnly();
    delete sys.env.GH_TOKEN;
    const { io, err } = capture();
    assert.equal(await prePush(sys, io, `refs/heads/w ${'a'.repeat(40)} refs/heads/w ${'b'.repeat(40)}`), 0);
    assert.deepEqual(err, ['pre-push: work-rules is off in .github/process-rules.json; nothing to check']);
  });

  it('reviews-due needs no token when review is off', async () => {
    const sys = identityOnly();
    delete sys.env.GH_TOKEN;
    assert.equal(await reviewsDue(sys, capture().io), 0);
  });

  it('the weekly job still expires vetoes when review is on and decisions are off', async () => {
    const sys = identityOnly();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['review'] }));
    sys.route('GET', '/repos/example-org/example-app/issues?state=all&type=Decision&labels=veto&per_page=100&page=1', { status: 200, json: [] });
    const { io, out } = capture();
    assert.equal(await decisionsWeekly(sys, io), 0);
    assert.ok(sys.requests.some((r) => r.url.includes('labels=veto')));
    assert.deepEqual(out, ['decisions-weekly: decisions is off in .github/process-rules.json; nothing to check']);
  });

  it('the weekly job leaves vetoes alone when review is off', async () => {
    const sys = identityOnly();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['decisions'] }));
    sys.route('GET', '/repos/example-org/example-app/issues?state=open&type=Decision&per_page=100&page=1', { status: 200, json: [] });
    sys.route('GET', '/repos/example-org/example-app/issues?state=open&labels=needs-owner&per_page=100&page=1', { status: 200, json: [] });
    assert.equal(await decisionsWeekly(sys, capture().io), 0);
    assert.ok(!sys.requests.some((r) => r.url.includes('labels=veto')));
  });
});
