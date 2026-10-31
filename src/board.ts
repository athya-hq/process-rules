import { API } from './agent.ts';
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

/**
 * The product's public Project that onboard copies into a client: the views
 * and fields, with what GitHub's API cannot set (the views' grouping, the
 * workflows), set once by the product's owner.
 */
export const TEMPLATE = { login: 'athya-hq', number: 4 };

/** How a view is grouped in the template, which only GitHub's web page can set. */
const GROUPING = [
  { view: 'Work items', field: 'Step' },
  { view: 'Decisions', field: 'Decision' },
];

/** What GitHub's API cannot set on a Project not copied from the template, so the owner does it by hand. */
export function viewsChecklist(url: string): string[] {
  return [
    `Finish the Project ${url} by hand (GitHub's API cannot):`,
    '  [ ] Work items: group by Step',
    '  [ ] Decisions: group by Decision',
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
 * Sets up the client's work board as the owner, with the owner's token for
 * this run (owner-login.ts): the organisation's issue types, the repo's
 * labels, and a Project linked to the repo with the work model's fields. Creates only what is
 * missing; every change waits for a yes. Returns the Project's URL, or
 * undefined when it stopped.
 */
export async function setUpBoard(
  sys: Sys,
  io: Output,
  confirm: (question: string) => Promise<boolean>,
  slug: string,
  owner: string,
  /** The owner's token, with the project scope, and admin:org for an organisation's repository. */
  token: string,
  /** The Project's title; `<repo> work` when the settings name none. */
  projectTitle?: string,
): Promise<string | undefined> {
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

  if (repo.organisation) {
    const have = await list(sys, token, `${API}/orgs/${repo.ownerLogin}/issue-types`);
    const absent = ISSUE_TYPES.filter((type) => !have.some((had) => had.name.toLowerCase() === type.name.toLowerCase()));
    if (absent.length > 0) {
      // Said before asking, since GitHub keeps issue types for the whole organisation, not this repository.
      const names = absent.map((t) => t.name).join(', ');
      if (!(await confirm(`Issue types are an organisation-wide setting, so they apply to every repository in ${repo.ownerLogin}, not only ${repo.name}. Add the issue types ${names} to the ${repo.ownerLogin} organisation?`))) {
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
    if (!(await confirm(`Create the Project "${title}" for ${repo.ownerLogin} from the process-rules template, linked to ${slug}?`))) {
      return stopped(io, 'project');
    }
    const copy = await copyTemplate(sys, io, token, holderId as string, title, 'building the Project instead');
    if (copy) {
      await link(sys, token, copy.id, repo.nodeId);
      project = { ...copy, repositories: { nodes: [{ id: repo.nodeId }] } };
    } else {
      const made = (await graphql(
        sys,
        token,
        'mutation($owner: ID!, $title: String!, $repo: ID!) { createProjectV2(input: { ownerId: $owner, title: $title, repositoryId: $repo }) { projectV2 { id title url } } }',
        { owner: holderId, title, repo: repo.nodeId },
      )) as { createProjectV2: { projectV2: Omit<Project, 'repositories'> } };
      project = { ...made.createProjectV2.projectV2, repositories: { nodes: [{ id: repo.nodeId }] } };
    }
  } else if (!(await finished(sys, token, project.id)).grouped) {
    const old = project;
    const moving = await itemsOf(sys, token, old.id);
    const lost = moving.fields.filter((name) => !FIELDS.some((field) => field.name === name) && name !== 'Status');
    const question =
      `"${title}" lacks what only the process-rules template sets (the views' grouping, the workflows). ` +
      `Replace it with a copy of the template, moving its ${moving.items.length} open item${moving.items.length === 1 ? '' : 's'} with their Status, Step, Decision and Review date` +
      `${lost.length > 0 ? ` (not ${lost.join(', ')}, which the template lacks)` : ''}, and close it as "${title} (old)"?`;
    if (await confirm(question)) {
      // Renamed first, so a rerun after a failure finds the copy by the title, not the old Project.
      await retitle(sys, token, old.id, `${title} (old)`);
      const copy = await copyTemplate(sys, io, token, holderId as string, title, 'keeping the Project as it is');
      if (!copy) await retitle(sys, token, old.id, title);
      else {
        await moveItems(sys, token, moving.items, copy.id);
        await retitle(sys, token, old.id, `${title} (old)`, true);
        await link(sys, token, copy.id, repo.nodeId);
        io.out(`✓ moved ${moving.items.length} item${moving.items.length === 1 ? '' : 's'} to the copy; closed the old Project as "${title} (old)": ${old.url}`);
        project = { ...copy, repositories: { nodes: [{ id: repo.nodeId }] } };
      }
    }
  }
  if (!project.repositories.nodes.some((linked) => linked.id === repo.nodeId)) {
    if (!(await confirm(`Link the Project "${title}" to ${slug}?`))) return stopped(io, 'project');
    await link(sys, token, project.id, repo.nodeId);
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
  const done = await finished(sys, token, project.id);
  if (!done.grouped) for (const line of viewsChecklist(project.url)) io.out(line);
  if (done.off.length > 0) io.out(`Turn on the workflows ${done.off.join(', ')} in ${project.url} → Workflows (GitHub's API cannot)`);
  return project.url;
}

/** Renames a Project, and closes it when asked; otherwise it stays open or closed as it was. */
async function retitle(sys: Sys, token: string, projectId: string, title: string, close = false): Promise<void> {
  await graphql(
    sys,
    token,
    `mutation($project: ID!, $title: String!) { updateProjectV2(input: { projectId: $project, title: $title${close ? ', closed: true' : ''} }) { projectV2 { id } } }`,
    { project: projectId, title },
  );
}

async function link(sys: Sys, token: string, projectId: string, repoId: string): Promise<void> {
  await graphql(
    sys,
    token,
    'mutation($project: ID!, $repo: ID!) { linkProjectV2ToRepository(input: { projectId: $project, repositoryId: $repo }) { repository { id } } }',
    { project: projectId, repo: repoId },
  );
}

type Copy = { id: string; title: string; url: string };

/** How long onboard waits for a copy's fields, which GitHub adds after the copy returns. */
const COPY_WAIT = { attempts: 20, ms: 3000 };

/**
 * Copies the template to the owner as a Project with the title, and waits
 * for its fields. Returns undefined, saying why and what onboard does
 * instead, when GitHub refuses the copy.
 */
async function copyTemplate(sys: Sys, io: Output, token: string, ownerId: string, title: string, instead: string): Promise<Copy | undefined> {
  let copy: Copy;
  try {
    const found = (await graphql(sys, token, 'query($login: String!, $number: Int!) { organization(login: $login) { projectV2(number: $number) { id } } }', TEMPLATE)) as {
      organization: { projectV2: { id: string } | null } | null;
    };
    const template = found.organization?.projectV2;
    if (!template) throw new Error(`GitHub shows no Project ${TEMPLATE.number} in ${TEMPLATE.login}`);
    const made = (await graphql(
      sys,
      token,
      'mutation($template: ID!, $owner: ID!, $title: String!) { copyProjectV2(input: { projectId: $template, ownerId: $owner, title: $title, includeDraftIssues: false }) { projectV2 { id title url } } }',
      { template: template.id, owner: ownerId, title },
    )) as { copyProjectV2: { projectV2: Copy } };
    copy = made.copyProjectV2.projectV2;
  } catch (error) {
    io.out(`- the process-rules template could not be copied (${(error as Error).message}); ${instead}`);
    return undefined;
  }
  for (let attempt = 1; ; attempt++) {
    const read = (await graphql(sys, token, 'query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name } } } } } }', {
      id: copy.id,
    })) as { node: { fields: { nodes: { name?: string }[] } } };
    const names = read.node.fields.nodes.map((node) => node.name);
    if (FIELDS.every((field) => names.includes(field.name))) return copy;
    if (attempt === COPY_WAIT.attempts) throw new Error(`the copy ${copy.url} has no fields ${FIELDS.map((f) => f.name).join(', ')} yet; run onboard again`);
    await sys.sleep(COPY_WAIT.ms);
  }
}

/**
 * What a copy of the template has that GitHub's API cannot set: whether the
 * views are grouped as the template's are, which marks a Project copied from
 * it, and the names of its workflows that are off.
 */
async function finished(sys: Sys, token: string, projectId: string): Promise<{ grouped: boolean; off: string[] }> {
  const read = (await graphql(
    sys,
    token,
    'query($id: ID!) { node(id: $id) { ... on ProjectV2 { views(first: 50) { nodes { name groupByFields(first: 5) { nodes { ... on ProjectV2FieldCommon { name } } } } } workflows(first: 50) { nodes { name enabled } } } } }',
    { id: projectId },
  )) as { node: { views: { nodes: { name: string; groupByFields: { nodes: { name?: string }[] } }[] }; workflows: { nodes: { name: string; enabled: boolean }[] } } };
  const views = read.node.views.nodes;
  return {
    grouped: GROUPING.every(({ view, field }) => views.some((had) => had.name === view && had.groupByFields.nodes.some((by) => by.name === field))),
    off: read.node.workflows.nodes.filter((workflow) => !workflow.enabled).map((workflow) => workflow.name),
  };
}

type FieldValue = { field: string; option?: string | undefined; date?: string | undefined; text?: string | undefined; number?: number | undefined };
type Item = { content?: string | undefined; draft?: { title: string; body: string }; values: FieldValue[] };

/** The field kinds whose values move with an item; the others belong to the issue or are GitHub's own. */
const MOVABLE = ['SINGLE_SELECT', 'DATE', 'TEXT', 'NUMBER'];

/** A Project's open items (drafts, and issues and pull requests not closed or merged) with their field values, and the names of its fields whose values could move. */
async function itemsOf(sys: Sys, token: string, projectId: string): Promise<{ items: Item[]; fields: string[] }> {
  const items: Item[] = [];
  let fields: string[] = [];
  for (let after: string | null = null; ; ) {
    const field = '... on ProjectV2FieldCommon { name }';
    const page = (await graphql(
      sys,
      token,
      `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name dataType } } } items(first: 100, after: $after) { nodes { isArchived content { __typename ... on Issue { id state } ... on PullRequest { id state } ... on DraftIssue { title body } } fieldValues(first: 30) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ${field} } } ... on ProjectV2ItemFieldDateValue { date field { ${field} } } ... on ProjectV2ItemFieldTextValue { text field { ${field} } } ... on ProjectV2ItemFieldNumberValue { number field { ${field} } } } } } pageInfo { hasNextPage endCursor } } } } }`,
      { id: projectId, after },
    )) as {
      node: {
        fields: { nodes: { name?: string; dataType?: string }[] };
        items: {
          nodes: {
            isArchived: boolean;
            content: { __typename: string; id?: string; state?: string; title?: string; body?: string } | null;
            fieldValues: { nodes: { name?: string; date?: string; text?: string; number?: number; field?: { name?: string } }[] };
          }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    fields = page.node.fields.nodes.filter((f) => MOVABLE.includes(f.dataType ?? '')).map((f) => f.name ?? '');
    for (const node of page.node.items.nodes) {
      if (node.isArchived || !node.content || (node.content.state ?? 'OPEN') !== 'OPEN') continue;
      const values = node.fieldValues.nodes
        .filter((value) => fields.includes(value.field?.name ?? ''))
        .map((value) => ({ field: value.field?.name ?? '', option: value.name, date: value.date, text: value.text, number: value.number }));
      items.push(
        node.content.__typename === 'DraftIssue'
          ? { draft: { title: node.content.title ?? '', body: node.content.body ?? '' }, values }
          : { content: node.content.id, values },
      );
    }
    if (!page.node.items.pageInfo.hasNextPage) return { items, fields };
    after = page.node.items.pageInfo.endCursor;
  }
}

/** Adds the items to the Project, setting each value on a field of the same name, by option name (in any case) for a single select. */
async function moveItems(sys: Sys, token: string, items: Item[], projectId: string): Promise<void> {
  const read = (await graphql(
    sys,
    token,
    'query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { id name } } } } } } }',
    { id: projectId },
  )) as { node: { fields: { nodes: { id?: string; name?: string; options?: { id: string; name: string }[] }[] } } };
  const fields = read.node.fields.nodes;
  for (const item of items) {
    const added = item.draft
      ? ((await graphql(
          sys,
          token,
          'mutation($project: ID!, $title: String!, $body: String) { addProjectV2DraftIssue(input: { projectId: $project, title: $title, body: $body }) { projectItem { id } } }',
          { project: projectId, ...item.draft },
        )) as { addProjectV2DraftIssue: { projectItem: { id: string } } }).addProjectV2DraftIssue.projectItem.id
      : ((await graphql(
          sys,
          token,
          'mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }',
          { project: projectId, content: item.content },
        )) as { addProjectV2ItemById: { item: { id: string } } }).addProjectV2ItemById.item.id;
    for (const value of item.values) {
      const field = fields.find((had) => had.name === value.field);
      const option = field?.options?.find((had) => had.name.toLowerCase() === value.option?.toLowerCase())?.id;
      const set =
        option !== undefined
          ? { singleSelectOptionId: option }
          : value.date !== undefined
            ? { date: value.date }
            : value.text !== undefined
              ? { text: value.text }
              : value.number !== undefined
                ? { number: value.number }
                : undefined;
      if (!field?.id || !set) continue;
      await graphql(
        sys,
        token,
        'mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) { projectV2Item { id } } }',
        { project: projectId, item: added, field: field.id, value: set },
      );
    }
  }
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
  io.err(`onboard: stopped at "${step}"; nothing after it was changed, and no pull request was opened`);
  return undefined;
}
