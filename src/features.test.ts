import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decisionsWeekly } from './decisions.ts';
import { prDesign } from './design.ts';
import { AGENT, FakeSys, ROOT, capture } from './fake.test.ts';
import { DEFAULT_SCHEDULE, FEATURES, PERSONAL_REPO, featuresIn, isOn, isPersonal, notAdoptedLine, offLine, parseFeatures, renamedLines, scheduleIn } from './features.ts';
import { prIdentity } from './identity.ts';
import { reviewsDue } from './reviews.ts';
import { prePush, prWorkRules, propose } from './work.ts';

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

  it('reads design, the older name of figma, and says so', () => {
    assert.deepEqual(featuresIn({ features: [' design ', 'board'] }), ['identity', 'board', 'figma']);
    assert.deepEqual(renamedLines({ features: ['design', 'figma'] }), ['.github/process-rules.json lists "design", which is now named "figma"; run process-rules onboard to rename it']);
    assert.deepEqual(renamedLines({ features: ['figma', 2] }), []);
    assert.deepEqual(renamedLines({}), []);
    assert.deepEqual(renamedLines({ features: ['constructor'] }), []);
    assert.throws(() => featuresIn({ features: ['constructor'] }), /unknown feature "constructor"/);
    assert.throws(() => parseFeatures('design'), /unknown feature design/);
  });

  it('reads the decisions schedule, Mondays 06:17 UTC by default', () => {
    assert.equal(scheduleIn({ owner: 'o', agent: 'a' }), DEFAULT_SCHEDULE);
    assert.equal(DEFAULT_SCHEDULE, '17 6 * * 1');
    assert.equal(scheduleIn(null), DEFAULT_SCHEDULE);
    assert.equal(scheduleIn({ schedule: '  30 7 * * 3 ' }), '30 7 * * 3');
    assert.equal(scheduleIn({ schedule: '0  9\t*  *  1-5' }), '0 9 * * 1-5');
    for (const cron of ['*/15 * * * *', '0,30 8-18/2 1 jan-jun MON', '59 23 31 12 6', '0 0 1-15/3 DEC sun-sat', '5 4 * * 0']) {
      assert.equal(scheduleIn({ schedule: cron }), cron);
    }
  });

  it('refuses a schedule that is not a five-field cron', () => {
    for (const schedule of [
      '',
      '17 6 * *',
      '17 6 * * 1 2026',
      '60 6 * * 1',
      '17 24 * * 1',
      '17 6 0 * 1',
      '17 6 * 13 1',
      '17 6 * * 7',
      '17 6 * * MO',
      '17 6 * * 5-1',
      '17 6 * * 1-',
      '*/0 * * * *',
      '1-2-3 * * * *',
      '17 6 * * ,1',
      '@weekly',
      7,
      ['17 6 * * 1'],
    ]) {
      assert.throws(() => scheduleIn({ schedule }), /"schedule" must be a five-field cron, such as "17 6 \* \* 1" \(Mondays, 06:17 UTC\)/, JSON.stringify(schedule));
    }
  });

  it('reads whether a feature is on from the settings file', () => {
    const sys = new FakeSys();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    assert.equal(isOn(sys, ROOT, 'identity'), true);
    assert.equal(isOn(sys, ROOT, 'board'), false);
    assert.equal(offLine('pr-design', 'figma'), 'pr-design: figma is off in .github/process-rules.json; nothing to check');
  });
});

