import { API } from './agent.ts';
import { restList } from './pages.ts';
import type { Sys } from './types.ts';

/**
 * A hand-off brief: what a session that tripped over a problem it did not cause writes for the session that will
 * fix it. Its fields ride in a fenced `yaml brief` block at the top of a Brief issue, and its five sections follow.
 * The structure is the point: a handoff in this shape (I-PASS) cut medical errors by a quarter without being longer.
 */

/** The issue type a brief is opened as. */
export const BRIEF_TYPE = 'Brief';
/** The info string of the fields block, so it is never mistaken for evidence. */
export const FIELDS_FENCE = '```yaml brief';
/** Fields the issue's own state replaces: open, closed as completed (resolved), or closed as not planned (rejected). */
export const STATE_KEYS = ['status', 'resolved-by', 'resolution-note'] as const;

/** The sections every brief answers, in I-PASS order. */
export const SECTIONS = [
  '## What happened',
  '## Why this is not caused by the originating branch',
  '## Hypothesis (UNVERIFIED)',
  '## What the receiving session must verify first',
  '## Sequencing',
] as const;
/** What a session that carries the fix itself owes on top. */
export const CARRYING_SECTIONS = ['## What I verified', '## Why I did not hand off'] as const;
/** The section that must hold pasted evidence, not a description of it. */
export const EVIDENCE_SECTION = '## What happened';
export const STATUSES = ['open', 'resolved', 'rejected'] as const;

/** Reads YAML text into values. */
export type Yaml = (text: string) => unknown;

/** The YAML reader, loaded only when a brief is read: the shared checks run the CLI from its source with no packages installed. */
export async function loadYaml(): Promise<Yaml> {
  const { parse } = await import('yaml');
  return (text) => parse(text, { schema: 'core' }) as unknown;
}

/** A path as `git diff --name-only` spells it, or null for one outside the repository. */
export function repoPath(path: string): string | null {
  const normalised = path.trim().replace(/\\/g, '/');
  if (normalised.startsWith('/')) return null;
  const out: string[] = [];
  for (const segment of normalised.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.length === 0 ? null : out.join('/');
}

/** A commit id, not a ref: a ref is an ancestor of itself, so it would release a blocker with no fix. */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

/** The frontmatter between the first two `---` lines, and the body after; null without one. */
export function splitFrontmatter(markdown: string): { frontmatter: string; body: string } | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  return { frontmatter: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

/** The body's `## ` sections by heading; a heading inside a fence is captured output, not a section. */
export function splitSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let buffer: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (heading !== null) sections.set(heading, buffer.join('\n').trim());
  };
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const [, run = '', rest = ''] = marker;
      // A backtick fence's info string holds no backtick: ```x``` is an inline span, not a fence.
      if (fence === null) {
        if (run[0] === '~' || !rest.includes('`')) fence = run;
      } else if (run[0] === fence[0] && run.length >= fence.length && /^\s*$/.test(rest)) fence = null;
    }
    if (fence === null && /^##\s+\S/.test(line)) {
      flush();
      heading = line.trim().replace(/\s+/g, ' ');
      buffer = [];
      continue;
    }
    if (heading !== null) buffer.push(line);
  }
  flush();
  return sections;
}

export interface BriefFields {
  slug: string;
  title: string;
  discoveredOn: string;
  blocking: boolean;
  status: string;
  resolvedBy: string;
  resolutionNote: string;
  blamedPaths: string[];
}

/**
 * The frontmatter's values as text, read as YAML 1.2 core, so `blocking: no` stays "no" and a date stays as
 * written; the keys whose value is a mapping, which is no answer; null for text that is not a YAML mapping.
 */
export function readFrontmatter(frontmatter: string, yaml: Yaml): { fields: Record<string, string | string[]>; nonScalar: string[] } | null {
  let parsed: unknown;
  try {
    parsed = yaml(frontmatter);
  } catch {
    return null;
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const flat = (value: unknown): string | null => (value === null || value === undefined ? '' : typeof value === 'object' ? null : String(value).trim());
  const fields: Record<string, string | string[]> = {};
  const nonScalar: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      const items = value.map(flat);
      if (items.includes(null)) nonScalar.push(key);
      else fields[key] = (items as string[]).filter(Boolean);
      continue;
    }
    const one = flat(value);
    if (one === null) nonScalar.push(key);
    else fields[key] = one;
  }
  return { fields, nonScalar };
}

