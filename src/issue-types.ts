import { API } from './agent.ts';
import type { Finding } from './layout.ts';
import type { Output, Sys } from './types.ts';

/** The issue types the work model uses; an organisation-wide setting. */
export const ISSUE_TYPES = [
  { name: 'Work item', color: 'blue', description: 'A piece of work: its frame and spec, approved by the owner' },
  { name: 'Slice', color: 'green', description: 'One shippable part of a work item, built in one pull request' },
  { name: 'State', color: 'purple', description: "An experience state of a slice, linking its design frame" },
  { name: 'Decision', color: 'orange', description: 'A watched decision with a review date' },
  { name: 'Brief', color: 'gray', description: 'A small request, closed by the pull request that fixes it' },
];

/** An organisation's issue type, as GitHub lists it. */
export interface OrgType {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  is_enabled: boolean;
}

/** An issue holding a type outside the work model, and the work model's type it gets. */
export interface Retype {
  repo: string;
  number: number;
  from: string;
  to: string;
  why: string;
}

/**
 * What makes an organisation's enabled issue types exactly the work model's:
 * the work model's types to add or enable, the issues holding any other type
 * with the type each gets, and the other types to disable once none of them
 * holds one.
 */
export interface TypesPlan {
  org: string;
  add: typeof ISSUE_TYPES;
  enable: OrgType[];
  retype: Retype[];
  /** Issues in archived repositories, which GitHub keeps read-only, so they keep their type. */
  held: Retype[];
  disable: OrgType[];
  /** Enabled types outside the work model an issue in an archived repository holds, so left enabled. */
  kept: OrgType[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const inModel = (name: string): boolean => ISSUE_TYPES.some((type) => same(type.name, name));

/** Every entry a REST list holds, reading 100 a page; none, when `gone` and GitHub answers 410 Gone. */
export async function pages(sys: Sys, token: string, url: string, gone = false): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (let page = 1; ; page++) {
    const pageUrl = `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
    const { status, json } = await sys.http(pageUrl, { token });
    if (gone && status === 410) return entries;
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot read ${url} (HTTP ${status})`);
    entries.push(...(json as unknown[]));
    if (json.length < 100) return entries;
  }
}

/** The organisation's issue types, enabled and disabled. */
export async function orgTypes(sys: Sys, token: string, org: string): Promise<OrgType[]> {
  return (await pages(sys, token, `${API}/orgs/${org}/issue-types`)).filter(
    (entry): entry is OrgType => typeof (entry as { name?: unknown } | null)?.name === 'string',
  );
}

interface Holder {
  repo: string;
  archived: boolean;
  number: number;
  url: string;
  from: string;
  parent: string | null;
  subIssues: number;
}

/** The issues in a repository that hold the type, open and closed; pull requests have no type. */
async function holding(sys: Sys, token: string, repo: string, type: string): Promise<Omit<Holder, 'archived'>[]> {
  // GitHub answers 410 Gone for a repository with issues turned off, a fork's usual setting: it holds none to retype.
  const rows = await pages(sys, token, `${API}/repos/${repo}/issues?type=${encodeURIComponent(type)}&state=all`, true);
  return rows.flatMap((row) => {
    const issue = row as { number?: unknown; url?: unknown; pull_request?: unknown; type?: { name?: unknown } | null; parent_issue_url?: unknown; sub_issues_summary?: { total?: unknown } };
    // Only an issue GitHub shows holding the type, so a filter GitHub ignored retypes nothing.
    if (issue.pull_request || typeof issue.number !== 'number' || typeof issue.url !== 'string' || typeof issue.type?.name !== 'string' || !same(issue.type.name, type)) return [];
    return [
      {
        repo,
        number: issue.number,
        url: issue.url,
        from: issue.type.name,
        parent: typeof issue.parent_issue_url === 'string' ? issue.parent_issue_url : null,
        subIssues: typeof issue.sub_issues_summary?.total === 'number' ? issue.sub_issues_summary.total : 0,
      },
    ];
  });
}

