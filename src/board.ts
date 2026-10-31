import { API, sameLogin } from './agent.ts';
import type { Output, Sys } from './types.ts';

/** The issue types the work model uses; an organisation-wide setting. */
export const ISSUE_TYPES = [
  { name: 'Work item', color: 'blue', description: 'A piece of work: its frame and spec, approved by the owner' },
  { name: 'Slice', color: 'green', description: 'One shippable part of a work item, built in one pull request' },
  { name: 'State', color: 'purple', description: "An experience state of a slice, linking its design frame" },
  { name: 'Decision', color: 'orange', description: 'A watched decision with a review date' },
  { name: 'Brief', color: 'gray', description: 'A small request, closed by the pull request that fixes it' },
];

export const LABELS = [
  { name: 'approved', color: '0e8a16', description: "The owner's approval to start" },
  { name: 'needs-owner', color: 'd93f0b', description: 'Waits on the owner' },
  { name: 'mechanical', color: 'c5def5', description: 'A change with no product decision in it' },
  { name: 'veto', color: 'b60205', description: 'The owner may reverse this routine decision for a week' },
  { name: 'expiring', color: 'fbca04', description: 'An override whose expiry is within 30 days' },
  { name: 'cannot-run-here', color: 'bfd4f2', description: 'A decision check that reads files only a laptop has' },
];

export const FIELDS = [
  { name: 'Step', options: ['Frame', 'Specify', 'Slice', 'Build'] },
  { name: 'Decision', options: ['Needs owner', 'Tripped', 'Decided by the routine'] },
  { name: 'Review date' },
];

/** What the owner's `gh` login needs for the board: projects, and issue types in an organisation. */
const OWNER_SCOPES = ['project', 'admin:org'];

/** The Project's views; onboard makes them, or updates the view that has the name. */
export const VIEWS = [
  { name: 'Needs you', layout: 'TABLE_LAYOUT', filter: 'label:needs-owner is:open', show: [] },
  { name: 'Board', layout: 'BOARD_LAYOUT', filter: '', show: ['Linked pull requests'] },
  { name: 'Work items', layout: 'TABLE_LAYOUT', filter: 'type:"Work item"', show: ['Sub-issues progress'] },
  { name: 'Decisions', layout: 'TABLE_LAYOUT', filter: 'type:Decision', show: [] },
  { name: 'Reviews due', layout: 'TABLE_LAYOUT', filter: '"Review date":<=@today', show: [] },
];

/** The name GitHub gives a new Project's first view, which onboard renames rather than leaves. */
const DEFAULT_VIEW = 'View 1';

/** What GitHub's API still cannot set on the views, so the owner does it by hand. */
export function viewsChecklist(url: string): string[] {
  return [
    `Finish the views in ${url} by hand (GitHub's API cannot):`,
    '  [ ] Work items: group by Step',
    '  [ ] Decisions: group by Decision',
    '  [ ] Board: columns by Status (Todo, In progress, Done); no "In review" column',
    '  [ ] Workflows → Auto-archive items: is:closed updated:<@today-7d',
  ];
}

interface Repo {
  slug: string;
  nodeId: string;
  name: string;
  ownerLogin: string;
  organisation: boolean;
}

async function graphql(sys: Sys, token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const { status, json } = await sys.http(`${API}/graphql`, { method: 'POST', token, body: { query, variables } });
  const reply = json as { data?: unknown; errors?: { message?: string }[] } | null;
  if (status !== 200 || reply?.errors?.length || !reply?.data) {
    const why = reply?.errors?.map((error) => error.message).join('; ') ?? `HTTP ${status}`;
    throw new Error(`GitHub's GraphQL API refused: ${why}`);
  }
  return reply.data;
}

/** Every named entry a REST list holds, reading 100 a page. */
async function list(sys: Sys, token: string, url: string): Promise<{ name: string }[]> {
  const names: { name: string }[] = [];
  for (let page = 1; ; page++) {
    const pageUrl = `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
    const { status, json } = await sys.http(pageUrl, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read ${url} (HTTP ${status})`);
    names.push(...json.filter((entry): entry is { name: string } => typeof (entry as { name?: unknown } | null)?.name === 'string'));
    if (json.length < 100) return names;
  }
}