const scalar = (value: string | string[] | undefined): string => (typeof value === 'string' ? value : '');
const list = (value: string | string[] | undefined): string[] => (Array.isArray(value) ? value : value ? [value] : []);

export interface LintContext {
  /** Reads the frontmatter, YAML 1.2 core; from loadYaml. */
  yaml: Yaml;
  /** Whether the path is in the tree being pushed. */
  pathExists(path: string): boolean;
  /** Whether a resolved brief's missing path was removed by its fix or after it, in this history. */
  pathDeletedSince(sha: string, path: string): boolean;
  /** The branch's own changes, `git diff --name-only <base>...HEAD`. */
  changedFiles: readonly string[];
  /** Only a session carrying the fix itself may blame a file it changed. */
  disposition?: 'handed-off' | 'carrying';
  /** Where the brief template is, for the message when there is no frontmatter. */
  template?: string;
}

export interface LintResult {
  ok: boolean;
  problems: string[];
  fields: BriefFields | null;
}

/**
 * Whether `sha` or a commit after it removed a path: it was there at `sha` or its parent, and `sha` is in this
 * history. A path that was never there, or went on another line of history, is refused.
 */
export function deletedSince(probe: { existsAt(rev: string, path: string): boolean; isAncestor(sha: string): boolean }, sha: string, path: string): boolean {
  return (probe.existsAt(sha, path) || probe.existsAt(`${sha}^`, path)) && probe.isAncestor(sha);
}

/**
 * Checks a brief's shape, and the one check that can be held against the repository: a brief names the files it
 * blames, and none may be in the branch's own diff, unless the session carries the fix itself. It cannot judge
 * whether a brief is good; it refuses an empty one.
 */
export function lintBrief(markdown: string, context: LintContext): LintResult {
  const split = splitFrontmatter(markdown);
  if (split === null) return { ok: false, problems: [`no YAML frontmatter${context.template ? `; start the file from ${context.template}` : ''}`], fields: null };
  const read = readFrontmatter(split.frontmatter, context.yaml);
  if (read === null) return { ok: false, problems: ['frontmatter is not valid YAML'], fields: null };
  if (read.nonScalar.length) {
    return { ok: false, problems: read.nonScalar.map((key) => `frontmatter \`${key}\` is a mapping, not a value; write it as text (or, for blamed-paths, a list of text)`), fields: null };
  }
  const raw = read.fields;
  const fields: BriefFields = {
    slug: scalar(raw.slug),
    title: scalar(raw.title),
    discoveredOn: scalar(raw['discovered-on']),
    blocking: /^(yes|true)$/i.test(scalar(raw.blocking)),
    status: scalar(raw.status),
    resolvedBy: scalar(raw['resolved-by']),
    resolutionNote: scalar(raw['resolution-note']),
    blamedPaths: list(raw['blamed-paths']),
  };
  const problems: string[] = [];
  for (const [key, value] of [['slug', fields.slug], ['title', fields.title], ['discovered-on', fields.discoveredOn]] as const) {
    if (!value) problems.push(`frontmatter \`${key}\` is empty`);
  }
  const blocking = scalar(raw.blocking);
  if (!/^(yes|no|true|false)$/i.test(blocking)) problems.push(`frontmatter \`blocking\` must be yes or no (got "${blocking}"): an unreadable value would quietly downgrade a blocker`);
  if (!(STATUSES as readonly string[]).includes(fields.status)) problems.push(`frontmatter \`status\` must be one of ${STATUSES.join(', ')} (got "${fields.status}")`);
  if (fields.status === 'resolved' && !fields.resolvedBy) problems.push('`status: resolved` needs a `resolved-by:` commit id');
  else if (fields.status === 'resolved' && !isCommitSha(fields.resolvedBy)) {
    problems.push(`\`resolved-by: ${fields.resolvedBy}\` is a ref, not a commit id: a ref is an ancestor of itself, so it would release this handoff without a fix`);
  }
  if (fields.status === 'rejected' && !fields.resolutionNote) problems.push('`status: rejected` needs a `resolution-note:` saying why');
  if (fields.blamedPaths.length === 0) problems.push('`blamed-paths` is empty: a handoff names the files it holds responsible');
  const changed = new Set(context.changedFiles.map(repoPath).filter((file): file is string => file !== null));
  for (const path of fields.blamedPaths) {
    const canonical = repoPath(path);
    if (canonical === null) {
      problems.push(`blamed path is not a path inside this repository: ${path}; name the file as git does`);
      continue;
    }
    // An open brief blames a path that is there; a resolved one outlives files its fix may have deleted.
    if (!context.pathExists(canonical) && fields.status !== 'rejected') {
      if (fields.status !== 'resolved' || !isCommitSha(fields.resolvedBy)) problems.push(`blamed path does not exist in this tree: ${canonical}`);
      else if (!context.pathDeletedSince(fields.resolvedBy, canonical)) {
        problems.push(`blamed path does not exist in this tree: ${canonical}, and ${fields.resolvedBy.slice(0, 7)} or a later commit in this history did not remove it`);
      }
    }
    if (changed.has(canonical) && context.disposition !== 'carrying') {
      problems.push(`blamed path is in this branch's own diff: ${canonical}; a file you changed cannot be handed off: revert the edit, or record --disposition carrying`);
    }
  }
  const sections = splitSections(split.body);
  for (const heading of [...SECTIONS, ...(context.disposition === 'carrying' ? CARRYING_SECTIONS : [])]) {
    const body = sections.get(heading);
    if (body === undefined) problems.push(`missing section: ${heading}`);
    else if (!body) problems.push(`section is empty: ${heading}`);
  }
  const evidence = sections.get(EVIDENCE_SECTION);
  // A fence of either marker, in a blockquote too, is evidence; an inline ```x``` span is not.
  const fenced = evidence?.split('\n').some((line) => {
    const open = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    return open !== null && !(open[1]?.[0] === '`' && open[2]?.includes('`'));
  });
  if (evidence && !fenced) problems.push(`${EVIDENCE_SECTION} holds no fenced evidence: paste the command and its output, not a description of it`);
  return { ok: problems.length === 0, problems, fields };
}