/**
 * Works out, changing nothing, what makes the organisation's enabled issue
 * types exactly the work model's. Types are the organisation's, so it reads
 * every repository the token can see, onboarded or not. Each issue holding
 * another type gets one from GitHub's facts about it: a sub-issue of a Work
 * item is a Slice, an issue with sub-issues a Work item, any other a Brief.
 */
export async function typesPlan(sys: Sys, token: string, org: string): Promise<TypesPlan> {
  const types = await orgTypes(sys, token, org);
  const add = ISSUE_TYPES.filter((type) => !types.some((had) => same(had.name, type.name)));
  const enable = types.filter((type) => inModel(type.name) && !type.is_enabled);
  // Disabled ones too, so a rerun finds an issue a type left behind when someone disabled it by hand.
  const others = types.filter((type) => !inModel(type.name));
  const holders: Holder[] = [];
  if (others.length > 0) {
    const repos = (await pages(sys, token, `${API}/orgs/${org}/repos?type=all`)).flatMap((entry) => {
      const repo = entry as { full_name?: unknown; archived?: unknown; has_issues?: unknown };
      // A repository with issues turned off has none GitHub would list.
      return typeof repo.full_name === 'string' && repo.has_issues !== false ? [{ slug: repo.full_name, archived: repo.archived === true }] : [];
    });
    for (const repo of repos) {
      for (const type of others) holders.push(...(await holding(sys, token, repo.slug, type.name)).map((found) => ({ ...found, archived: repo.archived })));
    }
  }

  // A parent being retyped is read as the type it gets; any other is asked of GitHub once.
  const byUrl = new Map(holders.map((holder) => [holder.url, holder]));
  const asked = new Map<string, string | undefined>();
  const decided = new Map<string, Retype>();
  const typeAt = async (url: string): Promise<string | undefined> => {
    const holder = byUrl.get(url);
    if (holder) return (await decide(holder)).to;
    if (!asked.has(url)) {
      const { status, json } = await sys.http(url, { token });
      if (status !== 200) throw new Error(`cannot read ${url} (HTTP ${status})`);
      const name = (json as { type?: { name?: unknown } | null } | null)?.type?.name;
      asked.set(url, typeof name === 'string' ? name : undefined);
    }
    return asked.get(url);
  };
  const decide = async (holder: Holder): Promise<Retype> => {
    const known = decided.get(holder.url);
    if (known) return known;
    const parent = holder.parent ? await typeAt(holder.parent) : undefined;
    const parentNumber = holder.parent?.split('/').at(-1);
    const [to, why] =
      parent !== undefined && same(parent, 'Work item')
        ? ['Slice', `its parent #${parentNumber} is a Work item`]
        : holder.subIssues > 0
          ? ['Work item', `it has ${holder.subIssues} sub-issue${holder.subIssues === 1 ? '' : 's'}`]
          : ['Brief', holder.parent ? `its parent #${parentNumber} is not a Work item, and it has no sub-issues` : 'it has no parent and no sub-issues'];
    const retype: Retype = { repo: holder.repo, number: holder.number, from: holder.from, to, why };
    decided.set(holder.url, retype);
    return retype;
  };
  const retype: Retype[] = [];
  const held: Retype[] = [];
  for (const holder of holders) (holder.archived ? held : retype).push(await decide(holder));
  const extra = others.filter((type) => type.is_enabled);
  const kept = extra.filter((type) => held.some((issue) => same(issue.from, type.name)));
  return { org, add, enable, retype, held, disable: extra.filter((type) => !kept.includes(type)), kept };
}

/** Whether the plan changes anything. */
export function typesChange(plan: TypesPlan): boolean {
  return plan.add.length + plan.enable.length + plan.retype.length + plan.disable.length > 0;
}

