import assert from 'node:assert/strict';

import { FIELDS, VIEWS } from './board.ts';
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
  return VIEWS.map((spec, index) => ({ id: `V_${index + 1}`, name: spec.name, layout: spec.layout, filter: spec.filter, visible: ['Title', 'Status', ...spec.show] }));
}

/** An item on a fake Project, its values by field name: an option's name, a date or a number. */
export interface FakeItem {
  content?: string;
  draft?: { title: string; body: string };
  archived?: boolean;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  values: Record<string, string | number>;
}

/** A Project as the fake keeps it. */
export interface FakeProject {
  id?: string;
  fields: string[];
  linked: boolean;
  views?: FakeView[];
  /** Whether its views are grouped as the template's are. */
  grouped?: boolean;
  items?: FakeItem[];
  title?: string;
  closed?: boolean;
  /** How many reads of a copy's fields come back before its custom fields arrive. */
  pending?: number;
  /** Its workflows that are off. */
  off?: string[];
}

/** The custom fields a copy of the template gains a little after the copy returns. */
const FIELDS_ADDED = FIELDS.map((field) => field.name);

export const COPY_URL = 'https://github.com/orgs/example-org/projects/4';

/** A field's kind, as GitHub names it. */
function dataType(name: string): string {
  if (['Status', 'Step', 'Decision'].includes(name)) return 'SINGLE_SELECT';
  return { 'Review date': 'DATE', Estimate: 'NUMBER', Notes: 'TEXT' }[name] ?? 'TITLE';
}

/** A single-select field's options, by name. */
function options(name: string): string[] | undefined {
  return { Status: ['Todo', 'In progress', 'Done'], Step: ['Frame', 'Specify', 'Slice', 'Build'], Decision: ['Needs owner', 'Tripped', 'Decided by the routine'] }[name];
}

/** GitHub as the owner's `gh` sees it: an organisation with none of the board yet, and the process-rules template. */
export class Board {
  issueTypes = ['Task', 'Bug'];
  labels = ['bug'];
  project: FakeProject | undefined;
  /** The Project a copy of the template replaced. */
  old: FakeProject | undefined;
  /** Whether the template can be read, and whether GitHub copies it. */
  template: 'copies' | 'missing' | 'refused' = 'copies';
  /** How many reads of a copy's fields come back before its custom fields arrive. */
  copyPending = 0;
  /** The workflows a copy of the template has off. */
  copyOff: string[] = [];
  /** The titles of the Projects this board created or copied. */
  titles: string[] = [];
  /** Projects listed before this board's, as pages of other titles. */
  otherPages = 0;
  /** The items a page of a Project's items holds. */
  itemsPerPage = 100;
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

  /** The Project with the id: the old one a copy replaced, or the current one. */
  at(id: unknown): FakeProject {
    const found = [this.old, this.project].find((project) => project && (project.id ?? 'P_1') === id);
    assert.ok(found, `no Project ${String(id)}`);
    return found;
  }

