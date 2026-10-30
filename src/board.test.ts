import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIELDS, ISSUE_TYPES, LABELS, setUpBoard, viewsChecklist } from './board.ts';
import { FakeSys, capture } from './fake.test.ts';

export const OWNER_TOKEN = 'gho_owner';
const SLUG = 'example-org/example-app';
const URL = 'https://github.com/orgs/example-org/projects/3';

/** GitHub as the owner's `gh` sees it: an organisation with none of the board yet. */
export class Board {
  issueTypes = ['Task', 'Bug'];
  labels = ['bug'];
  project: { fields: string[] } | undefined;
  /** What the board's GraphQL calls asked for, by the operation they ran. */
  operations: string[] = [];

  constructor(sys: FakeSys, organisation = true) {
    sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'repo, read:org, project, admin:org, workflow' });
    if (!sys.routes.has(`GET https://api.github.com/repos/${SLUG}`)) {
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson(organisation) });
    }
    sys.route('GET', '/orgs/example-org/issue-types', () => ({ status: 200, json: this.issueTypes.map((name) => ({ name })) }));
    sys.route('POST', '/orgs/example-org/issue-types', () => {
      this.issueTypes.push(String((sys.requests.at(-1)?.body as { name: string }).name));
      return { status: 201, json: {} };
    });
    sys.route('GET', `/repos/${SLUG}/labels?per_page=100`, () => ({ status: 200, json: this.labels.map((name) => ({ name })) }));
    sys.route('POST', `/repos/${SLUG}/labels`, () => {
      this.labels.push(String((sys.requests.at(-1)?.body as { name: string }).name));
      return { status: 201, json: {} };
    });
    sys.route('POST', '/graphql', () => this.graphql((sys.requests.at(-1)?.body ?? {}) as { query: string; variables: Record<string, unknown> }));
  }

  graphql({ query, variables }: { query: string; variables: Record<string, unknown> }): { status: number; json: unknown } {
    const operation = /(projectsV2\(|createProjectV2Field|createProjectV2\(|fields\(first)/.exec(query)?.[1] ?? 'unknown';
    this.operations.push(operation);
    const node = { id: 'P_1', title: 'example-app work', url: URL };
    switch (operation) {
      case 'projectsV2(': {
        const kind = query.includes('organization(') ? 'organization' : 'user';
        return { status: 200, json: { data: { [kind]: { id: 'O_1', projectsV2: { nodes: this.project ? [{ id: 'P_0', title: 'other', url: 'x' }, node] : [] } } } } };
      }
      case 'createProjectV2(':
        assert.deepEqual(variables, { owner: 'O_1', title: 'example-app work', repo: 'R_1' });
        this.project = { fields: ['Title', 'Status'] };
        return { status: 200, json: { data: { createProjectV2: { projectV2: node } } } };
      case 'fields(first':
        return { status: 200, json: { data: { node: { fields: { nodes: [...(this.project?.fields ?? []).map((name) => ({ name })), {}] } } } } };
      case 'createProjectV2Field':
        this.project?.fields.push(String(variables.name));
        return { status: 200, json: { data: { createProjectV2Field: { projectV2Field: { name: variables.name } } } } };
      default:
        return { status: 200, json: { errors: [{ message: 'unknown query' }] } };
    }
  }
}

/** The repository as GitHub describes it to someone who can push. */
export function repoJson(organisation = true, branch = 'main'): Record<string, unknown> {
  return {
    node_id: 'R_1',
    name: 'example-app',
    default_branch: branch,
    permissions: { push: true },
    owner: { login: 'example-org', type: organisation ? 'Organization' : 'User' },
  };
}

async function setUp(sys: FakeSys, answers = ['y', 'y', 'y', 'y']): Promise<{ url: string | undefined; out: string[]; err: string[] }> {
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
    assert.deepEqual(board.issueTypes, ['Task', 'Bug', ...ISSUE_TYPES.map((t) => t.name)]);
    assert.deepEqual(board.labels, ['bug', ...LABELS.map((l) => l.name)]);
    assert.deepEqual(board.project?.fields, ['Title', 'Status', ...FIELDS.map((f) => f.name)]);
    assert.deepEqual(out.slice(0, 4), [
      '✓ issue types in example-org: Work item, Slice, State, Decision, Brief',
      '✓ labels: approved, needs-owner, mechanical, veto, expiring, cannot-run-here',
      `✓ Project "example-app work": ${URL}`,
      '✓ fields: Step, Decision, Review date',
    ]);
    assert.deepEqual(out.slice(4), viewsChecklist(URL));
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

  it('asks nothing when everything is there', async () => {
    const sys = new FakeSys();
    const board = new Board(sys);
    board.issueTypes = ISSUE_TYPES.map((t) => t.name.toUpperCase());
    board.labels = LABELS.map((l) => l.name);
    board.project = { fields: FIELDS.map((f) => f.name) };
    const { url } = await setUp(sys, []);
    assert.equal(url, URL);
    assert.deepEqual(sys.asked, []);
    assert.ok(!board.operations.includes('createProjectV2('));
  });

  it('skips issue types for a personal repository', async () => {
    const sys = new FakeSys();
    new Board(sys, false);
    sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'project' });
    const { url, out } = await setUp(sys, ['y', 'y', 'y']);
    assert.equal(url, URL);
    assert.equal(out[0], '- issue types: GitHub has them for organisations only; skipped for a personal repository');
  });

  for (const [name, change, message] of [
    ['gh not signed in', (sys: FakeSys) => (sys.ghToken = undefined), 'onboard: gh is not signed in; sign in as example-owner with: gh auth login -s project,admin:org'],
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

  for (const [index, step] of ['issue types', 'labels', 'project', 'fields'].entries()) {
    it(`stops when "${step}" is declined`, async () => {
      const sys = new FakeSys();
      new Board(sys);
      const { url, err } = await setUp(sys, [...Array<string>(index).fill('y'), 'n']);
      assert.deepEqual({ url, err }, { url: undefined, err: [`onboard: stopped at "${step}"; nothing after it was changed`] });
    });
  }

  for (const [name, change, message] of [
    ['the repo', (sys: FakeSys) => sys.route('GET', `/repos/${SLUG}`, { status: 404, json: null }), /cannot read example-org\/example-app as example-owner \(HTTP 404\)/],
    ['the issue types', (sys: FakeSys) => sys.route('GET', '/orgs/example-org/issue-types', { status: 403, json: null }), /cannot read https:\/\/api\.github\.com\/orgs\/example-org\/issue-types \(HTTP 403\)/],
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