/** A brief draft as an issue's title and body: the fields in the fenced block, without the state keys or comments. */
export function briefToIssue(markdown: string, title: string): { title: string; body: string } {
  const split = splitFrontmatter(markdown) ?? { frontmatter: '', body: markdown };
  const state = new RegExp(`^(?:${STATE_KEYS.join('|')}):`);
  const fields = split.frontmatter
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#') && !state.test(line))
    .join('\n');
  return { title, body: `${FIELDS_FENCE}\n${fields}\n\`\`\`\n${split.body}` };
}

/** An issue body back into a brief, `status: open`, so one lint judges both; null for a body not opened as one. */
export function issueToBrief(body: string): string | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== FIELDS_FENCE) return null;
  const end = lines.indexOf('```', 1);
  if (end === -1) return null;
  return ['---', ...lines.slice(1, end), 'status: open', '---', ...lines.slice(end + 1)].join('\n');
}

/** Whether pull request text closes issue `number` by GitHub's keywords; only the bare `#N`, as `owner/repo#N` may be elsewhere. */
export function saysFixes(text: string, number: number): boolean {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+#${number}\\b`, 'i').test(text);
}

/** A Brief issue as the gate reads it. */
export interface BriefIssue {
  number: number;
  state: 'OPEN' | 'CLOSED';
  /** completed, not_planned, duplicate, reopened, or null. */
  stateReason: string | null;
  type: string | null;
  body: string;
  /** The merge commit of the pull request that closed it saying "Fixes #N"; null for any other close. */
  closingSha: string | null;
}

export type BriefReason = 'brief-unreadable' | 'brief-not-brief' | 'brief-other-branch' | 'brief-invalid' | 'handoff-not-landed';
export type BriefVerdict = { ok: true } | { ok: false; reason: BriefReason; detail: string };

/**
 * The gate's judgement of one declared Brief issue: it is there, it is a brief, this branch found it, it lints,
 * and a blocking one handed off has landed: closed as not planned, or by a merged pull request saying "Fixes #N"
 * whose merge commit is in this history. Until then the line stays stopped.
 */