describe('pull request checks on a base not adopted yet', () => {
  for (const [command, check] of [
    ['pr-identity', prIdentity],
    ['pr-work-rules', prWorkRules],
    ['pr-design', prDesign],
  ] as const) {
    it(`${command} passes, saying the base has no settings, and asks GitHub nothing`, async () => {
      const sys = new FakeSys();
      sys.files.delete(SETTINGS);
      sys.files.set('/tmp/event.json', JSON.stringify({ action: 'opened', pull_request: { number: 7, body: 'Slice: #1', user: { login: AGENT }, base: { sha: 'b' }, head: { ref: 'w', repo: null } } }));
      sys.env = { GITHUB_EVENT_PATH: '/tmp/event.json', GITHUB_ACTOR: AGENT, GITHUB_REPOSITORY: 'example-org/example-app', GH_TOKEN: 'ghs_run', FIGMA_TOKEN: 'figd' };
      const { io, out } = capture();
      assert.equal(await check(sys, io), 0);
      assert.deepEqual(out, [`${command}: the base branch has no .github/process-rules.json, so the repo is not adopted on its base yet; nothing to check`]);
      assert.deepEqual(sys.requests, []);
    });
  }

  it('says nothing once the base has settings', () => {
    const sys = new FakeSys();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    assert.equal(notAdoptedLine(sys, ROOT, 'pr-identity'), undefined);
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
    ['pr-design', prDesign, 'pr-design: figma is off in .github/process-rules.json; nothing to check'],
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

  it('pre-push checks only that an agent pushes as the agent, saying the work rules are off', async () => {
    const sys = identityOnly();
    sys.acceptToken('ghs_run', AGENT);
    const { io, err } = capture();
    assert.equal(await prePush(sys, io, `refs/heads/w ${'a'.repeat(40)} refs/heads/w ${'b'.repeat(40)}`, 'https://github.com/example-org/example-app.git'), 0);
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

describe('checks on a personal repository', () => {
  /** A client with every feature on, in a repository a personal account owns, in Actions or in an agent session. */
  function personal(): FakeSys {
    const sys = new FakeSys();
    sys.ownerType = 'User';
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT }));
    sys.files.set('/tmp/event.json', JSON.stringify({ action: 'opened', pull_request: { number: 7, body: 'Slice: #1', user: { login: AGENT }, base: { sha: 'b' }, head: { ref: 'w', repo: null } } }));
    sys.env = {
      GITHUB_EVENT_PATH: '/tmp/event.json',
      GITHUB_ACTOR: AGENT,
      GITHUB_REPOSITORY: 'example-org/example-app',
      GH_TOKEN: 'ghs_run',
      FIGMA_TOKEN: 'figd',
      FIGMA_LIBRARY: 'abc',
      PROCESS_RULES_AGENT: AGENT,
    };
    return sys;
  }
  const WHY = 'on a repository owned by a personal account, since GitHub has issue types for organisations only';
  /** Only the repository was asked about, once, with the run's token. */
  const askedOnce = (sys: FakeSys): void =>
    assert.deepEqual(sys.requests.filter((r) => r.url.startsWith('https://api.github.com/repos/')), [{ url: 'https://api.github.com/repos/example-org/example-app', method: 'GET', token: 'ghs_run' }]);

  it('says why', () => {
    assert.equal(offLine('pr-work-rules', 'work-rules', PERSONAL_REPO), `pr-work-rules: work-rules is off ${WHY}; nothing to check`);
  });

  for (const [command, check, line] of [
    ['pr-work-rules', prWorkRules, `pr-work-rules: work-rules is off ${WHY}; nothing to check`],
    ['pr-design', prDesign, `pr-design: figma is off ${WHY}; nothing to check`],
    ['decisions-weekly', decisionsWeekly, `decisions-weekly: decisions is off ${WHY}; nothing to check`],
  ] as const) {
    it(`${command} passes, saying why, and asks GitHub only whose the repository is`, async () => {
      const sys = personal();
      const { io, out } = capture();
      assert.equal(await check(sys, io), 0);
      assert.deepEqual(out, [line]);
      askedOnce(sys);
    });
  }

  it('the weekly job leaves vetoes alone when review is on and decisions are off', async () => {
    const sys = personal();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['review'] }));
    const { io, out } = capture();
    assert.equal(await decisionsWeekly(sys, io), 0);
    assert.deepEqual(out, [`decisions-weekly: review is off ${WHY}; nothing to check`]);
    askedOnce(sys);
  });

  it('the weekly job asks GitHub nothing when review and decisions are off', async () => {
    const sys = personal();
    sys.files.set(SETTINGS, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity'] }));
    assert.equal(await decisionsWeekly(sys, capture().io), 0);
    assert.deepEqual(sys.requests, []);
  });

  it('reviews-due lists nothing, saying why', async () => {
    const sys = personal();
    const { io, out, err } = capture();
    assert.equal(await reviewsDue(sys, io), 0);
    assert.deepEqual({ out, err }, { out: [], err: [`reviews-due: review is off ${WHY}; nothing to check`] });
    askedOnce(sys);
  });

  it('pre-push checks only that an agent pushes as the agent, saying why the work rules cannot run', async () => {
    const sys = personal();
    sys.acceptToken('ghs_run', AGENT);
    const { io, err } = capture();
    assert.equal(await prePush(sys, io, `refs/heads/w ${'a'.repeat(40)} refs/heads/w ${'b'.repeat(40)}`, 'https://github.com/example-org/example-app.git'), 0);
    assert.deepEqual(err, [`pre-push: work-rules is off ${WHY}; nothing to check`]);
    askedOnce(sys);
  });

  it('propose posts nothing, saying why', async () => {
    const sys = personal();
    const { io, out } = capture();
    assert.equal(await propose(sys, io, 1), 0);
    assert.deepEqual(out, [`propose: work-rules is off ${WHY}; nothing to check`]);
    askedOnce(sys);
  });
});

describe('isPersonal', () => {
  it("reads the repository's owner type once per run", async () => {
    const sys = new FakeSys();
    assert.equal(await isPersonal(sys, 'example-org/example-app', 'ghs_run'), false);
    assert.equal(await isPersonal(sys, 'example-org/example-app', 'ghs_run'), false);
    assert.equal(sys.requests.length, 1);
    const mine = new FakeSys();
    mine.ownerType = 'User';
    assert.equal(await isPersonal(mine, 'example-org/example-app', 'ghs_run'), true);
  });

  it('throws when GitHub will not say', async () => {
    const sys = new FakeSys().route('GET', '/repos/example-org/example-app', { status: 403, json: { message: 'Forbidden' } });
    await assert.rejects(isPersonal(sys, 'example-org/example-app', 'ghs_run'), /cannot tell whether a personal account owns example-org\/example-app \(HTTP 403\)/);
  });
});