  graphql({ query, variables }: { query: string; variables: Record<string, unknown> }): { status: number; json: unknown } {
    const operation =
      [
        'copyProjectV2',
        'addProjectV2DraftIssue',
        'addProjectV2ItemById',
        'updateProjectV2ItemFieldValue',
        'updateProjectV2(',
        'createProjectV2Field',
        'createProjectV2View',
        'updateProjectV2View',
        'createProjectV2(',
        'linkProjectV2ToRepository',
        'projectsV2(',
        'projectV2(number',
        'groupByFields',
        'items(first',
        'options {',
        'views(first',
        'fields(first',
      ].find((name) => query.includes(name)) ?? 'unknown';
    this.operations.push(operation);
    const data = (json: unknown) => ({ status: 200, json: { data: json } });
    switch (operation) {
      case 'projectsV2(': {
        const kind = query.includes('organization(') ? 'organization' : 'user';
        const page = variables.after === null ? 0 : Number(variables.after);
        const last = page >= this.otherPages;
        const project = this.project && { id: this.project.id ?? 'P_1', title: 'example-app work', url: this.project.id === 'P_2' ? COPY_URL : URL };
        const nodes = last
          ? this.project
            ? [{ id: 'P_0', title: 'other', url: 'x', repositories: { nodes: [] } }, { ...project, repositories: { nodes: this.project.linked ? [{ id: 'R_0' }, { id: 'R_1' }] : [{ id: 'R_0' }] } }]
            : []
          : [{ id: `P_${page}`, title: `other ${page}`, url: 'x', repositories: { nodes: [] } }];
        return data({ [kind]: { id: 'O_1', projectsV2: { nodes, pageInfo: { hasNextPage: !last, endCursor: last ? null : String(page + 1) } } } });
      }
      case 'createProjectV2(':
        assert.deepEqual({ ...variables, title: undefined }, { owner: 'O_1', title: undefined, repo: 'R_1' });
        this.titles.push(String(variables.title));
        this.project = { fields: [...BUILT_IN], linked: true, views: [defaultView()] };
        return data({ createProjectV2: { projectV2: { id: 'P_1', title: 'example-app work', url: URL } } });
      case 'projectV2(number':
        assert.deepEqual(variables, { login: 'athya-hq', number: 4 });
        return data({ organization: this.template === 'missing' ? { projectV2: null } : { projectV2: { id: 'P_T' } } });
      case 'copyProjectV2': {
        if (this.template === 'refused') return { status: 200, json: { errors: [{ message: 'Resource not accessible by integration' }] } };
        assert.deepEqual({ ...variables, title: undefined }, { template: 'P_T', owner: 'O_1', title: undefined });
        this.titles.push(String(variables.title));
        if (this.project) this.old = this.project;
        this.project = { id: 'P_2', fields: [...BUILT_IN], linked: false, views: settledViews(), grouped: true, items: [], pending: this.copyPending, off: [...this.copyOff] };
        return data({ copyProjectV2: { projectV2: { id: 'P_2', title: variables.title, url: COPY_URL } } });
      }
      case 'linkProjectV2ToRepository':
        assert.equal(variables.repo, 'R_1');
        this.at(variables.project).linked = true;
        return data({ linkProjectV2ToRepository: { repository: { id: 'R_1' } } });
      case 'fields(first': {
        const project = this.at(variables.id);
        if (project.pending !== undefined && project.pending-- <= 0) project.fields.push(...FIELDS_ADDED);
        if (project.pending !== undefined && project.pending < 0) delete project.pending;
        return data({ node: { fields: { nodes: [...project.fields.map((name) => ({ name })), {}] } } });
      }
      case 'createProjectV2Field':
        this.at(variables.project).fields.push(String(variables.name));
        return data({ createProjectV2Field: { projectV2Field: { name: variables.name } } });
      case 'groupByFields': {
        const project = this.at(variables.id);
        const by = (name: string) => (project.grouped ? { 'Work items': [{ name: 'Step' }, {}], Decisions: [{ name: 'Decision' }] }[name] ?? [] : []);
        const workflows = [{ name: 'Item closed', enabled: true }, ...(project.off ?? []).map((name) => ({ name, enabled: false }))];
        return data({ node: { views: { nodes: (project.views ?? []).map((view) => ({ name: view.name, groupByFields: { nodes: by(view.name) } })) }, workflows: { nodes: workflows } } });
      }
      case 'items(first': {
        const project = this.at(variables.id);
        const start = variables.after === null ? 0 : Number(variables.after);
        const items = project.items ?? [];
        const page = items.slice(start, start + this.itemsPerPage);
        const more = start + this.itemsPerPage < items.length;
        const value = (field: string, held: string | number) =>
          dataType(field) === 'DATE' ? { date: held, field: { name: field } } : dataType(field) === 'NUMBER' ? { number: held, field: { name: field } } : dataType(field) === 'TEXT' ? { text: held, field: { name: field } } : { name: held, field: { name: field } };
        return data({
          node: {
            fields: { nodes: [...project.fields.map((name) => ({ name, dataType: dataType(name) })), {}] },
            items: {
              nodes: [
                ...page.map((item) => ({
                  isArchived: item.archived ?? false,
                  content: item.draft ? { __typename: 'DraftIssue', ...item.draft } : { __typename: 'Issue', id: item.content, ...(item.state ? { state: item.state } : {}) },
                  fieldValues: { nodes: [{ text: 'a title', field: { name: 'Title' } }, ...Object.entries(item.values).map(([field, held]) => value(field, held)), {}] },
                })),
                ...(start === 0 ? [{ isArchived: false, content: null, fieldValues: { nodes: [] } }] : []),
              ],
              pageInfo: { hasNextPage: more, endCursor: more ? String(start + this.itemsPerPage) : null },
            },
          },
        });
      }
      case 'options {': {
        const project = this.at(variables.id);
        const field = (name: string) => ({ id: `F_${name}`, name, ...(options(name) ? { options: options(name)!.map((option) => ({ id: `O_${name}_${option}`, name: option })) } : {}) });
        return data({ node: { fields: { nodes: [...project.fields.map(field), {}] } } });
      }
      case 'addProjectV2ItemById':
      case 'addProjectV2DraftIssue': {
        const items = (this.at(variables.project).items ??= []);
        const added: FakeItem = operation === 'addProjectV2DraftIssue' ? { draft: { title: String(variables.title), body: String(variables.body) }, values: {} } : { content: String(variables.content), values: {} };
        items.push(added);
        const id = `I_${items.length}`;
        return data(operation === 'addProjectV2DraftIssue' ? { addProjectV2DraftIssue: { projectItem: { id } } } : { addProjectV2ItemById: { item: { id } } });
      }
      case 'updateProjectV2ItemFieldValue': {
        const item = this.at(variables.project).items![Number(String(variables.item).slice(2)) - 1]!;
        const field = String(variables.field).slice(2);
        const value = variables.value as { singleSelectOptionId?: string; date?: string; number?: number; text?: string };
        item.values[field] = value.singleSelectOptionId?.slice(`O_${field}_`.length) ?? value.date ?? value.number ?? value.text ?? '';
        return data({ updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.item } } });
      }
      case 'updateProjectV2(': {
        Object.assign(this.at(variables.project), { title: variables.title, ...(query.includes('closed: true') ? { closed: true } : {}) });
        return data({ updateProjectV2: { projectV2: { id: variables.project } } });
      }
      case 'views(first': {
        const project = this.at(variables.id);
        const json = (view: FakeView) => ({ ...view, configuration: { visibleFields: { nodes: [...view.visible.map((name) => ({ id: `F_${name}` })), {}] } } });
        const fields = [...project.fields.map((name) => ({ id: `F_${name}`, name })), {}];
        return data({ node: { views: { nodes: (project.views ?? []).map(json) }, fields: { nodes: fields } } });
      }
      case 'createProjectV2View': {
        const views = (this.at(variables.project).views ??= []);
        const view = { id: `V_${views.length + 1}`, name: String(variables.name), layout: String(variables.layout), filter: null, visible: ['Title', 'Status'] };
        views.push(view);
        return data({ createProjectV2View: { projectV2View: { ...view, configuration: { visibleFields: { nodes: view.visible.map((name) => ({ id: `F_${name}` })) } } } } });
      }
      case 'updateProjectV2View': {
        const view = [this.old, this.project].flatMap((project) => project?.views ?? []).find((had) => had.id === variables.view)!;
        Object.assign(view, { name: variables.name, layout: variables.layout, filter: variables.filter });
        const ids = (variables.configuration as { visibleFieldIds: string[] } | null)?.visibleFieldIds;
        if (ids) view.visible = ids.map((id) => id.replace(/^F_/, ''));
        return data({ updateProjectV2View: { projectV2View: { id: view.id } } });
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

