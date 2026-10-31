import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIELDS, ISSUE_TYPES, LABELS, VIEWS, setUpBoard, viewsChecklist } from './board.ts';
import { BUILT_IN, Board, COPY_URL, OWNER_TOKEN, SLUG, URL, defaultView, settledViews } from './fake-board.test.ts';
import type { FakeItem } from './fake-board.test.ts';
import { FakeSys, capture } from './fake.test.ts';

async function setUp(sys: FakeSys, answers = ['y', 'y', 'y', 'y', 'y']): Promise<{ url: string | undefined; out: string[]; err: string[] }> {
  sys.answers = [...answers];
  const { io, out, err } = capture();
  const confirm = async (question: string) => /^y/.test(await sys.ask(question));
  return { url: await setUpBoard(sys, io, confirm, SLUG, 'example-owner'), out, err };
}

describe('setUpBoard', () => {
  it('builds the Project, its fields and views when the template cannot be copied', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.template = 'missing';
    const { url, out, err } = await setUp(sys);
    assert.deepEqual(err, []);
    assert.equal(url, URL);
    assert.deepEqual(board.titles, ['example-app work']);
    assert.deepEqual(board.issueTypes, ['Task', 'Bug', ...ISSUE_TYPES.map((t) => t.name)]);
    assert.deepEqual(board.labels, ['bug', ...LABELS.map((l) => l.name)]);
    assert.deepEqual(board.project?.fields, [...BUILT_IN, ...FIELDS.map((f) => f.name)]);
    assert.deepEqual(out.slice(0, 6), [
      '✓ issue types in example-org: Work item, Slice, State, Decision, Brief',
      '✓ labels: approved, needs-owner, mechanical, veto, expiring, cannot-run-here',
      '- the process-rules template could not be copied (GitHub shows no Project 4 in athya-hq); building the Project instead',
      `✓ Project "example-app work": ${URL}`,
      '✓ fields: Step, Decision, Review date',
      '✓ views: Needs you, Board, Work items, Decisions, Reviews due',
    ]);
    assert.deepEqual(out.slice(6), viewsChecklist(URL));
    assert.deepEqual(board.project?.views, [
      { id: 'V_1', name: 'Needs you', layout: 'TABLE_LAYOUT', filter: 'label:needs-owner is:open', visible: ['Title', 'Status'] },
      { id: 'V_2', name: 'Board', layout: 'BOARD_LAYOUT', filter: '', visible: ['Title', 'Status', 'Linked pull requests'] },
      { id: 'V_3', name: 'Work items', layout: 'TABLE_LAYOUT', filter: 'type:"Work item"', visible: ['Title', 'Status', 'Sub-issues progress'] },
      { id: 'V_4', name: 'Decisions', layout: 'TABLE_LAYOUT', filter: 'type:Decision', visible: ['Title', 'Status'] },
      { id: 'V_5', name: 'Reviews due', layout: 'TABLE_LAYOUT', filter: '"Review date":<=@today', visible: ['Title', 'Status'] },
    ]);
    assert.ok(sys.asked.includes('Set up the views Needs you, Board, Work items, Decisions, Reviews due in "example-app work" (renaming "View 1" to "Needs you")?'));
    assert.ok(sys.requests.filter((r) => r.url.includes('/orgs/') || r.url.includes('/labels') || r.url.endsWith('/graphql')).every((r) => r.token === OWNER_TOKEN));
    const step = sys.requests.find((r) => (r.body as { variables?: { name?: string } } | undefined)?.variables?.name === 'Step');
    assert.deepEqual((step?.body as { variables: unknown }).variables, {
      project: 'P_1',
      name: 'Step',
      type: 'SINGLE_SELECT',
      options: ['Frame', 'Specify', 'Slice', 'Build'].map((name) => ({ name, color: 'GRAY', description: '' })),
    });
    const date = sys.requests.find((r) => (r.body as { variables?: { name?: string } } | undefined)?.variables?.name === 'Review date');
    assert.deepEqual((date?.body as { variables: { type: string; options: unknown } }).variables.type, 'DATE');
  });

  it('uses the default title for a blank one', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.template = 'missing';
    sys.answers = ['y', 'y', 'y', 'y', 'y'];
    await setUpBoard(sys, capture().io, async (q) => /^y/.test(await sys.ask(q)), SLUG, 'example-owner', '  ');
    assert.deepEqual(board.titles, ['example-app work']);
  });

  it('asks nothing when everything is there', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name.toUpperCase());
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    const { url, out } = await setUp(sys, []);
    assert.ok(!out.some((line) => line.startsWith('Finish the Project')));
    assert.equal(url, URL);
    assert.deepEqual(sys.asked, []);
    assert.ok(!board.operations.includes('createProjectV2('));
  });

  it('skips issue types for a personal repository', async () => {
    const sys = new FakeSys();
    new Board(sys, false);
    sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'project' });
    const { url, out } = await setUp(sys, ['y', 'y', 'y', 'y']);
    assert.equal(url, COPY_URL);
    assert.equal(out[0], '- issue types: GitHub has them for organisations only; skipped for a personal repository');
  });

  it('copies the template for a new Project, links it, and leaves nothing to do by hand', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyPending = 2;
    const { url, out, err } = await setUp(sys, ['y', 'y', 'y']);
    assert.deepEqual(err, []);
    assert.equal(url, COPY_URL);
    assert.deepEqual(board.titles, ['example-app work']);
    assert.ok(board.project?.linked);
    assert.deepEqual(sys.slept, [3000, 3000], 'waits for the fields GitHub adds after the copy');
    assert.deepEqual(sys.asked.slice(2), ['Create the Project "example-app work" for example-org from the process-rules template, linked to example-org/example-app?']);
    assert.deepEqual(out.slice(2), [
      `✓ Project "example-app work": ${COPY_URL}`,
      '✓ fields: Step, Decision, Review date',
      '✓ views: Needs you, Board, Work items, Decisions, Reviews due',
    ]);
    assert.ok(!board.operations.some((o) => o === 'createProjectV2(' || o === 'createProjectV2Field' || o.includes('ProjectV2View')));
  });

  it("names a copy's workflows that are off", async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyOff = ['Item added to project', 'Pull request merged'];
    const { out } = await setUp(sys, ['y', 'y', 'y']);
    assert.equal(out.at(-1), `Turn on the workflows Item added to project, Pull request merged in ${COPY_URL} → Workflows (GitHub's API cannot)`);
    assert.ok(!out.some((line) => line.startsWith('Finish the Project')));
  });

  it("throws when a copy's fields never arrive", async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyPending = 100;
    await assert.rejects(setUp(sys), new Error(`the copy ${COPY_URL} has no fields Step, Decision, Review date yet; run onboard again`));
    assert.equal(sys.slept.length, 19);
  });

  it('builds the Project when GitHub refuses the copy', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.template = 'refused';
    const { url, out } = await setUp(sys);
    assert.equal(url, URL);
    assert.ok(out.includes("- the process-rules template could not be copied (GitHub's GraphQL API refused: Resource not accessible by integration); building the Project instead"));
    assert.deepEqual(out.slice(-4), viewsChecklist(URL));
    assert.ok(board.operations.includes('createProjectV2('));
  });

  /** A Project made before the template: not grouped, with items and a field the template lacks. */
  function older(board: Board, items: FakeItem[]): void {
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name), 'Estimate', 'Notes'], linked: true, views: settledViews(), items };
  }

  it('replaces a Project made before the template with a copy, moving its open items and their values', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [
      { content: 'ISSUE_a', values: { Status: 'In Progress', Step: 'Build', 'Review date': '2026-11-01', Estimate: 3, Notes: 'n' } },
      { draft: { title: 'An idea', body: 'Some words' }, values: { Decision: 'Tripped' } },
      { content: 'ISSUE_old', archived: true, values: { Status: 'Done' } },
      { content: 'ISSUE_c', values: { Step: 'Gone' } },
      { content: 'ISSUE_done', state: 'CLOSED', values: {} },
      { content: 'PR_merged', state: 'MERGED', values: {} },
      { content: 'PR_open', state: 'OPEN', values: {} },
    ]);
    const { url, out, err } = await setUp(sys, ['y']);
    assert.deepEqual(err, []);
    assert.equal(url, COPY_URL);
    assert.deepEqual(sys.asked, [
      '"example-app work" lacks what only the process-rules template sets (the views\' grouping, the workflows). Replace it with a copy of the template, moving its 4 open items with their Status, Step, Decision and Review date (not Estimate, Notes, which the template lacks), and close it as "example-app work (old)"?',
    ]);
    assert.deepEqual(board.project?.items, [
      { content: 'ISSUE_a', values: { Status: 'In progress', Step: 'Build', 'Review date': '2026-11-01' } },
      { draft: { title: 'An idea', body: 'Some words' }, values: { Decision: 'Tripped' } },
      { content: 'ISSUE_c', values: {} },
      { content: 'PR_open', values: {} },
    ]);
    assert.ok(board.project?.linked);
    const order = board.operations.filter((o) => o === 'updateProjectV2(' || o === 'copyProjectV2');
    assert.deepEqual(order, ['updateProjectV2(', 'copyProjectV2', 'updateProjectV2('], 'renamed before the copy, closed after the move');
    assert.deepEqual({ title: board.old?.title, closed: board.old?.closed }, { title: 'example-app work (old)', closed: true });
    assert.deepEqual(out.slice(2, 4), [
      `✓ moved 4 items to the copy; closed the old Project as "example-app work (old)": ${URL}`,
      `✓ Project "example-app work": ${COPY_URL}`,
    ]);
    assert.ok(!out.some((line) => line.startsWith('Finish the Project')));
  });

  it('moves every page of items, and says "item" for one', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [{ content: 'ISSUE_a', values: {} }]);
    board.project!.fields = [...BUILT_IN, ...FIELDS.map((f) => f.name)];
    board.itemsPerPage = 1;
    board.project!.items!.push({ content: 'ISSUE_b', values: {} }, { content: 'ISSUE_c', values: {} });
    await setUp(sys, ['y']);
    assert.deepEqual(board.project?.items?.map((item) => item.content), ['ISSUE_a', 'ISSUE_b', 'ISSUE_c']);

    const one = new FakeSys();
    const single = new Board(one);
    older(single, [{ content: 'ISSUE_a', values: {} }]);
    single.project!.fields = [...BUILT_IN, ...FIELDS.map((f) => f.name)];
    const { out } = await setUp(one, ['y']);
    assert.match(one.asked[0] ?? '', /moving its 1 open item with their Status, Step, Decision and Review date, and close it/);
    assert.ok(out.includes(`✓ moved 1 item to the copy; closed the old Project as "example-app work (old)": ${URL}`));
  });

  it('keeps a Project made before the template when the owner says no, naming what is left to do', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [{ content: 'ISSUE_a', values: {} }]);
    const { url, out } = await setUp(sys, ['n']);
    assert.equal(url, URL);
    assert.ok(!board.operations.includes('copyProjectV2'));
    assert.equal(board.project?.closed, undefined);
    assert.deepEqual(out.slice(-4), viewsChecklist(URL));
  });

  it('keeps a Project made before the template when GitHub refuses the copy', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [{ content: 'ISSUE_a', values: {} }]);
    board.template = 'refused';
    const { url, out } = await setUp(sys, ['y']);
    assert.equal(url, URL);
    assert.deepEqual({ title: board.project?.title, closed: board.project?.closed }, { title: 'example-app work', closed: false });
    assert.ok(out.includes("- the process-rules template could not be copied (GitHub's GraphQL API refused: Resource not accessible by integration); keeping the Project as it is"));
    assert.deepEqual(out.slice(-4), viewsChecklist(URL));
  });

  for (const [name, change, message] of [
    ['gh not signed in', (sys: FakeSys) => (sys.ghToken = undefined), 'onboard: gh is not signed in; sign in as example-owner with: gh auth login -s project'],
    ['gh signed in as someone else', (sys: FakeSys) => sys.acceptToken(OWNER_TOKEN, 'someone'), 'onboard: gh is signed in as someone, not the owner example-owner'],
    ['gh with a token GitHub refuses', (sys: FakeSys) => (sys.ghToken = 'gho_bad'), 'onboard: gh is signed in as nobody GitHub accepts, not the owner example-owner'],
    ['gh without the scopes', (sys: FakeSys) => sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'repo, project' }), 'onboard: your gh login lacks admin:org; run: gh auth refresh -h github.com -s admin:org'],
    ['gh reporting no scopes', (sys: FakeSys) => sys.acceptToken(OWNER_TOKEN, 'example-owner', {}), 'onboard: your gh login lacks project, admin:org; run: gh auth refresh -h github.com -s project,admin:org'],
  ] as const) {
    it(`stops with ${name}`, async () => {
      const sys = new FakeSys();
      new Board(sys);
      change(sys);
      const { url, err } = await setUp(sys);
      assert.deepEqual({ url, err }, { url: undefined, err: [message] });
    });
  }

  for (const [index, step] of ['issue types', 'labels', 'project', 'fields', 'views'].entries()) {
    it(`stops when "${step}" is declined, changing nothing from it on`, async () => {
      const sys = new FakeSys();
      const board = new Board(sys);
      board.template = 'missing';
      const { url, err } = await setUp(sys, [...Array<string>(index).fill('y'), 'n']);
      assert.deepEqual({ url, err }, { url: undefined, err: [`onboard: stopped at "${step}"; nothing after it was changed`] });
      assert.equal(board.issueTypes.length, index > 0 ? 7 : 2);
      assert.equal(board.labels.length, index > 1 ? 7 : 1);
      assert.equal(board.project === undefined, index < 3);
      assert.deepEqual(board.project?.fields ?? [], index === 3 ? BUILT_IN : index === 4 ? [...BUILT_IN, ...FIELDS.map((f) => f.name)] : []);
      assert.deepEqual(board.project?.views ?? [], index > 2 ? [defaultView()] : []);
    });
  }

  it("links a same-titled Project that is not linked to the repo", async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.project = { fields: FIELDS.map((f) => f.name), linked: false, views: settledViews(), grouped: true };
    const { url } = await setUp(sys, ['y', 'y', 'y']);
    assert.equal(url, URL);
    assert.ok(board.project.linked);
    assert.ok(sys.asked.includes('Link the Project "example-app work" to example-org/example-app?'));
  });

  it('stops when linking is declined', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.project = { fields: FIELDS.map((f) => f.name), linked: false, grouped: true };
    const { err } = await setUp(sys, ['y', 'y', 'n']);
    assert.deepEqual(err, ['onboard: stopped at "project"; nothing after it was changed']);
    assert.equal(board.project.linked, false);
  });

  it('finds the Project on a later page instead of making another', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.project = { fields: FIELDS.map((f) => f.name), linked: true, views: settledViews(), grouped: true };
    board.otherPages = 2;
    await setUp(sys, ['y', 'y']);
    assert.deepEqual(board.operations.filter((o) => o === 'projectsV2('), ['projectsV2(', 'projectsV2(', 'projectsV2(']);
    assert.ok(!board.operations.includes('createProjectV2('));
  });

  it('reads every page of labels before adding any', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` }));
    sys.route('GET', `/repos/${SLUG}/labels?per_page=100&page=1`, { status: 200, json: many });
    sys.route('GET', `/repos/${SLUG}/labels?per_page=100&page=2`, { status: 200, json: LABELS.map((l) => ({ name: l.name })) });
    await setUp(sys, ['y', 'y']);
    assert.ok(!sys.requests.some((r) => r.method === 'POST' && r.url.endsWith('/labels')));
  });

  it('updates the views that have the names, and makes the missing ones, leaving others alone', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    views[1] = { ...views[1]!, layout: 'TABLE_LAYOUT', filter: 'is:open', visible: ['Title', 'Assignees'] };
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: [...views.slice(0, 4), { id: 'V_9', name: 'Mine', layout: 'TABLE_LAYOUT', filter: null, visible: ['Title'] }], grouped: true };
    const { out } = await setUp(sys, ['y', 'y', 'y']);
    assert.ok(out.includes('✓ views: Needs you, Board, Work items, Decisions, Reviews due'));
    assert.ok(sys.asked.includes('Set up the views Board, Reviews due in "example-app work"?'));
    assert.deepEqual(board.project.views?.map((v) => v.name), ['Needs you', 'Board', 'Work items', 'Decisions', 'Mine', 'Reviews due']);
    assert.deepEqual(board.project.views?.[1], { id: 'V_2', name: 'Board', layout: 'BOARD_LAYOUT', filter: '', visible: ['Title', 'Assignees', 'Linked pull requests'] });
    assert.deepEqual(board.project.views?.[4], { id: 'V_9', name: 'Mine', layout: 'TABLE_LAYOUT', filter: null, visible: ['Title'] });
  });

  it('makes no duplicates when run again', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    await setUp(sys);
    const asked = sys.asked.length;
    const { url } = await setUp(sys, []);
    assert.equal(url, COPY_URL);
    assert.equal(sys.asked.length, asked);
    assert.deepEqual(board.titles, ['example-app work']);
    assert.deepEqual(board.project?.views?.map((v) => v.name), VIEWS.map((v) => v.name));
    assert.ok(!board.operations.some((o) => o.includes('ProjectV2View') || o === 'createProjectV2Field'));
  });

  it('renames the default view to the first view the Project lacks, with no other change', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: [views[0]!, { ...views[1]!, name: 'View 1' }, ...views.slice(2)], grouped: true };
    await setUp(sys, ['y', 'y', 'y']);
    assert.ok(sys.asked.includes('Set up the views Board in "example-app work" (renaming "View 1" to "Board")?'));
    assert.deepEqual(board.project.views, settledViews());
    assert.deepEqual(board.operations.filter((o) => o.includes('View')), ['updateProjectV2View']);
  });

  it('leaves a default view alone once every view is there', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const spare = { id: 'V_9', name: 'View 1', layout: 'TABLE_LAYOUT', filter: null, visible: ['Title'] };
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: [spare, ...settledViews()], grouped: true };
    await setUp(sys, ['y', 'y']);
    assert.ok(!sys.asked.some((q) => q.startsWith('Set up the views')));
    assert.deepEqual(board.project.views, [spare, ...settledViews()]);
    assert.ok(!board.operations.some((o) => o.includes('ProjectV2View')));
  });

  for (const [name, change, message] of [
    ['the repo', (sys: FakeSys) => sys.route('GET', `/repos/${SLUG}`, { status: 404, json: null }), /cannot read example-org\/example-app as example-owner \(HTTP 404\)/],
    ['the issue types', (sys: FakeSys) => sys.route('GET', '/orgs/example-org/issue-types?per_page=100&page=1', { status: 403, json: null }), /cannot read https:\/\/api\.github\.com\/orgs\/example-org\/issue-types \(HTTP 403\)/],
    ['adding an issue type', (sys: FakeSys) => sys.route('POST', '/orgs/example-org/issue-types', { status: 422, json: null }), /did not add the issue type Work item \(HTTP 422\)/],
    ['adding a label', (sys: FakeSys) => sys.route('POST', `/repos/${SLUG}/labels`, { status: 422, json: null }), /did not add the label approved \(HTTP 422\)/],
    ['GraphQL', (sys: FakeSys) => sys.route('POST', '/graphql', { status: 200, json: { errors: [{ message: 'no project scope' }] } }), /GraphQL API refused: no project scope/],
    ['GraphQL by status', (sys: FakeSys) => sys.route('POST', '/graphql', { status: 502, json: null }), /GraphQL API refused: HTTP 502/],
    ['the owner', (sys: FakeSys) => sys.route('POST', '/graphql', { status: 200, json: { data: { organization: null } } }), /GitHub has no organization example-org/],
  ] as const) {
    it(`throws when GitHub refuses ${name}`, async () => {
      const sys = new FakeSys();
      new Board(sys);
      change(sys);
      await assert.rejects(setUp(sys), message);
    });
  }
});