const names = (types: { name: string }[]): string => types.map((type) => type.name).join(', ');
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const where = (issue: Retype): string => `${issue.repo.split('/').at(-1)}#${issue.number}`;

/** The plan in a few words, for onboard's plan; typesLines names what it counts. */
export function typesDetail(plan: TypesPlan): string {
  const parts = [
    ...(plan.add.length > 0 ? [`add ${plan.add.length}`] : []),
    ...(plan.enable.length > 0 ? [`enable ${plan.enable.length}`] : []),
    ...(plan.retype.length > 0 ? [`retype ${plan.retype.length}`] : []),
    ...(plan.disable.length > 0 ? [`disable ${plan.disable.length}`] : []),
  ];
  return parts.length > 0 ? `org-wide: ${parts.join(', ')}` : 'org-wide, the work model’s alone';
}

/** How many retyped issues onboard's plan and its question name; the pull request's description names them all. */
const NAMED = 10;

/** What typesDetail counts, one line each, after the plan's issue types line, in the order the run does it. */
export function typesLines(plan: TypesPlan): { label: string; detail: string }[] {
  const more = plan.retype.length - NAMED;
  return [
    ...(plan.add.length > 0 ? [{ label: '  add', detail: names(plan.add) }] : []),
    ...(plan.enable.length > 0 ? [{ label: '  enable', detail: names(plan.enable) }] : []),
    ...plan.retype.slice(0, NAMED).map((issue) => ({ label: `  ${where(issue)}`, detail: `${issue.from} → ${issue.to}` })),
    ...(more > 0 ? [{ label: `  and ${more} more`, detail: 'retyped by the same rule' }] : []),
    ...(plan.disable.length > 0 ? [{ label: '  disable', detail: names(plan.disable) }] : []),
    ...(plan.kept.length > 0 ? [{ label: '  keep', detail: `${names(plan.kept)}: archived repos hold them` }] : []),
  ];
}

/** The yes setUpBoard asks for, saying it reaches the whole organisation; undefined when nothing changes. */
export function typesQuestion(plan: TypesPlan, repoName: string): string | undefined {
  if (!typesChange(plan)) return undefined;
  const parts = [
    ...(plan.add.length > 0 ? [`add the issue types ${names(plan.add)}`] : []),
    ...(plan.enable.length > 0 ? [`enable ${names(plan.enable)}`] : []),
    ...(plan.retype.length > 0
      ? [
          `give ${plural(plan.retype.length, 'issue')} holding another type a work model type (${[
            ...plan.retype.slice(0, NAMED).map((issue) => `${issue.repo}#${issue.number} ${issue.from} → ${issue.to}`),
            ...(plan.retype.length > NAMED ? [`and ${plan.retype.length - NAMED} more`] : []),
          ].join('; ')})`,
        ]
      : []),
    ...(plan.disable.length > 0 ? [`then disable ${names(plan.disable)}, which can be enabled again`] : []),
  ];
  const sentence = parts.join(', ');
  return `Issue types are an organisation-wide setting, so they apply to every repository in ${plan.org}, not only ${repoName}. In the ${plan.org} organisation, ${sentence}?`;
}

/**
 * Carries the plan out as the owner: adds and enables the work model's
 * types, retypes every issue holding another, and only then disables the
 * other types, so no issue is left holding a disabled one (GitHub hides a
 * disabled type on its issues and shows it again when it is enabled; it
 * does not say what deleting one does to them, so onboard disables, never
 * deletes). Returns what is left to do by hand.
 */
export async function applyTypes(sys: Sys, io: Output, token: string, plan: TypesPlan): Promise<string[]> {
  const { org } = plan;
  for (const type of plan.add) {
    const made = await sys.http(`${API}/orgs/${org}/issue-types`, { method: 'POST', token, body: { ...type, is_enabled: true } });
    if (made.status !== 200 && made.status !== 201) throw new Error(`GitHub did not add the issue type ${type.name} (HTTP ${made.status})`);
  }
  for (const type of plan.enable) await putType(sys, token, org, type, true);
  if (plan.enable.length > 0) io.out(`✓ enabled the issue types ${names(plan.enable)} in ${org}`);
  for (const issue of plan.retype) {
    const { status, json } = await sys.http(`${API}/repos/${issue.repo}/issues/${issue.number}`, { method: 'PATCH', token, body: { type: issue.to } });
    const now = (json as { type?: { name?: unknown } | null } | null)?.type?.name;
    if (status !== 200 || typeof now !== 'string' || !same(now, issue.to)) throw new Error(`GitHub did not make ${issue.repo}#${issue.number} a ${issue.to} (HTTP ${status})`);
    io.out(`✓ retyped ${issue.repo}#${issue.number} ${issue.from} → ${issue.to}: ${issue.why}`);
  }
  for (const type of plan.disable) await putType(sys, token, org, type, false);
  if (plan.disable.length > 0) {
    io.out(`✓ disabled the issue types ${names(plan.disable)} in ${org}, outside the work model, once no issue held them; not deleted, so they can be enabled again`);
  }
  for (const issue of plan.held) io.out(`- ${issue.repo}#${issue.number} keeps ${issue.from}: ${issue.repo} is archived, which GitHub keeps read-only`);
  if (plan.kept.length > 0) io.out(`- left ${names(plan.kept)} enabled in ${org}, since an issue in an archived repository holds ${plan.kept.length === 1 ? 'it' : 'them'}`);
  io.out(`✓ issue types in ${org}: ${names(ISSUE_TYPES)}`);
  const archived = [...new Set(plan.held.map((issue) => issue.repo))];
  return archived.length > 0 ? [`issue types: unarchive ${archived.join(', ')}, then niyam onboard again, to retype ${plan.held.map((issue) => `${issue.repo}#${issue.number}`).join(', ')} and disable ${names(plan.kept)}`] : [];
}

