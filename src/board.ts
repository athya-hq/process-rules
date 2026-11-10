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

/** The Steps a Work item moves through, in order; a closed one is Done. */
export const STEPS = ['Frame', 'Specify', 'Slice', 'Build', 'Done'];

export const FIELDS = [
  { name: 'Step', options: STEPS },
  { name: 'Decision', options: ['Needs owner', 'Tripped', 'Decided by the routine'] },
  { name: 'Review date' },
];

/**
 * A Project view: the fields it must show and the fields it must not, by
 * name; any other column the owner shows by hand stays.
 */
export interface ViewSpec {
  name: string;
  layout: 'TABLE_LAYOUT' | 'BOARD_LAYOUT';
  filter: string;
  show: string[];
  hide: string[];
}

/**
 * The Project's views; onboard makes them, or updates the view that has the name.
 * Needs you also shows Type, which GitHub's API cannot show (viewsChecklist).
 */
export const VIEWS: ViewSpec[] = [
  // What waits on the owner, of every type; a slice's Parent issue is the work item it belongs to.
  { name: 'Needs you', layout: 'TABLE_LAYOUT', filter: 'label:needs-owner is:open', show: ['Parent issue'], hide: ['Assignees'] },
  // The work in motion: slices and briefs. Closed ones leave Done when the auto-archive workflow archives them.
  { name: 'Board', layout: 'BOARD_LAYOUT', filter: 'type:Slice,Brief', show: ['Linked pull requests'], hide: [] },
  { name: 'Work items', layout: 'TABLE_LAYOUT', filter: 'type:"Work item"', show: ['Sub-issues progress'], hide: [] },
  { name: 'Decisions', layout: 'TABLE_LAYOUT', filter: 'type:Decision', show: [], hide: [] },
  { name: 'Reviews due', layout: 'TABLE_LAYOUT', filter: '"Review date":<=@today', show: [], hide: [] },
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

/**
 * How long Done keeps an item on the Board: a view's filter cannot say
 * "open, or closed this week", since GitHub's Project filters join different
 * fields with AND alone and have no closed date, so the auto-archive
 * workflow takes closed items off after it.
 */
const ARCHIVE_FILTER = 'is:closed updated:<@today-7d';

/**
 * How the owner shows Type on Needs you. GitHub's API can neither read nor
 * set the issue-type column: GraphQL lists no such field, REST cannot update
 * a view, and updateProjectV2View refuses its id ("Visible fields must be
 * available in the view.").
 */
const TYPE_STEP = 'Needs you: add the Type column (+ at the right of the headers → Type, then Save)';

/** What GitHub's API cannot set on a Project not copied from the template, so the owner does it by hand. */
export function viewsChecklist(url: string): string[] {
  return [
    `Finish the Project ${url} by hand (GitHub's API cannot):`,
    `  [ ] ${TYPE_STEP}`,
    '  [ ] Work items: group by Step',
    '  [ ] Decisions: group by Decision',
    `  [ ] Workflows → Auto-archive items: ${ARCHIVE_FILTER}`,
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

/** The board's steps a yes is asked for, so a caller can answer each kind its own way. */
export type BoardStep = 'issue types' | 'labels' | 'project' | 'replace' | 'link' | 'fields' | 'views';

/** What setUpBoard leaves: the Project, and what GitHub's API cannot do there, for the owner to do by hand. */
export interface BoardSetUp {
  url: string;
  byHand: string[];
}

/**
 * Sets up the client's work board as the owner, with the owner's token for
 * this run (owner-login.ts): the organisation's issue types, the repo's
 * labels, and a Project linked to the repo with the work model's fields. Creates only what is
 * missing; every change waits for `confirm`'s yes. Returns the Project and
 * what is left to do by hand, or undefined when it stopped.
 */
export async function setUpBoard(
  sys: Sys,
  io: Output,
  confirm: (question: string, step: BoardStep) => Promise<boolean>,
  slug: string,
  owner: string,
  /** The owner's token, with the project scope, and admin:org for an organisation's repository. */
  token: string,
  /** The Project's title; `<repo> work` when the settings name none. */
  projectTitle?: string,
): Promise<BoardSetUp | undefined> {
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
      if (!(await confirm(`Issue types are an organisation-wide setting, so they apply to every repository in ${repo.ownerLogin}, not only ${repo.name}. Add the issue types ${names} to the ${repo.ownerLogin} organisation?`, 'issue types'))) {
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
    if (!(await confirm(`Add the labels ${newLabels.map((l) => l.name).join(', ')} to ${slug}?`, 'labels'))) {
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
    if (!(await confirm(`Create the Project "${title}" for ${repo.ownerLogin} from the process-rules template, linked to ${slug}?`, 'project'))) {
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
    if (await confirm(question, 'replace')) {
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
    if (!(await confirm(`Link the Project "${title}" to ${slug}?`, 'link'))) return stopped(io, 'project');
    await link(sys, token, project.id, repo.nodeId);
  }
  io.out(`✓ Project "${title}": ${project.url}`);

  type Option = { id: string; name: string; color: string; description: string };
  const fields = (await graphql(
    sys,
    token,
    'query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { id name color description } } } } } } }',
    { id: project.id },
  )) as { node: { fields: { nodes: { id?: string; name?: string; options?: Option[] }[] } } };
  const had = (name: string) => fields.node.fields.nodes.find((node) => node.name?.toLowerCase() === name.toLowerCase());
  const newFields = FIELDS.filter((field) => !had(field.name));
  if (newFields.length > 0) {
    if (!(await confirm(`Add the fields ${newFields.map((f) => f.name).join(', ')} to "${title}"?`, 'fields'))) {
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
  // A field made before an option joined it, such as Step's Done, gains the option.
  const short = FIELDS.flatMap((field) => {
    const held = had(field.name);
    const absent = field.options?.filter((name) => held?.options && !held.options.some((option) => option.name.toLowerCase() === name.toLowerCase())) ?? [];
    return held?.id && held.options && absent.length > 0 ? [{ id: held.id, name: field.name, options: held.options, absent }] : [];
  });
  if (short.length > 0) {
    const what = short.map((field) => `${field.absent.join(', ')} to the field ${field.name}`).join(' and ');
    const plural = short.flatMap((field) => field.absent).length > 1 ? 's' : '';
    if (!(await confirm(`Add the option${plural} ${what} in "${title}"?`, 'fields'))) {
      return stopped(io, 'fields');
    }
    for (const field of short) {
      // GitHub replaces the field's options with those sent: each kept one goes with its id, so no item loses its value.
      await graphql(
        sys,
        token,
        'mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2FieldCommon { name } } } }',
        {
          field: field.id,
          options: [
            ...field.options.map(({ id, name, color, description }) => ({ id, name, color, description })),
            ...field.absent.map((name) => ({ name, color: 'GRAY', description: '' })),
          ],
        },
      );
    }
  }
  io.out(`✓ fields: ${FIELDS.map((f) => f.name).join(', ')}`);

  const reset = await setUpViews(sys, token, confirm, project.id, title);
  if (!reset) return stopped(io, 'views');
  io.out(`✓ views: ${VIEWS.map((v) => v.name).join(', ')}`);
  const done = await finished(sys, token, project.id);
  const byHand: string[] = [];
  if (!done.grouped) {
    for (const line of viewsChecklist(project.url)) io.out(line);
    byHand.push(`Type on Needs you, group 2 views, auto-archive → ${project.url}`);
  } else {
    if (reset.includes('Needs you')) {
      // The column list sent could not name Type, so a Type the owner showed may be gone.
      io.out(`Needs you's columns were set through GitHub's API, which cannot see a Type column, so one shown there may be gone; in ${project.url}: ${TYPE_STEP}`);
      byHand.push(`Type on Needs you again → ${project.url}`);
    }
    io.out(`- Board shows slices and briefs; Done keeps one until the Auto-archive items workflow archives it, with the template's filter ${ARCHIVE_FILTER}, which GitHub's API can neither read nor set`);
  }
  if (done.off.length > 0) {
    io.out(`Turn on the workflows ${done.off.join(', ')} in ${project.url} → Workflows (GitHub's API cannot)`);
    byHand.push(`turn on ${done.off.length} project workflow${done.off.length === 1 ? '' : 's'} → ${project.url}/workflows`);
  }
  return { url: project.url, byHand };
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

type View = { id: string; name: string; layout: string; filter: string | null; configuration: { visibleFields: { nodes: { name?: string }[] } } };

/**
 * A view, its visible fields by name: GitHub gives a visible field an id that
 * updateProjectV2View can refuse (Status's PVTF_ there, PVTSSF_ in the
 * Project's fields), so the ids it is sent come from the Project's fields.
 */
const VIEW = 'id name layout filter configuration { visibleFields(first: 50) { nodes { ... on ProjectV2FieldCommon { name } } } }';

/**
 * Makes the Project's views, or updates the view that already has the name,
 * so a rerun makes no duplicates; the default view becomes the first view it
 * would otherwise make. Every change waits for one yes. Returns the names of
 * the views whose columns it sent, or undefined when that yes was not given.
 * A view whose columns are right is never sent them, so a rerun keeps a Type
 * column the owner added, which GitHub's API cannot see.
 */
export async function setUpViews(
  sys: Sys,
  token: string,
  confirm: (question: string, step: BoardStep) => Promise<boolean>,
  projectId: string,
  title: string,
): Promise<string[] | undefined> {
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
  if (changes.length === 0) return [];
  const renamed = changes.find((step) => step.view?.name === DEFAULT_VIEW);
  const question = `Set up the views ${changes.map((step) => step.spec.name).join(', ')} in "${title}"${renamed ? ` (renaming "${DEFAULT_VIEW}" to "${renamed.spec.name}")` : ''}?`;
  if (!(await confirm(question, 'views'))) return undefined;
  const sent: string[] = [];

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
    const visible = columns(view, spec, fieldIds);
    await graphql(
      sys,
      token,
      'mutation($view: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $filter: String!, $configuration: ProjectV2ViewConfigurationInput) { updateProjectV2View(input: { viewId: $view, name: $name, layout: $layout, filter: $filter, configuration: $configuration }) { projectV2View { id } } }',
      {
        view: view.id,
        name: spec.name,
        layout: spec.layout,
        filter: spec.filter,
        configuration: visible ? { visibleFieldIds: visible } : null,
      },
    );
    if (visible) sent.push(spec.name);
  }
  return sent;
}

function visibleNames(view: View): string[] {
  return view.configuration.visibleFields.nodes.map((field) => field.name).filter((name) => name !== undefined);
}

/**
 * The ids of the fields the view should show, in its order, when they differ
 * from what it shows: less the fields the spec hides, with the ones it shows.
 * Undefined when the view's fields are already right. GitHub's API reads no
 * Type column and cannot show one, so sending these may drop a Type the
 * owner showed by hand; a settled view is never sent them.
 */
function columns(view: View, spec: ViewSpec, fieldIds: Map<string | undefined, string | undefined>): string[] | undefined {
  const visible = visibleNames(view);
  const show = spec.show.filter((name) => fieldIds.has(name) && !visible.includes(name));
  if (show.length === 0 && !spec.hide.some((name) => visible.includes(name))) return undefined;
  return [...visible.filter((name) => !spec.hide.includes(name)), ...show].map((name) => fieldIds.get(name)).filter((id) => id !== undefined);
}

/** Whether the view already is what the spec asks for. */
function settled(view: View, spec: ViewSpec, fieldIds: Map<string | undefined, string | undefined>): boolean {
  return view.name === spec.name && view.layout === spec.layout && (view.filter ?? '') === spec.filter && columns(view, spec, fieldIds) === undefined;
}

/**
 * GitHub's REST answer at `url`, and the next page's URL its Link header
 * names. The board moves a push makes use REST alone: a Claude cloud
 * session's GitHub proxy refuses GraphQL.
 */
async function rest(sys: Sys, token: string, url: string, options: { method?: string; body?: unknown } = {}): Promise<{ json: unknown; next: string | undefined }> {
  const { status, json, headers } = await sys.http(url, { token, ...options });
  if (status < 200 || status >= 300) {
    const message = (json as { message?: unknown } | null)?.message;
    throw new Error(`GitHub's REST API refused ${options.method ?? 'GET'} ${url.replace(API, '')}: HTTP ${status}${typeof message === 'string' ? ` ${message}` : ''}`);
  }
  return { json, next: /<([^>]+)>;\s*rel="next"/.exec(headers?.link ?? '')?.[1] };
}

/** Every entry of a REST list at `url`, following its pages. */
async function all<T>(sys: Sys, token: string, url: string): Promise<T[]> {
  const entries: T[] = [];
  for (let next: string | undefined = url; next; ) {
    const page = await rest(sys, token, next);
    if (!Array.isArray(page.json)) throw new Error(`GitHub's REST API did not answer a list (${next.replace(API, '')})`);
    entries.push(...(page.json as T[]));
    next = page.next;
  }
  return entries;
}

/** A name as GitHub's REST API gives a Project's option: `{ raw, html }`, or a plain string. */
type Named = { raw?: string } | string | undefined;
const named = (name: Named): string | undefined => (typeof name === 'string' ? name : name?.raw);

/** A Project's field, as GitHub's REST API lists it. */
interface ProjectField {
  id: number;
  name: string;
  data_type: string;
  options?: { id: string; name: Named }[];
}

/** An issue as GitHub's REST API gives it. */
interface RestIssue {
  number: number;
  state: string;
  url?: string;
  type?: { name?: string } | null;
}

/** An item of a Project, holding an issue, with its single-select field `field`, the item's value of it, and what the issue is now. */
type BoardItem = {
  url: string;
  project: string;
  number: number;
  field: ProjectField;
  value: string | undefined;
  /** The issue's type's name, its state, and its sub-issues: how many, and how many closed. */
  type: string | undefined;
  state: string | undefined;
  subIssues: { total: number; completed: number };
};

/** The field's option named `option`, in any case. */
const optionOf = (field: ProjectField, option: string) => field.options?.find((had) => named(had.name)?.toLowerCase() === option.toLowerCase());

/**
 * Sets `item`'s field to the option named `option`, in any case, unless the
 * field lacks the option or the item has it already. Returns the Project's
 * title when it moved the item.
 */
async function moveTo(sys: Sys, token: string, item: BoardItem, option: string): Promise<string | undefined> {
  const chosen = optionOf(item.field, option);
  if (!chosen || item.value?.toLowerCase() === option.toLowerCase()) return undefined;
  await rest(sys, token, item.url, { method: 'PATCH', body: { fields: [{ id: item.field.id, value: chosen.id }] } });
  return item.project;
}

/** The items of `slug`'s issues on its owner's open Projects that have a single-select Status or Step, each with its value. */
async function projectItems(sys: Sys, token: string, slug: string): Promise<{ status: BoardItem[]; step: BoardItem[] }> {
  const repo = (await rest(sys, token, `${API}/repos/${slug}`)).json as { owner?: { login?: string; type?: string } } | null;
  const owner = repo?.owner?.login ?? slug.split('/')[0];
  const base = `${API}/${repo?.owner?.type === 'User' ? 'users' : 'orgs'}/${owner}/projectsV2`;
  const projects = await all<{ number: number; title: string; state?: string; closed_at?: string | null }>(sys, token, `${base}?per_page=100`);
  const found = { status: [] as BoardItem[], step: [] as BoardItem[] };
  const repoUrl = `/repos/${slug}`.toLowerCase();
  // A closed Project is no longer anyone's board.
  for (const project of projects.filter((had) => had.state !== 'closed' && !had.closed_at)) {
    const url = `${base}/${project.number}`;
    const fields = await all<ProjectField>(sys, token, `${url}/fields?per_page=100`);
    const single = (name: string) => fields.find((field) => field.name === name && field.data_type === 'single_select');
    const status = single('Status');
    const step = single('Step');
    if (!status && !step) continue;
    const wanted = [status, step].flatMap((field) => (field ? [field.id] : [])).join(',');
    // Each item holds its issue as GitHub's REST API gives one: its type, state and sub-issues come with it, so no issue is read on its own.
    const items = await all<{
      id: number;
      content_type?: string;
      archived_at?: string | null;
      content?: {
        number?: number;
        repository_url?: string;
        state?: string;
        type?: { name?: string } | null;
        sub_issues_summary?: { total?: number; completed?: number } | null;
      } | null;
      fields?: { id?: number; value?: { name?: Named } | null }[];
    }>(sys, token, `${url}/items?per_page=100&fields=${wanted}`);
    for (const item of items) {
      const content = item.content;
      const number = content?.number;
      if (item.archived_at || item.content_type !== 'Issue' || !number || !content?.repository_url?.toLowerCase().endsWith(repoUrl)) continue;
      const of = (field: ProjectField): BoardItem => ({
        url: `${url}/items/${item.id}`,
        project: project.title,
        number,
        field,
        value: named(item.fields?.find((held) => held.id === field.id)?.value?.name),
        type: content.type?.name ?? undefined,
        state: content.state,
        subIssues: { total: content.sub_issues_summary?.total ?? 0, completed: content.sub_issues_summary?.completed ?? 0 },
      });
      if (status) found.status.push(of(status));
      if (step) found.step.push(of(step));
    }
  }
  return found;
}

const rank = (step: string | undefined): number => STEPS.findIndex((had) => had.toLowerCase() === step?.toLowerCase());

/**
 * The Step GitHub's facts put a Work item at, when its Step must move there:
 * a closed one is Done; an open one is at least Frame, at least Slice once
 * it has sub-issues, and at least Build once one of them is closed or
 * `building` (a push builds one). Specify has no fact that marks it, so it
 * is set by hand and kept. A Step moves only forward, except that a reopened
 * work item leaves Done; an option the owner added to Step is kept.
 */
export function stepDue(item: Pick<BoardItem, 'value' | 'state' | 'subIssues'>, building = false): string | undefined {
  const now = rank(item.value);
  if (item.value !== undefined && now < 0) return undefined;
  if (item.state === 'closed') return now === rank('Done') ? undefined : 'Done';
  const due = building || item.subIssues.completed > 0 ? 'Build' : item.subIssues.total > 0 ? 'Slice' : 'Frame';
  return item.value === undefined || now === rank('Done') || now < rank(due) ? due : undefined;
}

type Move = { item: BoardItem; option: string; name: string; what: string };

/**
 * The Step moves for the Work items among `items`, `parent` being the work
 * item a push builds a slice of: newest first, that one leading. A Project
 * whose Step lacks the option a move needs, such as Done on one made before
 * it, gets one line saying so instead of those moves.
 */
function stepMoves(items: BoardItem[], parent?: number): { moves: Move[]; lacking: string[] } {
  const moves: Move[] = [];
  const lacking = new Map<string, Set<string>>();
  const ordered = items.filter((item) => item.type === 'Work item').sort((a, b) => Number(b.number === parent) - Number(a.number === parent) || b.number - a.number);
  for (const item of ordered) {
    const option = stepDue(item, item.number === parent);
    if (!option) continue;
    if (!optionOf(item.field, option)) {
      lacking.set(item.project, (lacking.get(item.project) ?? new Set()).add(option));
      continue;
    }
    const name = `work item #${item.number}`;
    const what = item.value === undefined ? `${name} had no Step; it is at ${option}` : option === 'Done' ? `${name} is closed; it is at Step Done` : `${name} is at Step ${option}`;
    moves.push({ item, option, name, what });
  }
  return {
    moves,
    lacking: [...lacking].map(([project, options]) => `! board: Step in "${project}" has no option ${[...options].join(', ')}, so work items that belong there stay where they are; niyam onboard adds it`),
  };
}

/** Makes the moves, each standing alone, so one GitHub refuses leaves the others made; returns them as lines. */
async function move(sys: Sys, token: string, moves: Move[]): Promise<string[]> {
  const moved: string[] = [];
  for (const { item, option, name, what } of moves) {
    try {
      const project = await moveTo(sys, token, item, option);
      if (project) moved.push(`✓ board: ${what} in "${project}"`);
    } catch (error) {
      moved.push(`! board: ${name} was not moved to ${option} in "${item.project}" (${(error as Error).message})`);
    }
  }
  return moved;
}

/**
 * Moves every Work item of `slug` to the Step `stepDue` gives it, on every
 * open Project of the repository's owner that holds it, through GitHub's
 * REST API alone. Returns what moved, as lines.
 */
export async function boardSwept(sys: Sys, token: string, slug: string): Promise<string[]> {
  const steps = stepMoves((await projectItems(sys, token, slug)).step);
  return [...(await move(sys, token, steps.moves)), ...steps.lacking];
}

/**
 * Moves the work board on as an agent starts building slice `slice` of
 * `slug`, with the agent's token, on every open Project of the repository's
 * owner that holds the issues: the open slice's Status to In Progress; its
 * Work item's Step to Build, as its first slice has started; and every
 * other Work item to the Step `stepDue` gives it, so a closed one is Done
 * and a new one is at Frame. A workflow's GITHUB_TOKEN cannot write a
 * Project, so the agent's push does this, through GitHub's REST API alone,
 * as a cloud session's proxy refuses GraphQL. Returns what moved, as lines.
 */
export async function boardStarted(sys: Sys, token: string, slug: string, slice: number): Promise<string[]> {
  const issue = (await rest(sys, token, `${API}/repos/${slug}/issues/${slice}`)).json as RestIssue;
  // A closed slice is built already: a fix to it starts nothing on the board.
  if (issue.state !== 'open') return [];
  const { status, json } = await sys.http(`${issue.url ?? `${API}/repos/${slug}/issues/${slice}`}/parent`, { token });
  // An issue with no parent reads as 404 "No parent issue found"; any other failure is a read that failed, not a missing parent.
  const message = (json as { message?: unknown } | null)?.message;
  if (status !== 200 && !(status === 404 && typeof message === 'string' && /no parent/i.test(message))) {
    throw new Error(`GitHub's REST API refused GET /repos/${slug}/issues/${slice}/parent: HTTP ${status}${typeof message === 'string' ? ` ${message}` : ''}`);
  }
  const parent = status === 200 && (json as RestIssue | null)?.type?.name === 'Work item' ? (json as RestIssue).number : undefined;
  const items = await projectItems(sys, token, slug);
  const steps = stepMoves(items.step, parent);
  const moved = await move(sys, token, [
    ...items.status.filter((item) => item.number === slice).map((item) => ({ item, option: 'In Progress', name: `slice #${slice}`, what: `slice #${slice} is In Progress` })),
    ...steps.moves,
  ]);
  return [...moved, ...steps.lacking];
}

function stopped(io: Output, step: string): undefined {
  io.err(`onboard: stopped at "${step}"; nothing after it was changed, and no pull request was opened`);
  return undefined;
}