export function judgeBrief(
  ref: string,
  issue: BriefIssue | null,
  context: { branch: string; disposition: 'handed-off' | 'carrying'; lint: Omit<LintContext, 'disposition'>; isAncestorOfHead(sha: string): boolean },
): BriefVerdict {
  if (issue === null) return { ok: false, reason: 'brief-unreadable', detail: `declared brief ${ref} could not be read from GitHub; check the number, and that this session works as the agent` };
  if (issue.type !== BRIEF_TYPE) return { ok: false, reason: 'brief-not-brief', detail: `${ref} is not a Brief issue (type: ${issue.type ?? 'none'}); open one with niyam brief <draft.md>` };
  const markdown = issueToBrief(issue.body);
  if (markdown === null) return { ok: false, reason: 'brief-not-brief', detail: `${ref} has no fields block at the top of its body; open briefs with niyam brief <draft.md>, never by hand` };
  // A closed brief's blamed paths may be gone; its fields must still read, or a hand close could release `blocking: maybe`.
  const lint = lintBrief(markdown, { ...context.lint, ...(issue.state === 'OPEN' ? {} : { pathExists: () => true }), disposition: context.disposition });
  if (!lint.ok || lint.fields === null) return { ok: false, reason: 'brief-invalid', detail: `${ref}: ${lint.problems.join('; ')}` };
  if (lint.fields.discoveredOn !== context.branch) {
    return { ok: false, reason: 'brief-other-branch', detail: `${ref} was discovered on "${lint.fields.discoveredOn}", not this branch "${context.branch}"; an older brief cannot answer for this push, so open one here` };
  }
  if (context.disposition !== 'handed-off' || !lint.fields.blocking) return { ok: true };
  if (issue.state === 'OPEN') {
    return { ok: false, reason: 'handoff-not-landed', detail: `${ref} is blocking and still open: the push waits until a pull request saying "Fixes ${ref}" merges and you merge it in, or the issue is closed as not planned` };
  }
  if (issue.stateReason === 'not_planned') return { ok: true };
  const sha = issue.closingSha;
  if (sha === null || !isCommitSha(sha)) {
    return { ok: false, reason: 'handoff-not-landed', detail: `${ref} was closed (${issue.stateReason ?? 'no reason'}) by no merged pull request saying "Fixes ${ref}"; reopen it and let the fixing pull request close it, or close it as not planned` };
  }
  if (!context.isAncestorOfHead(sha)) return { ok: false, reason: 'handoff-not-landed', detail: `${ref} was closed by ${sha.slice(0, 7)}, which is not in this branch's history; merge it in before pushing` };
  return { ok: true };
}

/** A draft's lint, and what the gate asks of the issue later: it opens open, on this branch. */
export function lintDraft(markdown: string, branch: string, context: LintContext): { ok: true; draft: { title: string; body: string } } | { ok: false; problems: string[] } {
  const lint = lintBrief(markdown, context);
  if (lint.fields === null) return { ok: false, problems: lint.problems };
  const problems = [...lint.problems];
  if (lint.fields.status !== 'open') problems.push('a new brief is `status: open`');
  if (lint.fields.discoveredOn !== branch) problems.push(`\`discovered-on: ${lint.fields.discoveredOn}\` must be this branch, ${branch}`);
  return problems.length ? { ok: false, problems } : { ok: true, draft: briefToIssue(markdown, lint.fields.title) };
}

async function rest(sys: Sys, token: string, url: string, what: string, options: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const { status, json } = await sys.http(url, { token, ...options });
  if (status < 200 || status >= 300) {
    const message = (json as { message?: unknown } | null)?.message;
    throw new Error(`GitHub refused to ${what} (HTTP ${status}${typeof message === 'string' ? `: ${message}` : ''})`);
  }
  return json;
}

/** Opens the draft as a Brief issue, over REST, which takes the type by name. */
export async function openBrief(sys: Sys, token: string, slug: string, draft: { title: string; body: string }): Promise<{ number: number; id: number; url: string }> {
  const opened = (await rest(sys, token, `${API}/repos/${slug}/issues`, 'open the Brief issue', { method: 'POST', body: { ...draft, type: BRIEF_TYPE } })) as { number?: unknown; id?: unknown; html_url?: unknown } | null;
  if (typeof opened?.number !== 'number' || typeof opened.id !== 'number' || typeof opened.html_url !== 'string') throw new Error('GitHub opened the Brief issue but did not say which');
  return { number: opened.number, id: opened.id, url: opened.html_url };
}

