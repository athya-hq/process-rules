import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ISSUE_TYPES, applyTypes, typesChange, typesDetail, typesLines, typesPlan, typesQuestion, withinApproved } from './issue-types.ts';
import { Board, OWNER_TOKEN, SLUG } from './fake-board.test.ts';
import { FakeSys, capture } from './fake.test.ts';

const MODEL = ISSUE_TYPES.map((type) => type.name);
const OTHER = 'example-org/example-site';

/** An organisation with the work model's types, GitHub's Task, Bug and Feature, and a second repository. */
function org(): { sys: FakeSys; board: Board } {
  const sys = new FakeSys();
  const board = new Board(sys);
  board.issueTypes = [...MODEL, 'Task', 'Bug', 'Feature'];
  board.orgRepos = [{ full_name: SLUG }, { full_name: OTHER }];
  return { sys, board };
}

describe('typesPlan', () => {
  it('gives each issue holding another type a work model type from GitHub facts, in every repository', async () => {
    const { sys, board } = org();
    board.issues = [
      { repo: SLUG, number: 1, type: 'Work item', subIssues: 2 },
      { repo: SLUG, number: 2, type: 'Task', parent: 1 },
      { repo: SLUG, number: 3, type: 'Bug', subIssues: 1 },
      { repo: SLUG, number: 4, type: 'Task' },
      { repo: SLUG, number: 5, type: 'Decision' },
      { repo: SLUG, number: 6, type: 'Feature', parent: 5 },
      // A Task holding sub-issues becomes a Work item, so its Task sub-issue becomes a Slice.
      { repo: OTHER, number: 7, type: 'Task', subIssues: 1 },
      { repo: OTHER, number: 8, type: 'task', parent: 7 },
      { repo: OTHER, number: 9, type: 'Slice' },
      { repo: OTHER, number: 10, type: 'Bug', pull: true },
    ];
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(plan.retype, [
      { repo: SLUG, number: 2, from: 'Task', to: 'Slice', why: 'its parent #1 is a Work item' },
      { repo: SLUG, number: 4, from: 'Task', to: 'Brief', why: 'it has no parent and no sub-issues' },
      { repo: SLUG, number: 3, from: 'Bug', to: 'Work item', why: 'it has 1 sub-issue' },
      { repo: SLUG, number: 6, from: 'Feature', to: 'Brief', why: 'its parent #5 is not a Work item, and it has no sub-issues' },
      { repo: OTHER, number: 7, from: 'Task', to: 'Work item', why: 'it has 1 sub-issue' },
      { repo: OTHER, number: 8, from: 'task', to: 'Slice', why: 'its parent #7 is a Work item' },
    ]);
    assert.deepEqual(plan.disable.map((type) => type.name), ['Task', 'Bug', 'Feature']);
    assert.deepEqual([plan.add, plan.enable, plan.held, plan.kept], [[], [], [], []]);
    assert.ok(sys.requests.every((request) => request.token === OWNER_TOKEN));
    assert.equal(sys.requests.filter((request) => request.url.endsWith('/issues/1')).length, 1, 'a parent is read once');
    assert.ok(!sys.requests.some((request) => request.method !== 'GET'), 'it changes nothing');
  });

  it('retypes nothing GitHub lists that does not hold the type, as when it ignores the filter', async () => {
    const { sys } = org();
    sys.route('GET', `/repos/${SLUG}/issues?type=Task&state=all&per_page=100&page=1`, {
      status: 200,
      json: [
        { number: 1, url: `https://api.github.com/repos/${SLUG}/issues/1`, type: { name: 'Slice' } },
        { number: 2, url: `https://api.github.com/repos/${SLUG}/issues/2`, type: null },
        { number: 3, type: { name: 'Task' } },
      ],
    });
    assert.deepEqual((await typesPlan(sys, OWNER_TOKEN, 'example-org')).retype, []);
  });

  it('reads no issues in a repository with issues turned off', async () => {
    const { sys, board } = org();
    board.orgRepos = [{ full_name: SLUG }, { full_name: OTHER, has_issues: false }, { full_name: 'example-org/example-fork' }];
    board.issues = [{ repo: SLUG, number: 4, type: 'Task' }];
    for (const type of ['Task', 'Bug', 'Feature']) sys.route('GET', `/repos/example-org/example-fork/issues?type=${type}&state=all&per_page=100&page=1`, { status: 410, json: null });
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(plan.retype.map((issue) => issue.number), [4]);
    assert.ok(!sys.requests.some((request) => request.url.includes(OTHER)), 'a repository with issues off is not read');
  });

  it('reads past a full page of issues', async () => {
    const { sys, board } = org();
    board.orgRepos = [{ full_name: SLUG }];
    const row = (number: number): unknown => ({ number, url: `https://api.github.com/repos/${SLUG}/issues/${number}`, type: { name: 'Task' } });
    sys.route('GET', `/repos/${SLUG}/issues?type=Task&state=all&per_page=100&page=1`, { status: 200, json: Array.from({ length: 100 }, (_, index) => row(index + 1)) });
    sys.route('GET', `/repos/${SLUG}/issues?type=Task&state=all&per_page=100&page=2`, { status: 200, json: [row(101)] });
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.equal(plan.retype.length, 101);
    assert.deepEqual(typesLines(plan).slice(10), [
      { label: '  and 91 more', detail: 'retyped by the same rule' },
      { label: '  disable', detail: 'Task, Bug, Feature' },
    ]);
    assert.match(typesQuestion(plan, 'example-app') ?? '', /#10 Task → Brief; and 91 more\), then disable Task, Bug, Feature, which can be enabled again\?$/);
  });

  it('leaves an issue in an archived repository, and the type it holds enabled', async () => {
    const { sys, board } = org();
    board.orgRepos = [{ full_name: SLUG }, { full_name: OTHER, archived: true }];
    board.issues = [
      { repo: SLUG, number: 1, type: 'Task' },
      { repo: OTHER, number: 2, type: 'Bug' },
    ];
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(plan.held, [{ repo: OTHER, number: 2, from: 'Bug', to: 'Brief', why: 'it has no parent and no sub-issues' }]);
    assert.deepEqual(plan.kept.map((type) => type.name), ['Bug']);
    assert.deepEqual(plan.disable.map((type) => type.name), ['Task', 'Feature']);
    assert.equal(typesDetail(plan), 'org-wide: retype 1, disable 2, keep 1');
    assert.deepEqual(typesLines(plan).at(-1), { label: '  keep', detail: 'Bug: archived repos hold them' });

    const { io, out } = capture();
    const byHand = await applyTypes(sys, io, OWNER_TOKEN, plan);
    assert.deepEqual(board.disabledTypes, ['Task', 'Feature']);
    assert.ok(!sys.requests.some((request) => request.method === 'PATCH' && request.url.includes(OTHER)));
    assert.ok(out.includes(`- ${OTHER}#2 keeps Bug: ${OTHER} is archived, which GitHub keeps read-only`));
    assert.ok(out.includes('- left Bug enabled in example-org, since an issue onboard did not retype holds it'));
    assert.deepEqual(byHand, [`issue types: unarchive ${OTHER}, then niyam onboard again, to retype ${OTHER}#2`]);
  });

  it('adds the work model types missing and enables those disabled, and reads no repository when no other type exists', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ['Work item', 'SLICE', 'State'];
    board.disabledTypes = ['SLICE'];
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(plan.add.map((type) => type.name), ['Decision', 'Brief']);
    assert.deepEqual(plan.enable.map((type) => type.name), ['SLICE']);
    assert.ok(!sys.requests.some((request) => request.url.includes('/repos')));
    assert.equal(typesDetail(plan), 'org-wide: add 2, enable 1');
    assert.deepEqual(typesLines(plan), [
      { label: '  add', detail: 'Decision, Brief' },
      { label: '  enable', detail: 'SLICE' },
    ]);
    assert.equal(
      typesQuestion(plan, 'example-app'),
      'Issue types are an organisation-wide setting, so they apply to every repository in example-org, not only example-app. In the example-org organisation, add the issue types Decision, Brief, enable SLICE?',
    );
    const { io, out } = capture();
    await applyTypes(sys, io, OWNER_TOKEN, plan);
    assert.deepEqual(board.disabledTypes, []);
    assert.deepEqual(out, ['✓ enabled the issue types SLICE in example-org', '✓ issue types in example-org: Work item, Slice, State, Decision, Brief']);
  });

  it('changes nothing on a rerun, and catches a type re-enabled since', async () => {
    const { sys, board } = org();
    board.issues = [{ repo: SLUG, number: 4, type: 'Task' }];
    const { io } = capture();
    await applyTypes(sys, io, OWNER_TOKEN, await typesPlan(sys, OWNER_TOKEN, 'example-org'));
    assert.deepEqual(board.issues[0]?.type, 'Brief');
    assert.deepEqual(board.disabledTypes, ['Task', 'Bug', 'Feature']);

    const again = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.equal(typesChange(again), false);
    assert.equal(typesQuestion(again, 'example-app'), undefined);
    assert.equal(typesDetail(again), 'org-wide, the work model’s alone');
    assert.deepEqual(typesLines(again), []);

    board.disabledTypes = ['Task', 'Feature'];
    board.issues.push({ repo: OTHER, number: 11, type: 'Bug' });
    const reenabled = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(reenabled.retype.map((issue) => `${issue.repo}#${issue.number}`), [`${OTHER}#11`]);
    assert.deepEqual(reenabled.disable.map((type) => type.name), ['Bug']);
  });

  it('says why it cannot read a parent', async () => {
    const { sys, board } = org();
    board.issues = [{ repo: SLUG, number: 2, type: 'Task', parent: 99 }];
    await assert.rejects(typesPlan(sys, OWNER_TOKEN, 'example-org'), /cannot read https:\/\/api\.github\.com\/repos\/example-org\/example-app\/issues\/99 \(HTTP 404\)/);
  });

  it("reads a parent with no type as not a Work item", async () => {
    const { sys, board } = org();
    board.issues = [
      { repo: SLUG, number: 1, type: null, subIssues: 1 },
      { repo: SLUG, number: 2, type: 'Task', parent: 1 },
    ];
    assert.equal((await typesPlan(sys, OWNER_TOKEN, 'example-org')).retype[0]?.to, 'Brief');
  });
});

