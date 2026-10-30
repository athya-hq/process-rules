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

/** GitHub's API cannot make Project views, so the owner makes these by hand. */
export function viewsChecklist(url: string): string[] {
  return [
    `Make these views in ${url} (GitHub's API cannot):`,
    '  [ ] Needs you: table, filter label:needs-owner is:open',
    '  [ ] Board: board by Status (Todo, In progress, Done); no "In review" column; show linked pull requests;',
    '      Workflows → Auto-archive items: is:closed updated:<@today-7d',
    '  [ ] Work items: table, filter type:"Work item", group by Step, show the Sub-issues progress field',
    '  [ ] Decisions: table, filter type:Decision, group by Decision; a "Reviews due" view filtered on Review date:<=@today',
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

async function list(sys: Sys, token: string, url: string): Promise<{ name: string }[]> {
  const { status, json } = await sys.http(url, { token });
  if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read ${url} (HTTP ${status})`);
  return json.filter((entry): entry is { name: string } => typeof (entry as { name?: unknown } | null)?.name === 'string');
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
): Promise<string | undefined> {
  const login = sys.exec('gh', ['auth', 'token']);
  const token = login.stdout.trim();
  if (login.code !== 0 || !token) {
    io.err(`onboard: gh is not signed in; sign in as ${owner} with: gh auth login -s ${OWNER_SCOPES.join(',')}`);
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

  const labels = await list(sys, token, `${API}/repos/${slug}/labels?per_page=100`);
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

  const title = `${repo.name} work`;
  const kind = repo.organisation ? 'organization' : 'user';
  const projects = (await graphql(
    sys,
    token,
    `query($login: String!, $title: String!) { ${kind}(login: $login) { id projectsV2(first: 20, query: $title) { nodes { id title url } } } }`,
    { login: repo.ownerLogin, title },
  )) as Record<string, { id: string; projectsV2: { nodes: { id: string; title: string; url: string }[] } }>;
  const holder = projects[kind];
  if (!holder) throw new Error(`GitHub has no ${kind} ${repo.ownerLogin}`);
  let project = holder.projectsV2.nodes.find((node) => node.title === title);
  if (!project) {
    if (!(await confirm(`Create the Project "${title}" for ${repo.ownerLogin}, linked to ${slug}?`))) {
      return stopped(io, 'project');
    }
    const made = (await graphql(
      sys,
      token,
      'mutation($owner: ID!, $title: String!, $repo: ID!) { createProjectV2(input: { ownerId: $owner, title: $title, repositoryId: $repo }) { projectV2 { id title url } } }',
      { owner: holder.id, title, repo: repo.nodeId },
    )) as { createProjectV2: { projectV2: { id: string; title: string; url: string } } };
    project = made.createProjectV2.projectV2;
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
  for (const line of viewsChecklist(project.url)) io.out(line);
  return project.url;
}

function stopped(io: Output, step: string): undefined {
  io.err(`onboard: stopped at "${step}"; nothing after it was changed`);
  return undefined;
}