/**
 * Sets up the client's work board as the owner, through the owner's `gh`
 * login: the organisation's issue types, the repo's labels, and a Project
 * linked to the repo with the work model's fields. Creates only what is
 * missing; every change waits for a yes. Returns the Project's URL, or
 * undefined when it stopped.
 */
export async function setUpBoard(
  sys: Sys,
  io: Output,
  confirm: (question: string) => Promise<boolean>,
  slug: string,
  owner: string,
  /** The Project's title; `<repo> work` when the settings name none. */
  projectTitle?: string,
): Promise<string | undefined> {
  const login = sys.exec('gh', ['auth', 'token']);
  const token = login.stdout.trim();
  if (login.code !== 0 || !token) {
    io.err(`onboard: gh is not signed in; sign in as ${owner} with: gh auth login -s project`);
    return undefined;
  }
  const me = await sys.http(`${API}/user`, { token });
  const who = (me.json as { login?: unknown } | null)?.login;
  if (me.status !== 200 || typeof who !== 'string' || !sameLogin(who, owner)) {
    io.err(`onboard: gh is signed in as ${typeof who === 'string' ? who : 'nobody GitHub accepts'}, not the owner ${owner}`);
    return undefined;
  }

  const found = await sys.http(`${API}/repos/${slug}`, { token });
  const raw = found.json as { node_id?: unknown; name?: unknown; owner?: { login?: unknown; type?: unknown } } | null;
  if (found.status !== 200 || typeof raw?.node_id !== 'string' || typeof raw.name !== 'string' || typeof raw.owner?.login !== 'string') {
    throw new Error(`cannot read ${slug} as ${owner} (HTTP ${found.status})`);
  }
  const repo: Repo = {
    slug,
    nodeId: raw.node_id,
    name: raw.name,
    ownerLogin: raw.owner.login,
    organisation: raw.owner.type === 'Organization',
  };

  const scopes = (me.headers?.['x-oauth-scopes'] ?? '').split(',').map((scope) => scope.trim());
  const needed = repo.organisation ? OWNER_SCOPES : ['project'];
  const missing = needed.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    io.err(`onboard: your gh login lacks ${missing.join(', ')}; run: gh auth refresh -h github.com -s ${missing.join(',')}`);
    return undefined;
  }

  if (repo.organisation) {
    const have = await list(sys, token, `${API}/orgs/${repo.ownerLogin}/issue-types`);
    const absent = ISSUE_TYPES.filter((type) => !have.some((had) => had.name.toLowerCase() === type.name.toLowerCase()));
    if (absent.length > 0) {
      if (!(await confirm(`Add the issue types ${absent.map((t) => t.name).join(', ')} to the ${repo.ownerLogin} organisation?`))) {
        return stopped(io, 'issue types');
      }
      for (const type of absent) {
        const made = await sys.http(`${API}/orgs/${repo.ownerLogin}/issue-types`, {
          method: 'POST',
          token,
          body: { ...type, is_enabled: true },
        });
        if (made.status !== 200 && made.status !== 201) throw new Error(`GitHub did not add the issue type ${type.name} (HTTP ${made.status})`);
      }
    }
    io.out(`✓ issue types in ${repo.ownerLogin}: ${ISSUE_TYPES.map((t) => t.name).join(', ')}`);
  } else {
    io.out('- issue types: GitHub has them for organisations only; skipped for a personal repository');
  }

  const labels = await list(sys, token, `${API}/repos/${slug}/labels`);
  const newLabels = LABELS.filter((label) => !labels.some((had) => had.name.toLowerCase() === label.name));
  if (newLabels.length > 0) {
    if (!(await confirm(`Add the labels ${newLabels.map((l) => l.name).join(', ')} to ${slug}?`))) {
      return stopped(io, 'labels');
    }
    for (const label of newLabels) {
      const made = await sys.http(`${API}/repos/${slug}/labels`, { method: 'POST', token, body: label });
      if (made.status !== 201) throw new Error(`GitHub did not add the label ${label.name} (HTTP ${made.status})`);
    }
  }
  io.out(`✓ labels: ${LABELS.map((l) => l.name).join(', ')}`);

  const title = projectTitle?.trim() || `${repo.name} work`;
  const kind = repo.organisation ? 'organization' : 'user';
  type Project = { id: string; title: string; url: string; repositories: { nodes: { id: string }[] } };
  let holderId: string | undefined;
  let project: Project | undefined;
  for (let after: string | null = null; !project; ) {
    const page = (await graphql(
      sys,
      token,
      `query($login: String!, $title: String!, $after: String) { ${kind}(login: $login) { id projectsV2(first: 100, query: $title, after: $after) { nodes { id title url repositories(first: 100) { nodes { id } } } pageInfo { hasNextPage endCursor } } } }`,
      { login: repo.ownerLogin, title, after },
    )) as Record<string, { id: string; projectsV2: { nodes: Project[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null>;
    const holder = page[kind];
    if (!holder) throw new Error(`GitHub has no ${kind} ${repo.ownerLogin}`);
    holderId = holder.id;
    project = holder.projectsV2.nodes.find((node) => node.title === title);
    if (!holder.projectsV2.pageInfo.hasNextPage) break;
    after = holder.projectsV2.pageInfo.endCursor;
  }
  if (!project) {
    if (!(await confirm(`Create the Project "${title}" for ${repo.ownerLogin}, linked to ${slug}?`))) {
      return stopped(io, 'project');
    }
    const made = (await graphql(
      sys,
      token,
      'mutation($owner: ID!, $title: String!, $repo: ID!) { createProjectV2(input: { ownerId: $owner, title: $title, repositoryId: $repo }) { projectV2 { id title url } } }',
      { owner: holderId, title, repo: repo.nodeId },
    )) as { createProjectV2: { projectV2: Omit<Project, 'repositories'> } };
    project = { ...made.createProjectV2.projectV2, repositories: { nodes: [{ id: repo.nodeId }] } };
  }
  if (!project.repositories.nodes.some((linked) => linked.id === repo.nodeId)) {
    if (!(await confirm(`Link the Project "${title}" to ${slug}?`))) return stopped(io, 'project');
    await graphql(
      sys,
      token,
      'mutation($project: ID!, $repo: ID!) { linkProjectV2ToRepository(input: { projectId: $project, repositoryId: $repo }) { repository { id } } }',
      { project: project.id, repo: repo.nodeId },
    );
  }
  io.out(`✓ Project "${title}": ${project.url}`);

  const fields = (await graphql(
    sys,
    token,
    'query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name } } } } } }',
    { id: project.id },
  )) as { node: { fields: { nodes: { name?: string }[] } } };
  const names = fields.node.fields.nodes.map((node) => node.name?.toLowerCase());
  const newFields = FIELDS.filter((field) => !names.includes(field.name.toLowerCase()));
  if (newFields.length > 0) {
    if (!(await confirm(`Add the fields ${newFields.map((f) => f.name).join(', ')} to "${title}"?`))) {
      return stopped(io, 'fields');
    }
    for (const field of newFields) {
      await graphql(
        sys,
        token,
        'mutation($project: ID!, $name: String!, $type: ProjectV2CustomFieldType!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { createProjectV2Field(input: { projectId: $project, name: $name, dataType: $type, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2FieldCommon { name } } } }',
        {
          project: project.id,
          name: field.name,
          type: field.options ? 'SINGLE_SELECT' : 'DATE',
          options: field.options?.map((name) => ({ name, color: 'GRAY', description: '' })) ?? null,
        },
      );
    }
  }
  io.out(`✓ fields: ${FIELDS.map((f) => f.name).join(', ')}`);

  if (!(await setUpViews(sys, token, confirm, project.id, title))) return stopped(io, 'views');
  io.out(`✓ views: ${VIEWS.map((v) => v.name).join(', ')}`);
  for (const line of viewsChecklist(project.url)) io.out(line);
  return project.url;
}

type View = { id: string; name: string; layout: string; filter: string | null; configuration: { visibleFields: { nodes: { id?: string }[] } } };

const VIEW = 'id name layout filter configuration { visibleFields(first: 50) { nodes { ... on ProjectV2FieldCommon { id } } } }';

/**
 * Makes the Project's views, or updates the view that already has the name,
 * so a rerun makes no duplicates; the default view becomes the first view it
 * would otherwise make. Every change waits for one yes. Returns false when
 * that yes was not given.
 */
export async function setUpViews(
  sys: Sys,
  token: string,
  confirm: (question: string) => Promise<boolean>,
  projectId: string,
  title: string,
): Promise<boolean> {
  const read = (await graphql(
    sys,
    token,
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { views(first: 50) { nodes { ${VIEW} } } fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } } } } } }`,
    { id: projectId },
  )) as { node: { views: { nodes: View[] }; fields: { nodes: { id?: string; name?: string }[] } } };
  const views = read.node.views.nodes;
  const fieldIds = new Map(read.node.fields.nodes.map((field) => [field.name, field.id]));
  let spare = views.find((view) => view.name === DEFAULT_VIEW);

  const changes = VIEWS.map((spec) => {
    let view = views.find((had) => had.name === spec.name);
    if (!view && spare) [view, spare] = [spare, undefined];
    return { spec, view };
  }).filter(({ spec, view }) => !view || !settled(view, spec, fieldIds));
  if (changes.length === 0) return true;
  const renamed = changes.find((step) => step.view?.name === DEFAULT_VIEW);
  const question = `Set up the views ${changes.map((step) => step.spec.name).join(', ')} in "${title}"${renamed ? ` (renaming "${DEFAULT_VIEW}" to "${renamed.spec.name}")` : ''}?`;
  if (!(await confirm(question))) return false;

  for (const { spec, view: had } of changes) {
    const view =
      had ??
      ((await graphql(
        sys,
        token,
        `mutation($project: ID!, $name: String!, $layout: ProjectV2ViewLayout!) { createProjectV2View(input: { projectId: $project, name: $name, layout: $layout }) { projectV2View { ${VIEW} } } }`,
        { project: projectId, name: spec.name, layout: spec.layout },
      )) as { createProjectV2View: { projectV2View: View } }).createProjectV2View.projectV2View;
    if (settled(view, spec, fieldIds)) continue;
    const show = hidden(view, spec, fieldIds);
    await graphql(
      sys,
      token,
      'mutation($view: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $filter: String!, $configuration: ProjectV2ViewConfigurationInput) { updateProjectV2View(input: { viewId: $view, name: $name, layout: $layout, filter: $filter, configuration: $configuration }) { projectV2View { id } } }',
      {
        view: view.id,
        name: spec.name,
        layout: spec.layout,
        filter: spec.filter,
        configuration: show.length > 0 ? { visibleFieldIds: [...visibleIds(view), ...show] } : null,
      },
    );
  }
  return true;
}

function visibleIds(view: View): string[] {
  return view.configuration.visibleFields.nodes.map((field) => field.id).filter((id) => id !== undefined);
}

/** The fields the spec shows that the view hides. */
function hidden(view: View, spec: (typeof VIEWS)[number], fieldIds: Map<string | undefined, string | undefined>): string[] {
  const visible = visibleIds(view);
  return spec.show.map((name) => fieldIds.get(name)).filter((id): id is string => id !== undefined && !visible.includes(id));
}

/** Whether the view already is what the spec asks for. */
function settled(view: View, spec: (typeof VIEWS)[number], fieldIds: Map<string | undefined, string | undefined>): boolean {
  return view.name === spec.name && view.layout === spec.layout && (view.filter ?? '') === spec.filter && hidden(view, spec, fieldIds).length === 0;
}

function stopped(io: Output, step: string): undefined {
  io.err(`onboard: stopped at "${step}"; nothing after it was changed`);
  return undefined;
}