describe('withinApproved', () => {
  it('changes nothing the approved plan did not show, keeping the type a later issue holds', async () => {
    const { sys, board } = org();
    board.issues = [{ repo: SLUG, number: 1, type: 'Task' }];
    const approved = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    board.issues.push({ repo: OTHER, number: 2, type: 'Task' }, { repo: OTHER, number: 3, type: 'Bug', subIssues: 1 });
    board.issues[0] = { repo: SLUG, number: 1, type: 'Task', subIssues: 1 };
    const plan = withinApproved(await typesPlan(sys, OWNER_TOKEN, 'example-org'), approved);
    assert.deepEqual(plan.retype, []);
    assert.deepEqual(plan.late.map((issue) => `${issue.repo}#${issue.number} ${issue.to}`), [`${SLUG}#1 Work item`, `${OTHER}#2 Brief`, `${OTHER}#3 Work item`]);
    assert.deepEqual(plan.disable.map((type) => type.name), ['Feature']);
    assert.deepEqual(plan.kept.map((type) => type.name), ['Task', 'Bug']);
    const { io, out } = capture();
    const byHand = await applyTypes(sys, io, OWNER_TOKEN, plan);
    assert.deepEqual(board.disabledTypes, ['Feature']);
    assert.ok(!sys.requests.some((request) => request.method === 'PATCH'));
    assert.ok(out.includes(`- ${OTHER}#2 keeps Task: onboard found it after showing its plan`));
    assert.deepEqual(byHand, [`issue types: niyam onboard again, to retype ${SLUG}#1, ${OTHER}#2, ${OTHER}#3, found after the plan`]);
  });

  it('rejects as GitHub does when a call fails', async () => {
    const { sys } = org();
    sys.handlers.unshift(() => {
      throw new Error('connection dropped');
    });
    await assert.rejects(typesPlan(sys, OWNER_TOKEN, 'example-org'), /connection dropped/);
  });

  it('reads past a full page of repositories', async () => {
    const { sys, board } = org();
    board.orgRepos = Array.from({ length: 101 }, (_, index) => ({ full_name: `example-org/repo-${index + 1}` }));
    board.issues = [{ repo: 'example-org/repo-101', number: 1, type: 'Task' }];
    assert.deepEqual((await typesPlan(sys, OWNER_TOKEN, 'example-org')).retype.map((issue) => issue.repo), ['example-org/repo-101']);
  });
});