/** Sets a type enabled or disabled, sending its name, description and colour back, since GitHub's PUT takes them all. */
async function putType(sys: Sys, token: string, org: string, type: OrgType, enabled: boolean): Promise<void> {
  const { status } = await sys.http(`${API}/orgs/${org}/issue-types/${type.id}`, {
    method: 'PUT',
    token,
    body: { name: type.name, description: type.description, color: type.color, is_enabled: enabled },
  });
  if (status !== 200) throw new Error(`GitHub did not ${enabled ? 'enable' : 'disable'} the issue type ${type.name} (HTTP ${status})`);
}

/** The fix for issue-type drift: onboard, run by the owner, who alone can change the organisation's types. */
export const RERUN = 'the owner reruns niyam onboard, which retypes those issues and disables the other types';

/**
 * doctor's check that the organisation's enabled issue types are the work
 * model's, and that no issue in this repository holds another.
 */
export async function typesDrift(sys: Sys, token: string, org: string, slug: string): Promise<Finding> {
  const types = await orgTypes(sys, token, org);
  const missing = ISSUE_TYPES.filter((type) => !types.some((had) => same(had.name, type.name) && had.is_enabled));
  const extra = types.filter((type) => !inModel(type.name) && type.is_enabled);
  const here: string[] = [];
  for (const type of extra) here.push(...(await holding(sys, token, slug, type.name)).map((issue) => `#${issue.number} ${issue.from}`));
  if (missing.length === 0 && extra.length === 0) return { mark: '✓', text: `issue types in ${org}: the work model’s alone` };
  const parts = [
    ...(missing.length > 0 ? [`${org} lacks the work model's ${names(missing)}`] : []),
    ...(extra.length > 0 ? [`${org} has issue types outside the work model: ${names(extra)}`] : []),
    ...(here.length > 0 ? [`${plural(here.length, 'issue')} here hold${here.length === 1 ? 's' : ''} one (${here.join(', ')})`] : []),
  ];
  return { mark: '▲', text: parts.join('; '), fix: RERUN };
}
