import { API, OLD_SETTINGS_PATH, SETTINGS_PATH, loadSettings, settingsPathIn } from './agent.ts';
import { HOURLY, isOn, notAdoptedLine, offLine } from './features.ts';
import { isOrganisation } from './owner-login.ts';
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

/** What a Retype's `from` says of an open issue with no type: no type's name, so it never matches one. */
export const NO_TYPE = 'no type';

/** An issue holding a type outside the work model, or an open one with no type, and the work model's type it gets. */
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
  /** Every type outside the work model, enabled or not, by name. */
  others: string[];
  /**
   * Disabled types outside the work model whose issues GitHub will not list:
   * it refuses to filter by a disabled type (HTTP 422), so whether any issue
   * still holds one, hidden, is not known. They stay disabled.
   */
  unlisted: string[];
  add: typeof ISSUE_TYPES;
  enable: OrgType[];
  retype: Retype[];
  /** Issues in archived repositories, which GitHub keeps read-only, so they keep their type. */
  held: Retype[];
  disable: OrgType[];
  /** Enabled types outside the work model an issue onboard does not retype holds, so left enabled. */
  kept: OrgType[];
  /** Issues found holding another type, or with none, after the plan the owner approved was shown, so not retyped this run. */
  late: Retype[];
  /** Open issues with no type left so: each a repository's Approvals issue, which its settings name. */
  exempt: { repo: string; number: number }[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const inModel = (name: string): boolean => ISSUE_TYPES.some((type) => same(type.name, name));

/**
 * The work model's type GitHub's facts give an issue, and why: a sub-issue
 * of a Work item is a Slice, a sub-issue of a Slice a State (an experience
 * state of that slice), an issue with sub-issues a Work item, any other a
 * Brief. `parent` is the parent's number and type, when it has a parent.
 */
export function typeFor(parent: { number: string; type: string | undefined } | undefined, subIssues: number): { to: string; why: string } {
  if (parent?.type !== undefined && same(parent.type, 'Work item')) return { to: 'Slice', why: `its parent #${parent.number} is a Work item` };
  if (parent?.type !== undefined && same(parent.type, 'Slice')) return { to: 'State', why: `its parent #${parent.number} is a Slice` };
  if (subIssues > 0) return { to: 'Work item', why: `it has ${subIssues} sub-issue${subIssues === 1 ? '' : 's'}` };
  return { to: 'Brief', why: parent ? `its parent #${parent.number} is neither a Work item nor a Slice, and it has no sub-issues` : 'it has no parent and no sub-issues' };
}

/** A read GitHub refused, with the HTTP status it answered. */
export class Refused extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Every entry a REST list holds, reading 100 a page; none, when `gone` and GitHub answers 410 Gone. */
export async function pages(sys: Sys, token: string, url: string, gone = false): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (let page = 1; ; page++) {
    const pageUrl = `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
    const { status, json } = await sys.http(pageUrl, { token });
    if (gone && status === 410) return entries;
    if (status !== 200 || !Array.isArray(json)) throw new Refused(`cannot read ${url} (HTTP ${status})`, status);
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

/** A listed issue as a Holder, without its repository's archived flag; undefined for a pull request or a row it cannot read. */
function asHolder(repo: string, row: unknown, from: string): Omit<Holder, 'archived'> | undefined {
  const issue = row as { number?: unknown; url?: unknown; pull_request?: unknown; parent_issue_url?: unknown; sub_issues_summary?: { total?: unknown } };
  if (issue.pull_request || typeof issue.number !== 'number' || typeof issue.url !== 'string') return undefined;
  return {
    repo,
    number: issue.number,
    url: issue.url,
    from,
    parent: typeof issue.parent_issue_url === 'string' ? issue.parent_issue_url : null,
    subIssues: typeof issue.sub_issues_summary?.total === 'number' ? issue.sub_issues_summary.total : 0,
  };
}

/**
 * The issues in a repository that hold the type, open and closed; pull
 * requests have no type. Undefined for a `disabled` type GitHub will not
 * list issues by: it answers 422 Validation Failed to a filter naming a
 * disabled type, which says nothing of whether an issue holds it. For an
 * enabled type a 422 stays a failure.
 */
async function holding(sys: Sys, token: string, repo: string, type: string, disabled = false): Promise<Omit<Holder, 'archived'>[] | undefined> {
  let rows: unknown[];
  try {
    // GitHub answers 410 Gone for a repository with issues turned off, a fork's usual setting: it holds none to retype.
    rows = await pages(sys, token, `${API}/repos/${repo}/issues?type=${encodeURIComponent(type)}&state=all`, true);
  } catch (error) {
    if (disabled && error instanceof Refused && error.status === 422) return undefined;
    throw error;
  }
  return rows.flatMap((row) => {
    const name = (row as { type?: { name?: unknown } | null } | null)?.type?.name;
    // Only an issue GitHub shows holding the type, so a filter GitHub ignored retypes nothing.
    const holder = typeof name === 'string' && same(name, type) ? asHolder(repo, row, name) : undefined;
    return holder ? [holder] : [];
  });
}

/** The open issues in a repository with no type; closed ones are left as they are. */
async function untyped(sys: Sys, token: string, repo: string): Promise<Omit<Holder, 'archived'>[]> {
  const rows = await pages(sys, token, `${API}/repos/${repo}/issues?type=none&state=open`, true);
  return rows.flatMap((row) => {
    // Only an issue GitHub shows with no type, so a filter GitHub ignored types nothing it should not.
    const holder = (row as { type?: unknown } | null)?.type == null ? asHolder(repo, row, NO_TYPE) : undefined;
    return holder ? [holder] : [];
  });
}

/**
 * The Approvals issue a repository's settings name on its default branch,
 * under either name; undefined where it has none or names none. It stays
 * with no type: a standing record the owner answers batches on, never
 * closed, which no work model type fits.
 */
async function approvalsOf(sys: Sys, token: string, repo: string): Promise<number | undefined> {
  for (const path of [SETTINGS_PATH, OLD_SETTINGS_PATH]) {
    const { status, json } = await sys.http(`${API}/repos/${repo}/contents/${path}`, { token });
    if (status === 404) continue;
    const content = (json as { content?: unknown } | null)?.content;
    if (status !== 200 || typeof content !== 'string') throw new Error(`cannot read ${path} in ${repo} (HTTP ${status})`);
    try {
      const approvals = (JSON.parse(Buffer.from(content, 'base64').toString('utf8')) as { approvals?: unknown } | null)?.approvals;
      return typeof approvals === 'number' && Number.isInteger(approvals) && approvals > 0 ? approvals : undefined;
    } catch {
      // Settings that do not parse name no Approvals issue; onboard in that repository says what is wrong with them.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Works out, changing nothing, what makes the organisation's enabled issue
 * types exactly the work model's, and gives each open issue a type. Types are
 * the organisation's, so it reads every repository the token can see,
 * onboarded or not. Each issue holding another type, and each open issue with
 * none, gets one from GitHub's facts about it (see typeFor), but a
 * repository's Approvals issue, which stays with no type.
 */
export async function typesPlan(sys: Sys, token: string, org: string): Promise<TypesPlan> {
  const types = await orgTypes(sys, token, org);
  const add = ISSUE_TYPES.filter((type) => !types.some((had) => same(had.name, type.name)));
  const enable = types.filter((type) => inModel(type.name) && !type.is_enabled);
  // Disabled ones too, so a rerun finds an issue a type left behind when someone disabled it by hand, where GitHub
  // lists them; it refuses to filter by a disabled type (422), and such a type is unlisted, not read as held by none.
  const others = types.filter((type) => !inModel(type.name));
  const unlisted = new Set<string>();
  const holders: Holder[] = [];
  const exempt: { repo: string; number: number }[] = [];
  const repos = (await pages(sys, token, `${API}/orgs/${org}/repos?type=all`)).flatMap((entry) => {
    const repo = entry as { full_name?: unknown; archived?: unknown; has_issues?: unknown };
    // A repository with issues turned off has none GitHub would list.
    return typeof repo.full_name === 'string' && repo.has_issues !== false ? [{ slug: repo.full_name, archived: repo.archived === true }] : [];
  });
  for (const repo of repos) {
    for (const type of others) {
      // GitHub's refusal is the type's, not the repository's, so an unlisted type is not asked of the others.
      if (unlisted.has(type.name)) continue;
      const found = await holding(sys, token, repo.slug, type.name, !type.is_enabled);
      if (found === undefined) unlisted.add(type.name);
      else holders.push(...found.map((issue) => ({ ...issue, archived: repo.archived })));
    }
    const bare = await untyped(sys, token, repo.slug);
    const approvals = bare.length > 0 ? await approvalsOf(sys, token, repo.slug) : undefined;
    for (const found of bare) {
      if (found.number === approvals) exempt.push({ repo: repo.slug, number: found.number });
      else holders.push({ ...found, archived: repo.archived });
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
    const parent = holder.parent ? { number: holder.parent.split('/').at(-1) as string, type: await typeAt(holder.parent) } : undefined;
    const retype: Retype = { repo: holder.repo, number: holder.number, from: holder.from, ...typeFor(parent, holder.subIssues) };
    decided.set(holder.url, retype);
    return retype;
  };
  const retype: Retype[] = [];
  const held: Retype[] = [];
  for (const holder of holders) (holder.archived ? held : retype).push(await decide(holder));
  const extra = others.filter((type) => type.is_enabled);
  const kept = extra.filter((type) => held.some((issue) => same(issue.from, type.name)));
  return {
    org,
    others: others.map((type) => type.name),
    unlisted: others.filter((type) => unlisted.has(type.name)).map((type) => type.name),
    add,
    enable,
    retype,
    held,
    disable: extra.filter((type) => !kept.includes(type)),
    kept,
    late: [],
    exempt,
  };
}

/**
 * The plan read again at the run, cut to what the owner approved: an issue
 * the approved plan did not retype as now is left, and so is the type it
 * holds, so nothing is changed that the owner did not see.
 */
export function withinApproved(fresh: TypesPlan, approved: TypesPlan): TypesPlan {
  const seen = (issue: Retype): boolean => approved.retype.some((had) => had.repo === issue.repo && had.number === issue.number && had.to === issue.to);
  const late = fresh.retype.filter((issue) => !seen(issue));
  const disable = fresh.disable.filter((type) => approved.disable.some((had) => had.id === type.id) && !late.some((issue) => same(issue.from, type.name)));
  return { ...fresh, retype: fresh.retype.filter(seen), disable, kept: [...fresh.kept, ...fresh.disable.filter((type) => !disable.includes(type))], late };
}

/** Whether the plan changes anything. */
export function typesChange(plan: TypesPlan): boolean {
  return plan.add.length + plan.enable.length + plan.retype.length + plan.disable.length > 0;
}

const names = (types: { name: string }[]): string => types.map((type) => type.name).join(', ');
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const where = (issue: { repo: string; number: number }): string => `${issue.repo.split('/').at(-1)}#${issue.number}`;
const isBare = (issue: Retype): boolean => issue.from === NO_TYPE;

/** The plan in a few words, for onboard's plan; typesLines names what it counts. */
export function typesDetail(plan: TypesPlan): string {
  const parts = [
    ...(plan.add.length > 0 ? [`add ${plan.add.length}`] : []),
    ...(plan.enable.length > 0 ? [`enable ${plan.enable.length}`] : []),
    ...(plan.retype.some((issue) => !isBare(issue)) ? [`retype ${plan.retype.filter((issue) => !isBare(issue)).length}`] : []),
    ...(plan.retype.some(isBare) ? [`type ${plan.retype.filter(isBare).length}`] : []),
    ...(plan.disable.length > 0 ? [`disable ${plan.disable.length}`] : []),
    ...(plan.kept.length > 0 ? [`keep ${plan.kept.length}`] : []),
  ];
  return parts.length > 0 ? `org-wide: ${parts.join(', ')}` : 'org-wide, the work model’s alone';
}

/** How many retyped issues onboard's question names; the plan shows every one. */
const NAMED = 10;

/**
 * The plan's rows for the issues it types, every one, in repository and
 * number order: a run of consecutive issues in one repository that the same
 * rule gives the same type, from the same one, is one row.
 */
function issueRows(retype: Retype[]): { label: string; detail: string }[] {
  const sorted = [...retype].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  const runs: { first: Retype; last: Retype }[] = [];
  for (const issue of sorted) {
    const run = runs.at(-1);
    const joins = run && run.last.repo === issue.repo && run.last.number + 1 === issue.number && run.last.from === issue.from && run.last.to === issue.to && run.last.why === issue.why;
    if (joins) run.last = issue;
    else runs.push({ first: issue, last: issue });
  }
  return runs.map(({ first, last }) => ({
    label: `  ${where(first)}${last === first ? '' : `–#${last.number}`}`,
    detail: `${first.from} → ${first.to}${isBare(first) ? `: ${first.why}` : ''}`,
  }));
}

/** Why onboard says nothing of the issues holding a disabled type. */
const UNLISTED = 'GitHub lists no issues by a disabled type, so onboard cannot tell whether any holds one';

/** What typesDetail counts, one line each, after the plan's issue types line, in the order the run does it. */
export function typesLines(plan: TypesPlan): { label: string; detail: string }[] {
  return [
    ...(plan.add.length > 0 ? [{ label: '  add', detail: names(plan.add) }] : []),
    ...(plan.enable.length > 0 ? [{ label: '  enable', detail: names(plan.enable) }] : []),
    ...issueRows(plan.retype),
    ...plan.exempt.map((issue) => ({ label: `  ${where(issue)}`, detail: 'keeps no type: its repository’s Approvals issue, a standing record no work model type fits' })),
    ...(plan.retype.some(isBare) || plan.exempt.length > 0 ? [{ label: '  closed, no type', detail: 'left as they are' }] : []),
    ...(plan.disable.length > 0 ? [{ label: '  disable', detail: names(plan.disable) }] : []),
    ...(plan.kept.length > 0 ? [{ label: '  keep', detail: `${names(plan.kept)}: archived repos hold them` }] : []),
    ...(plan.unlisted.length > 0 ? [{ label: '  disabled', detail: `${plan.unlisted.join(', ')}: ${UNLISTED}` }] : []),
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
          `give ${[
            ...(plan.retype.some((issue) => !isBare(issue)) ? [`${plural(plan.retype.filter((issue) => !isBare(issue)).length, 'issue')} holding another type`] : []),
            ...(plan.retype.some(isBare) ? [`${plural(plan.retype.filter(isBare).length, 'open issue')} with no type`] : []),
          ].join(' and ')} a work model type (${[
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
    io.out(isBare(issue) ? `✓ typed ${issue.repo}#${issue.number} a ${issue.to}: ${issue.why}` : `✓ retyped ${issue.repo}#${issue.number} ${issue.from} → ${issue.to}: ${issue.why}`);
  }
  for (const type of plan.disable) await putType(sys, token, org, type, false);
  if (plan.disable.length > 0) {
    io.out(`✓ disabled the issue types ${names(plan.disable)} in ${org}, outside the work model, once no issue held them; not deleted, so they can be enabled again`);
  }
  for (const issue of plan.held) io.out(`- ${issue.repo}#${issue.number} keeps ${issue.from}: ${issue.repo} is archived, which GitHub keeps read-only`);
  for (const issue of plan.late) io.out(`- ${issue.repo}#${issue.number} keeps ${issue.from}: onboard found it after showing its plan`);
  for (const issue of plan.exempt) io.out(`- ${issue.repo}#${issue.number} keeps no type: it is the Approvals issue its repository's settings name`);
  if (plan.unlisted.length > 0) {
    io.out(`- ${plan.unlisted.join(', ')} stay disabled in ${org}; ${UNLISTED}: enabled again, onboard retypes them`);
  }
  if (plan.kept.length > 0) io.out(`- left ${names(plan.kept)} enabled in ${org}, since an issue onboard did not retype holds ${plan.kept.length === 1 ? 'it' : 'them'}`);
  io.out(`✓ issue types in ${org}: ${names(ISSUE_TYPES)}`);
  const archived = [...new Set(plan.held.map((issue) => issue.repo))];
  return [
    ...(archived.length > 0 ? [`issue types: unarchive ${archived.join(', ')}, then niyam onboard again, to retype ${plan.held.map((issue) => `${issue.repo}#${issue.number}`).join(', ')}`] : []),
    ...(plan.late.length > 0 ? [`issue types: niyam onboard again, to retype ${plan.late.map((issue) => `${issue.repo}#${issue.number}`).join(', ')}, found after the plan`] : []),
  ];
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
export const RERUN = 'the owner reruns niyam onboard, which gives those issues work model types and disables the other types';

/**
 * doctor's check that the organisation's enabled issue types are the work
 * model's, that no issue in this repository holds another, and that every
 * open one here has a type, but the Approvals issue `approvals` names.
 */
export async function typesDrift(sys: Sys, token: string, org: string, slug: string, approvals?: number): Promise<Finding> {
  const types = await orgTypes(sys, token, org);
  const missing = ISSUE_TYPES.filter((type) => !types.some((had) => same(had.name, type.name) && had.is_enabled));
  const extra = types.filter((type) => !inModel(type.name) && type.is_enabled);
  const here: string[] = [];
  for (const type of extra) here.push(...((await holding(sys, token, slug, type.name)) ?? []).map((issue) => `#${issue.number} ${issue.from}`));
  const bare = (await untyped(sys, token, slug)).filter((issue) => issue.number !== approvals).map((issue) => `#${issue.number}`);
  if (missing.length === 0 && extra.length === 0 && bare.length === 0) return { mark: '✓', text: `issue types in ${org}: the work model’s alone, and every open issue here has one` };
  const parts = [
    ...(missing.length > 0 ? [`${org} lacks the work model's ${names(missing)}`] : []),
    ...(extra.length > 0 ? [`${org} has issue types outside the work model: ${names(extra)}`] : []),
    ...(here.length > 0 ? [`${plural(here.length, 'issue')} here hold${here.length === 1 ? 's' : ''} one (${here.join(', ')})`] : []),
    ...(bare.length > 0 ? [`${plural(bare.length, 'open issue')} here ha${bare.length === 1 ? 's' : 've'} no type (${bare.join(', ')})`] : []),
  ];
  return { mark: '▲', text: parts.join('; '), fix: RERUN };
}

interface IssueEvent {
  action?: string;
  schedule?: string;
  issue?: { number?: number };
  repository?: { owner?: { type?: string } };
}

/** The type of the issue at `url`, as GitHub shows it now; undefined for none. */
async function typeOf(sys: Sys, token: string, url: string, number: number): Promise<string | undefined> {
  const above = await sys.http(url, { token });
  if (above.status !== 200) throw new Error(`cannot read the parent of #${number} (HTTP ${above.status})`);
  const type = (above.json as { type?: { name?: unknown } | null } | null)?.type?.name;
  return typeof type === 'string' ? type : undefined;
}

/** Sets an issue's type, checking GitHub's answer; returns the line saying so. */
async function setType(sys: Sys, token: string, url: string, number: number, { to, why }: { to: string; why: string }): Promise<string> {
  const { status, json } = await sys.http(url, { method: 'PATCH', token, body: { type: to } });
  const now = (json as { type?: { name?: unknown } | null } | null)?.type?.name;
  if (status !== 200 || typeof now !== 'string' || !same(now, to)) {
    // GitHub refuses a type the organisation lacks or has disabled, and drops one silently where the token may not set it.
    throw new Error(`GitHub did not make #${number} a ${to} (HTTP ${status}); the owner runs niyam onboard, which adds and enables the work model's issue types`);
  }
  return `issue-type: #${number} had no type; now a ${to}: ${why}`;
}

/**
 * The type each of `issues` gets, decided before any is set: a parent among
 * them is read as the type it gets, as in typesPlan, so a child is not made
 * a Brief for want of a type its parent is about to get.
 */
async function decideAll(sys: Sys, token: string, issues: Omit<Holder, 'archived'>[]): Promise<Map<string, { to: string; why: string }>> {
  const byUrl = new Map(issues.map((issue) => [issue.url, issue]));
  const decided = new Map<string, { to: string; why: string }>();
  const decide = async (issue: Omit<Holder, 'archived'>): Promise<{ to: string; why: string }> => {
    const known = decided.get(issue.url);
    if (known) return known;
    const above = issue.parent ? byUrl.get(issue.parent) : undefined;
    const parentType = issue.parent ? (above ? (await decide(above)).to : await typeOf(sys, token, issue.parent, issue.number)) : undefined;
    const type = typeFor(issue.parent ? { number: issue.parent.split('/').at(-1) as string, type: parentType } : undefined, issue.subIssues);
    decided.set(issue.url, type);
    return type;
  };
  for (const issue of issues) await decide(issue);
  return decided;
}

/**
 * The issue-type job, run by the shared workflow. When an issue is opened or
 * reopened, an issue with no type gets the work model's by the rule onboard
 * applies (see typeFor), read from GitHub when the job runs, so a parent set
 * as the issue was made counts. GitHub starts no run for an issue a
 * workflow's own token opens, such as a monthly reminder, so the hourly
 * sweep types every open issue here with none. An issue with a type, and the
 * Approvals issue the settings name, are left as they are.
 */
export async function issueType(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!name || !eventPath || !slug || !token) {
    throw new Error('issue-type runs in GitHub Actions: GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GH_TOKEN must be set');
  }
  const notAdopted = notAdoptedLine(sys, sys.cwd, 'issue-type');
  if (notAdopted) {
    io.out(notAdopted);
    return 0;
  }
  if (!isOn(sys, sys.cwd, 'board')) {
    io.out(offLine('issue-type', 'board', `in ${settingsPathIn(sys, sys.cwd)}`));
    return 0;
  }
  const event = JSON.parse(sys.read(eventPath)) as IssueEvent;
  const { approvals } = loadSettings(sys, sys.cwd);
  if (name === 'schedule' && event.schedule === HOURLY) {
    if (!(await isOrganisation(sys, slug.split('/')[0] as string))) {
      io.out('issue-type: GitHub has issue types for organisations only; nothing to do');
      return 0;
    }
    const bare = (await untyped(sys, token, slug)).filter((issue) => issue.number !== approvals);
    const types = await decideAll(sys, token, bare);
    for (const issue of bare) io.out(await setType(sys, token, issue.url, issue.number, types.get(issue.url) as { to: string; why: string }));
    io.out(`issue-type: ${plural(bare.length, 'open issue')} with no type typed`);
    return 0;
  }
  const number = event.issue?.number;
  if (name !== 'issues' || (event.action !== 'opened' && event.action !== 'reopened') || typeof number !== 'number') {
    io.out(`issue-type: nothing to do on a ${name} event${event.action ? ` (${event.action})` : ''}`);
    return 0;
  }
  if (event.repository?.owner?.type !== 'Organization') {
    io.out(`issue-type: GitHub has issue types for organisations only; #${number} is left as it is`);
    return 0;
  }
  if (approvals === number) {
    io.out(`issue-type: #${number} is the Approvals issue, which keeps no type`);
    return 0;
  }
  const url = `${API}/repos/${slug}/issues/${number}`;
  const read = await sys.http(url, { token });
  if (read.status !== 200) throw new Error(`cannot read #${number} (HTTP ${read.status})`);
  const issue = read.json as { state?: unknown; type?: { name?: unknown } | null; pull_request?: unknown; parent_issue_url?: unknown; sub_issues_summary?: { total?: unknown } } | null;
  if (issue?.pull_request) {
    io.out(`issue-type: #${number} is a pull request, which has no type`);
    return 0;
  }
  // Closed since the event, as a queued run may find it: a closed issue with no type is left as it is.
  if (issue?.state !== 'open') {
    io.out(`issue-type: #${number} is not open; left as it is`);
    return 0;
  }
  if (typeof issue?.type?.name === 'string') {
    io.out(`issue-type: #${number} is a ${issue.type.name} already; nothing to do`);
    return 0;
  }
  const parentUrl = typeof issue?.parent_issue_url === 'string' ? issue.parent_issue_url : undefined;
  const parent = parentUrl ? { number: parentUrl.split('/').at(-1) as string, type: await typeOf(sys, token, parentUrl, number) } : undefined;
  const subIssues = issue?.sub_issues_summary?.total;
  io.out(await setType(sys, token, url, number, typeFor(parent, typeof subIssues === 'number' ? subIssues : 0)));
  return 0;
}
