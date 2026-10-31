import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIELDS, ISSUE_TYPES, LABELS, VIEWS, setUpBoard, viewsChecklist } from './board.ts';
import { BUILT_IN, Board, OWNER_TOKEN, SLUG, URL, defaultView, settledViews } from './fake-board.test.ts';
import { FakeSys, capture } from './fake.test.ts';

async function setUp(sys: FakeSys, answers = ['y', 'y', 'y', 'y', 'y']): Promise<{ url: string | undefined; out: string[]; err: string[] }> {
  sys.answers = [...answers];
  const { io, out, err } = capture();
  const confirm = async (question: string) => /^y/.test(await sys.ask(question));
  return { url: await setUpBoard(sys, io, confirm, SLUG, 'example-owner'), out, err };
}

describe('setUpBoard', () => {
  it('creates the issue types, labels, Project and fields an organisation lacks', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const { url, out, err } = await setUp(sys);
    assert.deepEqual(err, []);
    assert.equal(url, URL);
    assert.deepEqual(board.titles, ['example-app work']);
    assert.deepEqual(board.issueTypes, ['Task', 'Bug', ...ISSUE_TYPES.map((t) => t.name)]);
    assert.deepEqual(board.labels, ['bug', ...LABELS.map((l) => l.name)]);
    assert.deepEqual(board.project?.fields, [...BUILT_IN, ...FIELDS.map((f) => f.name)]);
    assert.deepEqual(out.slice(0, 5), [
      '✓ issue types in example-org: Work item, Slice, State, Decision, Brief',
      '✓ labels: approved, needs-owner, mechanical, veto, expiring, cannot-run-here',
      `✓ Project "example-app work": ${URL}`,
      '✓ fields: Step, Decision, Review date',
      '✓ views: Needs you, Board, Work items, Decisions, Reviews due',
    ]);
    assert.deepEqual(out.slice(5), viewsChecklist(URL));
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
    sys.answers = ['y', 'y', 'y', 'y', 'y'];
    await setUpBoard(sys, capture().io, async (q) => /^y/.test(await sys.ask(q)), SLUG, 'example-owner', '  ');
    assert.deepEqual(board.titles, ['example-app work']);
  });

  it('asks nothing when everything is there', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name.toUpperCase());
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: settledViews() };
    const { url } = await setUp(sys, []);
    assert.equal(url, URL);
    assert.deepEqual(sys.asked, []);
    assert.ok(!board.operations.includes('createProjectV2('));
  });

  it('skips issue types for a personal repository', async () => {
    const sys = new FakeSys();
    new Board(sys, false);
    sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'project' });
    const { url, out } = await setUp(sys, ['y', 'y', 'y', 'y']);
    assert.equal(url, URL);
    assert.equal(out[0], '- issue types: GitHub has them for organisations only; skipped for a personal repository');
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
    board.project = { fields: FIELDS.map((f) => f.name), linked: false, views: settledViews() };
    const { url } = await setUp(sys, ['y', 'y', 'y']);
    assert.equal(url, URL);
    assert.ok(board.project.linked);
    assert.ok(sys.asked.includes('Link the Project "example-app work" to example-org/example-app?'));
  });

  it('stops when linking is declined', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.project = { fields: FIELDS.map((f) => f.name), linked: false };
    const { err } = await setUp(sys, ['y', 'y', 'n']);
    assert.deepEqual(err, ['onboard: stopped at "project"; nothing after it was changed']);
    assert.equal(board.project.linked, false);
  });

  it('finds the Project on a later page instead of making another', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.project = { fields: FIELDS.map((f) => f.name), linked: true, views: settledViews() };
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
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: [...views.slice(0, 4), { id: 'V_9', name: 'Mine', layout: 'TABLE_LAYOUT', filter: null, visible: ['Title'] }] };
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
    await setUp(sys, []);
    assert.equal(sys.asked.length, asked);
    assert.deepEqual(board.project?.views?.map((v) => v.name), VIEWS.map((v) => v.name));
    assert.equal(board.operations.filter((o) => o === 'createProjectV2View').length, VIEWS.length - 1);
  });

  it('only renames a default view whose name is not taken, without an update the view already has', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    const views = settledViews();
    board.project = { fields: [...BUILT_IN, ...FIELDS.map((f) => f.name)], linked: true, views: [{ ...views[0]!, name: 'View 1' }, ...views.slice(1)] };
    await setUp(sys, ['y', 'y', 'y']);
    assert.ok(sys.asked.includes('Set up the views Needs you in "example-app work" (renaming "View 1" to "Needs you")?'));
    assert.deepEqual(board.project.views?.map((v) => v.name), VIEWS.map((v) => v.name));
    assert.deepEqual(board.operations.filter((o) => o.includes('View')), ['updateProjectV2View']);
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
