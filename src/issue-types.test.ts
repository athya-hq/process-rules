import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ISSUE_TYPES, applyTypes, issueType, typeFor, typesChange, typesDetail, typesLines, typesPlan, typesQuestion, withinApproved } from './issue-types.ts';
import { Board, OWNER_TOKEN, SLUG } from './fake-board.test.ts';
import { FakeSys, ROOT, capture } from './fake.test.ts';

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
      { repo: SLUG, number: 6, from: 'Feature', to: 'Brief', why: 'its parent #5 is neither a Work item nor a Slice, and it has no sub-issues' },
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
    // Every issue the plan retypes is shown; a run of consecutive ones the same rule retypes alike is one row.
    assert.deepEqual(typesLines(plan), [
      { label: '  example-app#1–#101', detail: 'Task → Brief' },
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

  it('adds the work model types missing and enables those disabled, and lists no type when no other exists', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ['Work item', 'SLICE', 'State'];
    board.disabledTypes = ['SLICE'];
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(plan.add.map((type) => type.name), ['Decision', 'Brief']);
    assert.deepEqual(plan.enable.map((type) => type.name), ['SLICE']);
    assert.ok(!sys.requests.some((request) => request.url.includes('/issues?type=') && !request.url.includes('type=none')));
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

  it('reads a closed parent with no type as not a Work item, and an open one as the type it gets', async () => {
    const { sys, board } = org();
    board.issues = [
      { repo: SLUG, number: 1, type: null, subIssues: 1, closed: true },
      { repo: SLUG, number: 2, type: 'Task', parent: 1 },
    ];
    assert.deepEqual((await typesPlan(sys, OWNER_TOKEN, 'example-org')).retype.map((issue) => [issue.number, issue.to]), [[2, 'Brief']]);
    board.issues[0] = { repo: SLUG, number: 1, type: null, subIssues: 1 };
    assert.deepEqual((await typesPlan(sys, OWNER_TOKEN, 'example-org')).retype.map((issue) => [issue.number, issue.to]), [[2, 'Slice'], [1, 'Work item']]);
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

/** A repository's settings on GitHub, naming its Approvals issue, as the contents API gives them. */
function settingsAt(sys: FakeSys, repo: string, settings: unknown, path = '.github/niyam.json'): void {
  sys.route('GET', `/repos/${repo}/contents/${path}`, { status: 200, json: { content: Buffer.from(JSON.stringify(settings)).toString('base64') } });
}

describe('open issues with no type', () => {
  it('gives each open issue with no type one by the same rule, in every repository, leaving closed ones', async () => {
    const { sys, board } = org();
    board.issueTypes = [...MODEL];
    board.issues = [
      { repo: SLUG, number: 1, type: 'Work item', subIssues: 3 },
      { repo: SLUG, number: 2, type: null, parent: 1 },
      { repo: SLUG, number: 3, type: null, parent: 1 },
      { repo: SLUG, number: 4, type: 'Slice', parent: 1, subIssues: 1 },
      { repo: SLUG, number: 5, type: null, parent: 4 },
      { repo: SLUG, number: 6, type: null, subIssues: 1 },
      { repo: SLUG, number: 7, type: null, parent: 6 },
      { repo: SLUG, number: 8, type: null, closed: true },
      { repo: OTHER, number: 9, type: null },
      { repo: OTHER, number: 10, type: null, pull: true },
    ];
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(plan.retype, [
      { repo: SLUG, number: 2, from: 'no type', to: 'Slice', why: 'its parent #1 is a Work item' },
      { repo: SLUG, number: 3, from: 'no type', to: 'Slice', why: 'its parent #1 is a Work item' },
      { repo: SLUG, number: 5, from: 'no type', to: 'State', why: 'its parent #4 is a Slice' },
      { repo: SLUG, number: 6, from: 'no type', to: 'Work item', why: 'it has 1 sub-issue' },
      { repo: SLUG, number: 7, from: 'no type', to: 'Slice', why: 'its parent #6 is a Work item' },
      { repo: OTHER, number: 9, from: 'no type', to: 'Brief', why: 'it has no parent and no sub-issues' },
    ]);
    assert.ok(typesChange(plan));
    assert.equal(typesDetail(plan), 'org-wide: type 6');
    assert.deepEqual(typesLines(plan), [
      { label: '  example-app#2–#3', detail: 'no type → Slice: its parent #1 is a Work item' },
      { label: '  example-app#5', detail: 'no type → State: its parent #4 is a Slice' },
      { label: '  example-app#6', detail: 'no type → Work item: it has 1 sub-issue' },
      { label: '  example-app#7', detail: 'no type → Slice: its parent #6 is a Work item' },
      { label: '  example-site#9', detail: 'no type → Brief: it has no parent and no sub-issues' },
      { label: '  closed, no type', detail: 'left as they are' },
    ]);
    assert.match(typesQuestion(plan, 'example-app') ?? '', /In the example-org organisation, give 6 open issues with no type a work model type \(example-org\/example-app#2 no type → Slice; /);

    const { io, out } = capture();
    assert.deepEqual(await applyTypes(sys, io, OWNER_TOKEN, plan), []);
    assert.ok(out.includes(`✓ typed ${SLUG}#5 a State: its parent #4 is a Slice`));
    assert.equal(board.issues.find((issue) => issue.number === 8)?.type, null, 'a closed issue keeps no type');
    assert.equal(typesChange(await typesPlan(sys, OWNER_TOKEN, 'example-org')), false, 'a rerun changes nothing');
  });

  it('names both kinds in its question, when it retypes and types', async () => {
    const { sys, board } = org();
    board.issues = [
      { repo: SLUG, number: 1, type: 'Task' },
      { repo: SLUG, number: 2, type: null },
    ];
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.equal(typesDetail(plan), 'org-wide: retype 1, type 1, disable 3');
    assert.match(typesQuestion(plan, 'example-app') ?? '', /give 1 issue holding another type and 1 open issue with no type a work model type/);
  });

  it("leaves a repository's Approvals issue with no type, as its settings name it under either name", async () => {
    const { sys, board } = org();
    board.issueTypes = [...MODEL];
    board.issues = [
      { repo: SLUG, number: 3376, type: null },
      { repo: SLUG, number: 12, type: null },
      { repo: OTHER, number: 40, type: null },
    ];
    settingsAt(sys, SLUG, { owner: 'example-owner', agent: 'ExampleBot', approvals: 3376 });
    settingsAt(sys, OTHER, { approvals: 40 }, '.github/process-rules.json');
    const plan = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(plan.retype.map((issue) => issue.number), [12]);
    assert.deepEqual(plan.exempt, [
      { repo: SLUG, number: 3376 },
      { repo: OTHER, number: 40 },
    ]);
    assert.deepEqual(typesLines(plan).slice(1, 3), [
      { label: '  example-app#3376', detail: 'keeps no type: its repository’s Approvals issue, a standing record no work model type fits' },
      { label: '  example-site#40', detail: 'keeps no type: its repository’s Approvals issue, a standing record no work model type fits' },
    ]);
    const { io, out } = capture();
    await applyTypes(sys, io, OWNER_TOKEN, plan);
    assert.ok(out.includes(`- ${SLUG}#3376 keeps no type: it is the Approvals issue its repository's settings name`));
    assert.ok(!sys.requests.some((request) => request.method === 'PATCH' && request.url.endsWith('/3376')));
    // Read again at the run, it is still left, and nothing is late.
    assert.deepEqual(withinApproved(await typesPlan(sys, OWNER_TOKEN, 'example-org'), plan).late, []);
  });

  it('types an Approvals issue settings that do not parse, or name none, leave unnamed; and says why it cannot read them', async () => {
    const { sys, board } = org();
    board.issueTypes = [...MODEL];
    board.issues = [{ repo: SLUG, number: 7, type: null }, { repo: OTHER, number: 8, type: null }];
    sys.route('GET', `/repos/${SLUG}/contents/.github/niyam.json`, { status: 200, json: { content: Buffer.from('{').toString('base64') } });
    settingsAt(sys, OTHER, { approvals: 'seven' });
    assert.deepEqual((await typesPlan(sys, OWNER_TOKEN, 'example-org')).retype.map((issue) => issue.number), [7, 8]);
    sys.route('GET', `/repos/${SLUG}/contents/.github/niyam.json`, { status: 403, json: null });
    await assert.rejects(typesPlan(sys, OWNER_TOKEN, 'example-org'), /cannot read \.github\/niyam\.json in example-org\/example-app \(HTTP 403\)/);
  });

  it('types nothing GitHub lists with a type, as when it ignores the filter', async () => {
    const { sys, board } = org();
    board.issueTypes = [...MODEL];
    sys.route('GET', `/repos/${SLUG}/issues?type=none&state=open&per_page=100&page=1`, {
      status: 200,
      json: [{ number: 1, url: `https://api.github.com/repos/${SLUG}/issues/1`, type: { name: 'Slice' } }],
    });
    assert.deepEqual((await typesPlan(sys, OWNER_TOKEN, 'example-org')).retype, []);
  });

  it('leaves an open issue with no type in an archived repository, and one found after the plan', async () => {
    const { sys, board } = org();
    board.issueTypes = [...MODEL];
    board.orgRepos = [{ full_name: SLUG }, { full_name: OTHER, archived: true }];
    board.issues = [{ repo: OTHER, number: 2, type: null }];
    const approved = await typesPlan(sys, OWNER_TOKEN, 'example-org');
    assert.deepEqual(approved.held, [{ repo: OTHER, number: 2, from: 'no type', to: 'Brief', why: 'it has no parent and no sub-issues' }]);
    board.issues.push({ repo: SLUG, number: 5, type: null });
    const plan = withinApproved(await typesPlan(sys, OWNER_TOKEN, 'example-org'), approved);
    const { io, out } = capture();
    const byHand = await applyTypes(sys, io, OWNER_TOKEN, plan);
    assert.ok(!sys.requests.some((request) => request.method === 'PATCH'));
    assert.ok(out.includes(`- ${OTHER}#2 keeps no type: ${OTHER} is archived, which GitHub keeps read-only`));
    assert.ok(out.includes(`- ${SLUG}#5 keeps no type: onboard found it after showing its plan`));
    assert.equal(byHand.length, 2);
  });
});

describe('typeFor', () => {
  it('reads a parent of a type outside the work model, or none, as neither', () => {
    assert.deepEqual(typeFor({ number: '3', type: undefined }, 0), { to: 'Brief', why: 'its parent #3 is neither a Work item nor a Slice, and it has no sub-issues' });
    assert.deepEqual(typeFor({ number: '3', type: 'slice' }, 2), { to: 'State', why: 'its parent #3 is a Slice' });
    assert.deepEqual(typeFor(undefined, 2), { to: 'Work item', why: 'it has 2 sub-issues' });
  });
});

describe('issueType', () => {
  const EVENT = '/run/event.json';
  const URL = `/repos/${SLUG}/issues/7`;
  function job(event: unknown, settings: unknown = { owner: 'example-owner', agent: 'ExampleBot', features: ['board'], approvals: 3 }, name = 'issues'): FakeSys {
    const sys = new FakeSys();
    sys.env = { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: EVENT, GITHUB_REPOSITORY: SLUG, GH_TOKEN: 'ghs_run' };
    sys.files.set(EVENT, JSON.stringify(event));
    sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify(settings));
    return sys;
  }
  const opened = (number = 7, action = 'opened', owner = 'Organization') => ({ action, issue: { number }, repository: { owner: { type: owner } } });
  async function run(sys: FakeSys): Promise<{ code: number; out: string[] }> {
    const { io, out, err } = capture();
    const code = await issueType(sys, io);
    assert.deepEqual(err, []);
    return { code, out };
  }

  it("gives an issue opened with no type the work model's, read when the job runs", async () => {
    for (const action of ['opened', 'reopened']) {
      const sys = job(opened(7, action));
      sys.route('GET', URL, { status: 200, json: { number: 7, type: null, parent_issue_url: `https://api.github.com/repos/${SLUG}/issues/2`, sub_issues_summary: { total: 0 } } });
      sys.route('GET', `/repos/${SLUG}/issues/2`, { status: 200, json: { number: 2, type: { name: 'Work item' } } });
      sys.route('PATCH', URL, { status: 200, json: { number: 7, type: { name: 'Slice' } } });
      assert.deepEqual(await run(sys), { code: 0, out: ['issue-type: #7 had no type; now a Slice: its parent #2 is a Work item'] });
      const patch = sys.requests.find((request) => request.method === 'PATCH');
      assert.deepEqual([patch?.body, patch?.token], [{ type: 'Slice' }, 'ghs_run']);
    }
  });

  it('gives an issue with no parent and no sub-issues a Brief', async () => {
    const sys = job(opened());
    sys.route('GET', URL, { status: 200, json: { number: 7, type: null } });
    sys.route('PATCH', URL, { status: 200, json: { number: 7, type: { name: 'Brief' } } });
    assert.deepEqual((await run(sys)).out, ['issue-type: #7 had no type; now a Brief: it has no parent and no sub-issues']);
  });

  it('leaves an issue with a type, the Approvals issue, a pull request, a personal repository and other events alone', async () => {
    const typed = job(opened());
    typed.route('GET', URL, { status: 200, json: { number: 7, type: { name: 'Decision' } } });
    assert.deepEqual((await run(typed)).out, ['issue-type: #7 is a Decision already; nothing to do']);
    const pull = job(opened());
    pull.route('GET', URL, { status: 200, json: { number: 7, type: null, pull_request: {} } });
    assert.deepEqual((await run(pull)).out, ['issue-type: #7 is a pull request, which has no type']);
    const cases: [FakeSys, string][] = [
      [job(opened(3)), 'issue-type: #3 is the Approvals issue, which keeps no type'],
      [job(opened(7, 'opened', 'User')), 'issue-type: GitHub has issue types for organisations only; #7 is left as it is'],
      [job(opened(7, 'labeled')), 'issue-type: nothing to do on a issues event (labeled)'],
      [job({}, undefined, 'schedule'), 'issue-type: nothing to do on a schedule event'],
      [job(opened(), { owner: 'example-owner', agent: 'ExampleBot', features: ['identity'] }), 'issue-type: board is off in .github/niyam.json; nothing to check'],
    ];
    for (const [sys, line] of cases) {
      assert.deepEqual(await run(sys), { code: 0, out: [line] });
      assert.ok(!sys.requests.some((request) => request.method === 'PATCH'));
    }
    const bare = job(opened());
    bare.files.delete(`${ROOT}/.github/niyam.json`);
    assert.match((await run(bare)).out[0] ?? '', /^issue-type: the base branch has no \.github\/niyam\.json/);
  });

  it('fails, saying why, when GitHub does not set the type or cannot be read', async () => {
    const refused = job(opened());
    refused.route('GET', URL, { status: 200, json: { number: 7, type: null } });
    refused.route('PATCH', URL, { status: 422, json: null });
    await assert.rejects(issueType(refused, capture().io), /GitHub did not make #7 a Brief \(HTTP 422\); the owner runs niyam onboard/);
    // GitHub drops a type silently where the token may not set it.
    const dropped = job(opened());
    dropped.route('GET', URL, { status: 200, json: { number: 7, type: null } });
    dropped.route('PATCH', URL, { status: 200, json: { number: 7, type: null } });
    await assert.rejects(issueType(dropped, capture().io), /GitHub did not make #7 a Brief \(HTTP 200\)/);
    await assert.rejects(issueType(job(opened()), capture().io), /cannot read #7 \(HTTP 404\)/);
    const orphan = job(opened());
    orphan.route('GET', URL, { status: 200, json: { number: 7, type: null, parent_issue_url: `https://api.github.com/repos/${SLUG}/issues/2` } });
    await assert.rejects(issueType(orphan, capture().io), /cannot read the parent of #7 \(HTTP 404\)/);
    const outside = job(opened());
    outside.env = {};
    await assert.rejects(issueType(outside, capture().io), /issue-type runs in GitHub Actions/);
  });
});