/** Adds the issue to the owner's open Project titled `title`, over REST, which a cloud session's proxy answers. */
export async function addToProject(sys: Sys, token: string, slug: string, issueId: number, title: string): Promise<void> {
  const repo = (await rest(sys, token, `${API}/repos/${slug}`, `read ${slug}`)) as { owner?: { login?: string; type?: string } } | null;
  const owner = repo?.owner?.login ?? (slug.split('/')[0] as string);
  const base = `${API}/${repo?.owner?.type === 'User' ? 'users' : 'orgs'}/${owner}/projectsV2`;
  for (let page = 1; ; page++) {
    const projects = (await rest(sys, token, `${base}?per_page=100&page=${page}`, `list ${owner}'s Projects`)) as { number: number; title: string; state?: string; closed_at?: string | null }[];
    if (!Array.isArray(projects)) throw new Error(`GitHub did not list ${owner}'s Projects`);
    const project = projects.find((one) => one.title === title && one.state !== 'closed' && !one.closed_at);
    if (project) {
      await rest(sys, token, `${base}/${project.number}/items`, `add the issue to "${title}"`, { method: 'POST', body: { type: 'Issue', id: issueId } });
      return;
    }
    if (projects.length < 100) throw new Error(`${owner} has no open Project titled "${title}"`);
  }
}

/**
 * Reads issue `number` as a brief, over REST: its state, type and body, and the merge commit of the newest pull
 * request that closed it saying "Fixes #N". Null when GitHub shows no such issue.
 */
export async function readBrief(sys: Sys, token: string, slug: string, number: number): Promise<BriefIssue | null> {
  const got = await sys.http(`${API}/repos/${slug}/issues/${number}`, { token });
  if (got.status === 404 || got.status === 410) return null;
  const issue = got.json as { number?: unknown; state?: unknown; state_reason?: unknown; type?: { name?: unknown } | null; body?: unknown; pull_request?: unknown } | null;
  if (got.status !== 200 || issue?.number !== number || issue.pull_request) return null;
  let closingSha: string | null = null;
  if (issue.state === 'closed') {
    // REST names no closer (a pull request's close leaves the event's commit_id null), so the fix is the newest
    // merged pull request of this repository, into its default branch, that the issue's timeline cross-references
    // and whose text says "Fixes #N": the one GitHub closes the issue by. A brief fixed, reopened and closed by
    // hand still has its fix.
    const timeline = (await restList(sys, token, `repos/${slug}/issues/${number}/timeline`)) as {
      event?: string;
      source?: { issue?: { number?: unknown; repository_url?: unknown; pull_request?: { merged_at?: unknown } | null } | null } | null;
    }[];
    const here = `${API}/repos/${slug}`.toLowerCase();
    const merged = timeline.flatMap(({ event, source }) => {
      const pull = source?.issue;
      return event === 'cross-referenced' && typeof pull?.number === 'number' && pull.pull_request?.merged_at && String(pull.repository_url).toLowerCase() === here ? [pull.number] : [];
    });
    const repo = merged.length ? ((await rest(sys, token, `${API}/repos/${slug}`, `read ${slug}`)) as { default_branch?: unknown } | null) : null;
    for (const pr of [...new Set(merged)].reverse()) {
      const pull = (await rest(sys, token, `${API}/repos/${slug}/pulls/${pr}`, `read pull request #${pr}`)) as { title?: string; body?: string | null; merged_at?: string | null; merge_commit_sha?: string | null; base?: { ref?: string } } | null;
      if (pull?.merged_at && pull.merge_commit_sha && pull.base?.ref === repo?.default_branch && saysFixes(`${pull.title ?? ''}\n${pull.body ?? ''}`, number)) {
        closingSha = pull.merge_commit_sha;
        break;
      }
    }
  }
  return {
    number,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    stateReason: typeof issue.state_reason === 'string' ? issue.state_reason : null,
    type: typeof issue.type?.name === 'string' ? issue.type.name : null,
    body: typeof issue.body === 'string' ? issue.body : '',
    closingSha,
  };
}
