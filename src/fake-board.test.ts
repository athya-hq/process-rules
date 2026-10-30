import assert from 'node:assert/strict';

import type { FakeSys } from './fake.test.ts';

export const OWNER_TOKEN = 'gho_owner';
export const SLUG = 'example-org/example-app';
export const URL = 'https://github.com/orgs/example-org/projects/3';

/** GitHub as the owner's `gh` sees it: an organisation with none of the board yet. */
export class Board {
  issueTypes = ['Task', 'Bug'];
  labels = ['bug'];
  project: { fields: string[]; linked: boolean } | undefined;
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
    const operation = /(projectsV2\(|createProjectV2Field|createProjectV2\(|linkProjectV2ToRepository|fields\(first)/.exec(query)?.[1] ?? 'unknown';
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
        this.project = { fields: ['Title', 'Status'], linked: true };
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