describe('applyTypes', () => {
  it('retypes every issue before it disables a type, sending each type back whole', async () => {
    const { sys, board } = org();
    board.issues = [
      { repo: SLUG, number: 1, type: 'Work item', subIssues: 1 },
      { repo: SLUG, number: 2, type: 'Task', parent: 1 },
      { repo: OTHER, number: 3, type: 'Bug' },
    ];
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    const before = sys.requests.length;
    const { io, out } = capture();
    assert.deepEqual(await applyTypes(sys, io, OWNER_TOKEN, plan), []);
    const writes = sys.requests.slice(before).map((request) => `${request.method} ${request.url.replace('https://api.github.com', '')} ${JSON.stringify(request.body)}`);
    assert.deepEqual(writes, [
      `PATCH /repos/${SLUG}/issues/2 {"type":"Slice"}`,
      `PATCH /repos/${OTHER}/issues/3 {"type":"Brief"}`,
      'PUT /orgs/example-org/issue-types/6 {"name":"Task","description":"Task issues","color":"gray","is_enabled":false}',
      'PUT /orgs/example-org/issue-types/7 {"name":"Bug","description":"Bug issues","color":"gray","is_enabled":false}',
      'PUT /orgs/example-org/issue-types/8 {"name":"Feature","description":"Feature issues","color":"gray","is_enabled":false}',
    ]);
    assert.ok(sys.requests.every((request) => request.token === OWNER_TOKEN));
    assert.deepEqual(out, [
      `✓ retyped ${SLUG}#2 Task → Slice: its parent #1 is a Work item`,
      `✓ retyped ${OTHER}#3 Bug → Brief: it has no parent and no sub-issues`,
      '✓ disabled the issue types Task, Bug, Feature in example-org, outside the work model, once no issue held them; not deleted, so they can be enabled again',
      '✓ issue types in example-org: Work item, Slice, State, Decision, Brief',
    ]);
  });

  it('stops, disabling nothing, when GitHub does not retype an issue', async () => {
    for (const refusal of [{ status: 403, json: null }, { status: 200, json: { type: { name: 'Task' } } }]) {
      const { sys, board } = org();
      board.issues = [{ repo: SLUG, number: 4, type: 'Task' }];
      const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
      sys.route('PATCH', `/repos/${SLUG}/issues/4`, refusal);
      await assert.rejects(applyTypes(sys, capture().io, OWNER_TOKEN, plan), new RegExp(`GitHub did not make ${SLUG}#4 a Brief \\(HTTP ${refusal.status}\\)`));
      assert.deepEqual(board.disabledTypes, []);
    }
  });

  it('says which type GitHub would not add, enable or disable', async () => {
    const { sys } = org();
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    sys.route('PUT', '/orgs/example-org/issue-types/6', { status: 422, json: null });
    await assert.rejects(applyTypes(sys, capture().io, OWNER_TOKEN, plan), /GitHub did not disable the issue type Task \(HTTP 422\)/);
    const enabling = { ...plan, disable: [], enable: [{ id: 6, name: 'Task', description: null, color: null, is_enabled: false }] };
    await assert.rejects(applyTypes(sys, capture().io, OWNER_TOKEN, enabling), /GitHub did not enable the issue type Task \(HTTP 422\)/);
  });
});
