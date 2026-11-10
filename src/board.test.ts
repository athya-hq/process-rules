import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIELDS, ISSUE_TYPES, LABELS, VIEWS, boardStarted, boardSwept, setUpBoard, stepDue, viewsChecklist } from './board.ts';
import { BUILT_IN, Board, COPY_URL, OWNER_TOKEN, RestBoard, SLUG, STATUS_OPTIONS, STEP_OPTIONS, URL, defaultView, settledViews } from './fake-board.test.ts';
import type { FakeItem } from './fake-board.test.ts';
import { FakeSys, capture } from './fake.test.ts';

async function setUp(sys: FakeSys, answers = ['y', 'y', 'y', 'y', 'y']): Promise<{ url: string | undefined; byHand: string[] | undefined; out: string[]; err: string[] }> {
  sys.answers = [...answers];
  const { io, out, err } = capture();
  const confirm = async (question: string) => /^y/.test(await sys.ask(question));
  const board = await setUpBoard(sys, io, confirm, SLUG, 'example-owner', OWNER_TOKEN);
  return { url: board?.url, byHand: board?.byHand, out, err };
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
    assert.deepEqual(board.disabledTypes, ['Task', 'Bug']);
    assert.deepEqual(out.slice(0, 7), [
      '✓ disabled the issue types Task, Bug in example-org, outside the work model, once no issue held them; not deleted, so they can be enabled again',
      '✓ issue types in example-org: Work item, Slice, State, Decision, Brief',
      '✓ labels: approved, needs-owner, mechanical, veto, expiring, cannot-run-here',
      '- the process-rules template could not be copied (GitHub shows no Project 4 in athya-hq); building the Project instead',
      `✓ Project "example-app work": ${URL}`,
      '✓ fields: Step, Decision, Review date',
      '✓ views: Needs you, Board, Work items, Decisions, Reviews due',
    ]);
    assert.deepEqual(out.slice(7), viewsChecklist(URL));
    assert.deepEqual(board.project?.views, [
      { id: 'V_1', name: 'Needs you', layout: 'TABLE_LAYOUT', filter: 'label:needs-owner is:open', visible: ['Title', 'Status', 'Parent issue'] },
      { id: 'V_2', name: 'Board', layout: 'BOARD_LAYOUT', filter: 'type:Slice,Brief', visible: ['Title', 'Assignees', 'Status', 'Linked pull requests'] },
      { id: 'V_3', name: 'Work items', layout: 'TABLE_LAYOUT', filter: 'type:"Work item"', visible: ['Title', 'Assignees', 'Status', 'Sub-issues progress'] },
      { id: 'V_4', name: 'Decisions', layout: 'TABLE_LAYOUT', filter: 'type:Decision', visible: ['Title', 'Assignees', 'Status'] },
      { id: 'V_5', name: 'Reviews due', layout: 'TABLE_LAYOUT', filter: '"Review date":<=@today', visible: ['Title', 'Assignees', 'Status'] },
    ]);
    assert.equal(
      sys.asked[0],
      'Issue types are an organisation-wide setting, so they apply to every repository in example-org, not only example-app. In the example-org organisation, add the issue types Work item, Slice, State, Decision, Brief, then disable Task, Bug, which can be enabled again?',
    );
    assert.ok(sys.asked.includes('Set up the views Needs you, Board, Work items, Decisions, Reviews due in "example-app work" (renaming "View 1" to "Needs you")?'));
    assert.ok(sys.requests.filter((r) => r.url.includes('/orgs/') || r.url.includes('/labels') || r.url.endsWith('/graphql')).every((r) => r.token === OWNER_TOKEN));
    const step = sys.requests.find((r) => (r.body as { variables?: { name?: string } } | undefined)?.variables?.name === 'Step');
    assert.deepEqual((step?.body as { variables: unknown }).variables, {
      project: 'P_1',
      name: 'Step',
      type: 'SINGLE_SELECT',
      options: ['Frame', 'Specify', 'Slice', 'Build', 'Done'].map((name) => ({ name, color: 'GRAY', description: '' })),
    });
    const date = sys.requests.find((r) => (r.body as { variables?: { name?: string } } | undefined)?.variables?.name === 'Review date');
    assert.deepEqual((date?.body as { variables: { type: string; options: unknown } }).variables.type, 'DATE');
  });

  it('uses the default title for a blank one', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.template = 'missing';
    sys.answers = ['y', 'y', 'y', 'y', 'y'];
    await setUpBoard(sys, capture().io, async (q) => /^y/.test(await sys.ask(q)), SLUG, 'example-owner', OWNER_TOKEN, '  ');
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

  it('adds an option a field made before it lacks, sending each kept option with its id', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true, options: { Step: ['Frame', 'Specify', 'Slice', 'build'] } };
    const { err } = await setUp(sys, ['y']);
    assert.deepEqual(err, []);
    assert.deepEqual(sys.asked, ['Add the option Done to the field Step in "example-app work"?']);
    assert.deepEqual(board.project.options, { Step: ['Frame', 'Specify', 'Slice', 'build', 'Done'] });
    const sent = sys.requests.find((r) => String((r.body as { query?: string } | undefined)?.query).includes('updateProjectV2Field('));
    assert.deepEqual((sent?.body as { variables: unknown }).variables, {
      field: 'F_Step',
      options: [
        ...['Frame', 'Specify', 'Slice', 'build'].map((name) => ({ id: `O_Step_${name}`, name, color: 'GRAY', description: '' })),
        { name: 'Done', color: 'GRAY', description: '' },
      ],
    });
    // A rerun finds the option there and asks nothing.
    sys.asked = [];
    await setUp(sys, []);
    assert.deepEqual(sys.asked, []);
  });

  it('stops when the owner says no to an option', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name);
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true, options: { Step: ['Frame'], Decision: ['Tripped'] } };
    const { url, err } = await setUp(sys, ['n']);
    assert.equal(url, undefined);
    assert.deepEqual(sys.asked, ['Add the options Specify, Slice, Build, Done to the field Step and Needs owner, Decided by the routine to the field Decision in "example-app work"?']);
    assert.deepEqual(err, ['onboard: stopped at "fields"; nothing after it was changed, and no pull request was opened']);
    assert.ok(!board.operations.includes('updateProjectV2Field('));
  });

  it('names only the issue types the organisation lacks, saying they reach every repository in it', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ['Task', 'Work item', 'Slice', 'State'];
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews(), grouped: true };
    await setUp(sys, ['y']);
    assert.deepEqual(sys.asked, [
      'Issue types are an organisation-wide setting, so they apply to every repository in example-org, not only example-app. In the example-org organisation, add the issue types Decision, Brief, then disable Task, which can be enabled again?',
    ]);
    assert.deepEqual(board.issueTypes, ['Task', 'Work item', 'Slice', 'State', 'Decision', 'Brief']);
    assert.deepEqual(board.disabledTypes, ['Task']);
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
    const { url, out, err, byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.deepEqual(err, []);
    assert.equal(url, COPY_URL);
    assert.deepEqual(byHand, []);
    assert.deepEqual(board.titles, ['example-app work']);
    assert.ok(board.project?.linked);
    assert.deepEqual(sys.slept, [3000, 3000], 'waits for the fields GitHub adds after the copy');
    assert.deepEqual(sys.asked.slice(2), ['Create the Project "example-app work" for example-org from the process-rules template, linked to example-org/example-app?']);
    assert.deepEqual(out.slice(3), [
      `✓ Project "example-app work": ${COPY_URL}`,
      '✓ fields: Step, Decision, Review date',
      '✓ views: Needs you, Board, Work items, Decisions, Reviews due',
      "- Board shows slices and briefs; Done keeps one until the Auto-archive items workflow archives it, with the template's filter is:closed updated:<@today-7d, which GitHub's API can neither read nor set",
    ]);
    assert.ok(!board.operations.some((o) => o === 'createProjectV2(' || o === 'createProjectV2Field' || o.includes('ProjectV2View')));
  });

  it("names a copy's workflows that are off", async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.copyOff = ['Item added to project', 'Pull request merged'];
    const { out, byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.equal(out.at(-1), `Turn on the workflows Item added to project, Pull request merged in ${COPY_URL} → Workflows (GitHub's API cannot)`);
    assert.deepEqual(byHand, [`turn on 2 project workflows → ${COPY_URL}/workflows`]);
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
    assert.deepEqual(out.slice(-viewsChecklist(URL).length), viewsChecklist(URL));
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
    const { url, out, byHand } = await setUp(sys, ['n']);
    assert.equal(url, URL);
    assert.deepEqual(byHand, [`Type on Needs you, group 2 views, auto-archive → ${URL}`]);
    assert.ok(!board.operations.includes('copyProjectV2'));
    assert.equal(board.project?.closed, undefined);
    assert.deepEqual(out.slice(-viewsChecklist(URL).length), viewsChecklist(URL));
  });

  it('keeps a Project made before the template when GitHub refuses the copy', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    older(board, [{ content: 'ISSUE_a', values: {} }]);
    board.template = 'refused';
    const { url, out } = await setUp(sys, ['y']);
    assert.equal(url, URL);
    assert.deepEqual({ title: board.project?.title, closed: board.project?.closed }, { title: 'example-app work', closed: undefined }, 'renamed back, its closed state untouched');
    assert.ok(out.includes("- the process-rules template could not be copied (GitHub's GraphQL API refused: Resource not accessible by integration); keeping the Project as it is"));
    assert.deepEqual(out.slice(-viewsChecklist(URL).length), viewsChecklist(URL));
  });

  for (const [index, step] of ['issue types', 'labels', 'project', 'fields', 'views'].entries()) {
    it(`stops when "${step}" is declined, changing nothing from it on`, async () => {
      const sys = new FakeSys();
      const board = new Board(sys);
      board.template = 'missing';
      const { url, err } = await setUp(sys, [...Array<string>(index).fill('y'), 'n']);
      assert.deepEqual({ url, err }, { url: undefined, err: [`onboard: stopped at "${step}"; nothing after it was changed, and no pull request was opened`] });
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
    assert.deepEqual(err, ['onboard: stopped at "project"; nothing after it was changed, and no pull request was opened']);
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
    assert.deepEqual(board.project.views?.[1], { id: 'V_2', name: 'Board', layout: 'BOARD_LAYOUT', filter: 'type:Slice,Brief', visible: ['Title', 'Assignees', 'Linked pull requests'] });
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

  it('hides Assignees on Needs you and shows Parent issue, keeping columns the owner added, then leaves it', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    views[0] = { ...views[0]!, visible: ['Title', 'Assignees', 'Status', 'Linked pull requests', 'Sub-issues progress'] };
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views, grouped: true };
    const { out, byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.ok(sys.asked.includes('Set up the views Needs you in "example-app work"?'));
    assert.deepEqual(board.project.views?.[0]?.visible, ['Title', 'Status', 'Linked pull requests', 'Sub-issues progress', 'Parent issue']);
    assert.deepEqual(board.project.views?.slice(1), settledViews().slice(1));
    // The column list could not name Type, so the owner is told how to show it again.
    const again = `Needs you's columns were set through GitHub's API, which cannot see a Type column, so one shown there may be gone; in ${URL}: Needs you: add the Type column (+ at the right of the headers → Type, then Save)`;
    assert.ok(out.includes(again));
    assert.deepEqual(byHand, [`Type on Needs you again → ${URL}`]);
    // A rerun sends no columns, so a Type the owner adds stays.
    const operations = board.operations.length;
    const rerun = await setUp(sys, ['y', 'y']);
    assert.ok(!board.operations.slice(operations).some((o) => o.includes('ProjectV2View')));
    assert.ok(!rerun.out.includes(again));
    assert.deepEqual(rerun.byHand, []);
  });

  it('changes no columns of a view whose fields are right but whose filter is not', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    views[3] = { ...views[3]!, filter: 'is:open', visible: ['Title', 'Status', 'Labels'] };
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views, grouped: true };
    const { byHand } = await setUp(sys, ['y', 'y', 'y']);
    assert.deepEqual(board.project.views?.[3], { ...settledViews()[3]!, visible: ['Title', 'Status', 'Labels'] });
    const update = sys.requests.find((r) => String((r.body as { query?: string } | undefined)?.query).includes('updateProjectV2View'));
    assert.equal((update?.body as { variables: { configuration: unknown } }).variables.configuration, null);
    assert.deepEqual(byHand, []);
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

describe('boardStarted', () => {
  const ISSUE = `https://api.github.com/repos/${SLUG}/issues`;
  /** Slice #12, open, under work item #10, read through REST. */
  function slice(sys: FakeSys, parent: { status: number; json: unknown } = { status: 200, json: { number: 10, type: { name: 'Work item' } } }): void {
    sys.route('GET', `${ISSUE}/12`, { status: 200, json: { number: 12, state: 'open', url: `${ISSUE}/12`, type: { name: 'Slice' } } });
    sys.route('GET', `${ISSUE}/12/parent`, parent);
  }

  it("moves a user's own board, reading every page", async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys, 'users');
    board.perPage = 1;
    board.projects.unshift({ number: 1, title: 'old', closed: true, fields: { Status: STATUS_OPTIONS }, items: [{ issue: 12, values: {} }] });
    board.workItems = [22, 21, 20, 10];
    board.projects[1]!.items.push({ issue: 22, values: {} });
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "example-app work"',
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #22 had no Step; it is at Frame in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
    // A closed Project is not anyone's board.
    assert.ok(!sys.requests.some((r) => r.url.includes('/projectsV2/1/')));
    assert.ok(sys.requests.some((r) => r.url.startsWith('https://api.github.com/users/example-org/projectsV2?')));
  });

  it('moves only open issues of this repository, on the board and not archived', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.projects[0]!.items = [
      { issue: 12, repo: 'example-org/other', values: { Status: 'Todo' } },
      { issue: 12, kind: 'PullRequest', values: { Status: 'Todo' } },
      { issue: 12, kind: 'DraftIssue', values: {} },
      { issue: 10, archived: true, values: { Step: 'Slice' } },
      // An issue that is not an open Work item keeps no Step.
      { issue: 31, values: {} },
      { issue: 30, values: {} },
    ];
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), []);
    assert.deepEqual(board.writes, []);
  });

  it("moves no work item for a slice with no parent, or one that is not a Work item's", async () => {
    for (const parent of [{ status: 404, json: { message: 'No parent issue found' } }, { status: 200, json: { number: 10, type: { name: 'Slice' } } }]) {
      const sys = new FakeSys();
      slice(sys, parent);
      const board = new RestBoard(sys);
      board.workItems = [21];
      assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), ['✓ board: slice #12 is In Progress in "example-app work"']);
    }
  });

  it("throws when GitHub's REST API refuses a read, naming it", async () => {
    const parent = new FakeSys();
    slice(parent, { status: 403, json: { message: 'Forbidden' } });
    new RestBoard(parent);
    await assert.rejects(boardStarted(parent, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /repos/${SLUG}/issues/12/parent: HTTP 403 Forbidden` });
    // A 404 that does not say the slice has no parent is a read that failed.
    const hidden = new FakeSys();
    slice(hidden, { status: 404, json: { message: 'Not Found' } });
    new RestBoard(hidden);
    await assert.rejects(boardStarted(hidden, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /repos/${SLUG}/issues/12/parent: HTTP 404 Not Found` });
    const bare = new FakeSys();
    slice(bare, { status: 500, json: null });
    new RestBoard(bare);
    await assert.rejects(boardStarted(bare, 'tok', SLUG, 12), { message: `GitHub's REST API refused GET /repos/${SLUG}/issues/12/parent: HTTP 500` });
    const fields = new FakeSys();
    slice(fields);
    new RestBoard(fields).refuse = (method, path) => (path.endsWith('/fields') ? { status: 502, json: null } : undefined);
    await assert.rejects(boardStarted(fields, 'tok', SLUG, 12), { message: "GitHub's REST API refused GET /orgs/example-org/projectsV2/3/fields?per_page=100: HTTP 502" });
    const list = new FakeSys();
    slice(list);
    new RestBoard(list).refuse = (method, path) => (path === '/orgs/example-org/projectsV2' ? { status: 200, json: { message: 'not a list' } } : undefined);
    await assert.rejects(boardStarted(list, 'tok', SLUG, 12), { message: "GitHub's REST API did not answer a list (/orgs/example-org/projectsV2?per_page=100)" });
  });

  it('moves every work item to the Step its facts give, forward only, and a closed one to Done', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.workItems = [10, 20, 21, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51];
    board.projects[0]!.items.push(
      // Closed: Done, whatever Step it had.
      { issue: 40, state: 'closed', subIssues: { total: 3, completed: 3 }, values: { Step: 'Frame' } },
      { issue: 41, state: 'closed', values: {} },
      { issue: 42, state: 'closed', values: { Step: 'Done' } },
      // Open with slices filed: Slice; with one closed: Build.
      { issue: 43, subIssues: { total: 9, completed: 0 }, values: { Step: 'Frame' } },
      { issue: 44, subIssues: { total: 2, completed: 1 }, values: { Step: 'Specify' } },
      // Never back: an owner's Specify, or Build before any slice closed, stays.
      { issue: 45, values: { Step: 'Specify' } },
      { issue: 46, subIssues: { total: 2, completed: 0 }, values: { Step: 'Build' } },
      // Reopened: leaves Done for where its facts put it.
      { issue: 47, subIssues: { total: 1, completed: 0 }, values: { Step: 'Done' } },
      // An option the owner added stays, open or closed.
      { issue: 48, state: 'closed', values: { Step: 'Parked' } },
      // Not a Work item: no Step.
      { issue: 49, type: 'Brief', state: 'closed', values: {} },
      { issue: 50, type: null, values: {} },
      // Archived: off the board.
      { issue: 51, archived: true, state: 'closed', values: { Step: 'Build' } },
    );
    board.projects[0]!.fields.Step = [...STEP_OPTIONS, 'Parked'];
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "example-app work"',
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #47 is at Step Slice in "example-app work"',
      '✓ board: work item #44 is at Step Build in "example-app work"',
      '✓ board: work item #43 is at Step Slice in "example-app work"',
      '✓ board: work item #41 had no Step; it is at Done in "example-app work"',
      '✓ board: work item #40 is closed; it is at Step Done in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
    const steps = Object.fromEntries(board.projects[0]!.items.map((item) => [item.issue, item.values.Step]));
    assert.deepEqual(steps, { 12: undefined, 10: 'Build', 20: 'Frame', 21: 'Frame', 40: 'Done', 41: 'Done', 42: 'Done', 43: 'Slice', 44: 'Build', 45: 'Specify', 46: 'Build', 47: 'Slice', 48: 'Parked', 49: undefined, 50: undefined, 51: 'Build' });
    // The items hold their issues, so no issue is read on its own.
    assert.ok(!sys.requests.some((r) => /\/issues(\?|\/(?!12\b))/.test(r.url)));
  });

  it('says once for each Project whose Step lacks an option a move needs, and makes the other moves', async () => {
    const sys = new FakeSys();
    slice(sys);
    const board = new RestBoard(sys);
    board.workItems = [10, 20, 21, 40, 41];
    board.projects[0]!.fields.Step = ['Frame', 'Specify', 'Slice', 'Build'];
    board.projects[0]!.items.push({ issue: 40, state: 'closed', values: { Step: 'Build' } }, { issue: 41, state: 'closed', values: {} });
    board.projects.push({ number: 5, title: 'roadmap', fields: { Title: null, Step: ['Frame', 'Build'] }, items: [{ issue: 40, state: 'closed', values: {} }, { issue: 41, state: 'closed', values: {} }, { issue: 21, values: {} }] });
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), [
      '✓ board: slice #12 is In Progress in "example-app work"',
      '✓ board: work item #10 is at Step Build in "example-app work"',
      '✓ board: work item #21 had no Step; it is at Frame in "roadmap"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
      '! board: Step in "example-app work" has no option Done, so work items that belong there stay where they are; niyam onboard adds it',
      '! board: Step in "roadmap" has no option Done, so work items that belong there stay where they are; niyam onboard adds it',
    ]);
  });

  it('sweeps the board without a slice', async () => {
    const sys = new FakeSys();
    const board = new RestBoard(sys);
    board.workItems = [10, 20, 21, 40];
    board.projects[0]!.items.push({ issue: 40, state: 'closed', values: { Step: 'Frame' } });
    assert.deepEqual(await boardSwept(sys, 'tok', SLUG), [
      '✓ board: work item #40 is closed; it is at Step Done in "example-app work"',
      '✓ board: work item #20 had no Step; it is at Frame in "example-app work"',
    ]);
    // Work item #10 is at Slice with no slice closed: it stays.
    assert.equal(board.projects[0]!.items[1]!.values.Step, 'Slice');
  });

  it('gives the Step the facts put a work item at, or none when it stays', () => {
    const open = (value: string | undefined, total = 0, completed = 0) => ({ value, state: 'open', subIssues: { total, completed } });
    assert.equal(stepDue(open(undefined)), 'Frame');
    assert.equal(stepDue(open('frame', 1)), 'Slice');
    assert.equal(stepDue(open('Slice', 1, 1)), 'Build');
    assert.equal(stepDue(open('Specify'), true), 'Build');
    assert.equal(stepDue(open('Build')), undefined);
    assert.equal(stepDue(open('Done')), 'Frame');
    assert.equal(stepDue({ ...open('Build'), state: 'closed' }), 'Done');
    assert.equal(stepDue({ ...open('done'), state: 'closed' }), undefined);
    assert.equal(stepDue({ ...open('Parked'), state: 'closed' }), undefined);
  });

  it('reads nothing more for a closed slice', async () => {
    const sys = new FakeSys();
    sys.route('GET', `${ISSUE}/12`, { status: 200, json: { number: 12, state: 'closed' } });
    new RestBoard(sys);
    assert.deepEqual(await boardStarted(sys, 'tok', SLUG, 12), []);
    assert.equal(sys.requests.length, 1);
  });
});
