import assert from 'node:assert/strict';

import { VIEWS } from './board.ts';
import type { FakeSys } from './fake.test.ts';

export const OWNER_TOKEN = 'gho_owner';
export const SLUG = 'example-org/example-app';
export const URL = 'https://github.com/orgs/example-org/projects/3';

/** A Project view as the fake keeps it, its visible fields by name. */
export interface FakeView {
  id: string;
  name: string;
  layout: string;
  filter: string | null;
  visible: string[];
}

/** The fields GitHub gives every new Project, as the fake keeps them. */
export const BUILT_IN = ['Title', 'Status', 'Linked pull requests', 'Sub-issues progress'];

/** The view GitHub gives a new Project. */
export function defaultView(): FakeView {
  return { id: 'V_1', name: 'View 1', layout: 'TABLE_LAYOUT', filter: null, visible: ['Title', 'Status'] };
}

/** The views as onboard leaves them. */
export function settledViews(): FakeView[] {
  return VIEWS.map((spec, index) => ({ id: `V_${index + 1}`, name: spec.name, layout: spec.layout, filter: spec.filter, visible: ['Title', ...spec.show] }));
}

/** GitHub as the owner's `gh` sees it: an organisation with none of the board yet. */
export class Board {
  issueTypes = ['Task', 'Bug'];
  labels = ['bug'];
  project: { fields: string[]; linked: boolean; views?: FakeView[] } | undefined;
  /** The titles of the Projects this board created. */
  titles: string[] = [];
  /** Projects listed before this board's, as pages of other titles. */
  otherPages = 0;
  /** What the board's GraphQL calls asked for, by the operation they ran. */
  operations: string[] = [];

  constructor(sys: FakeSys, organisation = true) {
    sys.ghToken = OWNER_TOKEN;
    sys.acceptToken(OWNER_TOKEN, 'example-owner', { 'x-oauth-scopes': 'repo, read:org, project, admin:org, workflow' });
    if (!sys.routes.has(`GET https://api.github.com/repos/${SLUG}`)) {
      sys.route('GET', `/repos/${SLUG}`, { status: 200, json: repoJson(organisation) });
    }
    sys.route('GET', '/orgs/example-org/issue-types?per_page=100&page=1', () => ({ status: 200, json: this.issueTypes.map((name) => ({ name })) }));
    sys.route('POST', '/orgs/example-org/issue-types', () => {
      this.issueTypes.push(String((sys.requests.at(-1)?.body as { name: string }).name));
      return { status: 201, json: {} };
    });
    sys.route('GET', `/repos/${SLUG}/labels?per_page=100&page=1`, () => ({ status: 200, json: this.labels.map((name) => ({ name })) }));
    sys.route('POST', `/repos/${SLUG}/labels`, () => {
      this.labels.push(String((sys.requests.at(-1)?.body as { name: string }).name));
      return { status: 201, json: {} };
    });
    sys.route('POST', '/graphql', () => this.graphql((sys.requests.at(-1)?.body ?? {}) as { query: string; variables: Record<string, unknown> }));
  }

  graphql({ query, variables }: { query: string; variables: Record<string, unknown> }): { status: number; json: unknown } {
    const operation = /(projectsV2\(|createProjectV2Field|createProjectV2View|createProjectV2\(|updateProjectV2View|linkProjectV2ToRepository|views\(first|fields\(first)/.exec(query)?.[1] ?? 'unknown';
    this.operations.push(operation);
    const node = { id: 'P_1', title: 'example-app work', url: URL };
    switch (operation) {
      case 'projectsV2(': {
        const kind = query.includes('organization(') ? 'organization' : 'user';
        const page = variables.after === null ? 0 : Number(variables.after);
        const last = page >= this.otherPages;
        const nodes = last
          ? this.project
            ? [{ id: 'P_0', title: 'other', url: 'x', repositories: { nodes: [] } }, { ...node, repositories: { nodes: this.project.linked ? [{ id: 'R_0' }, { id: 'R_1' }] : [{ id: 'R_0' }] } }]
            : []
          : [{ id: `P_${page}`, title: `other ${page}`, url: 'x', repositories: { nodes: [] } }];
        return { status: 200, json: { data: { [kind]: { id: 'O_1', projectsV2: { nodes, pageInfo: { hasNextPage: !last, endCursor: last ? null : String(page + 1) } } } } } };
      }
      case 'createProjectV2(':
        assert.deepEqual({ ...variables, title: undefined }, { owner: 'O_1', title: undefined, repo: 'R_1' });
        this.titles.push(String(variables.title));
        this.project = { fields: [...BUILT_IN], linked: true, views: [defaultView()] };
        return { status: 200, json: { data: { createProjectV2: { projectV2: node } } } };
      case 'linkProjectV2ToRepository':
        assert.deepEqual(variables, { project: 'P_1', repo: 'R_1' });
        if (this.project) this.project.linked = true;
        return { status: 200, json: { data: { linkProjectV2ToRepository: { repository: { id: 'R_1' } } } } };
      case 'fields(first':
        return { status: 200, json: { data: { node: { fields: { nodes: [...(this.project?.fields ?? []).map((name) => ({ name })), {}] } } } } };
      case 'createProjectV2Field':
        this.project?.fields.push(String(variables.name));
        return { status: 200, json: { data: { createProjectV2Field: { projectV2Field: { name: variables.name } } } } };
      case 'views(first': {
        const json = (view: FakeView) => ({ ...view, configuration: { visibleFields: { nodes: [...view.visible.map((name) => ({ id: `F_${name}` })), {}] } } });
        const fields = [...(this.project?.fields ?? []).map((name) => ({ id: `F_${name}`, name })), {}];
        return { status: 200, json: { data: { node: { views: { nodes: (this.project?.views ?? []).map(json) }, fields: { nodes: fields } } } } };
      }
      case 'createProjectV2View': {
        const views = (this.project!.views ??= []);
        const view = { id: `V_${views.length + 1}`, name: String(variables.name), layout: String(variables.layout), filter: null, visible: ['Title', 'Status'] };
        views.push(view);
        return { status: 200, json: { data: { createProjectV2View: { projectV2View: { ...view, configuration: { visibleFields: { nodes: view.visible.map((name) => ({ id: `F_${name}` })) } } } } } } };
      }
      case 'updateProjectV2View': {
        const view = this.project!.views!.find((had) => had.id === variables.view)!;
        Object.assign(view, { name: variables.name, layout: variables.layout, filter: variables.filter });
        const ids = (variables.configuration as { visibleFieldIds: string[] } | null)?.visibleFieldIds;
        if (ids) view.visible = ids.map((id) => id.replace(/^F_/, ''));
        return { status: 200, json: { data: { updateProjectV2View: { projectV2View: { id: view.id } } } } };
      }
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

