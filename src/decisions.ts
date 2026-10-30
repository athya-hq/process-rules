import { API, loadSettings, sameLogin } from './agent.ts';
import { expireVetoes } from './reviews.ts';
import type { Output, Sys } from './types.ts';

/** How long one decision's check may run, in seconds. */
const CHECK_TIMEOUT_S = 120;
/** How long a weekly run may spend on checks before it leaves the rest for next week; the job allows 60 minutes. */
const RUN_BUDGET_MS = 45 * 60_000;
/** What GNU timeout exits with when the check ran out of time. */
const TIMED_OUT = 124;
/** The line the wrapper prints with the check's own exit status. */
const STATUS_MARK = 'process-rules-check-exit=';
const STATUS_WRAPPER = `sh -c "$1"; echo "${STATUS_MARK}$?"`;
/** Who writes comments for the workflow's token: only its comments can say an undo issue was opened. */
const WORKFLOW_BOT = 'github-actions[bot]';
/** An Override is labeled `expiring` this many days before its expiry. */
const EXPIRING_DAYS = 30;
const DAY_MS = 86_400_000;
/** A check that reads files only a laptop has: it cannot run in Actions. */
const LAPTOP_PATH = /(?:^|[\s"'=(<>|;&:`])(?:~\/|\$HOME\b|\$\{HOME\}|\/Users\/|\/home\/)/;

export interface Decision {
  kind: string | undefined;
  review: string | undefined;
  expires: string | undefined;
  check: string | undefined;
  undo: string | undefined;
}

/** The fields a Decision issue's body carries, one per line: `Kind:`, `Review:`, `Expires:`, `Check:` (a command in backticks), `Undo:`. */
export function parseDecision(body: string): Decision {
  const field = (name: string): string | undefined => new RegExp(`^${name}:[ \\t]*(.+)$`, 'im').exec(body)?.[1]?.trim();
  const check = field('Check');
  return {
    kind: field('Kind'),
    review: field('Review'),
    expires: field('Expires'),
    check: check ? /^`([^`]+)`/.exec(check)?.[1] : undefined,
    undo: field('Undo'),
  };
}

interface Issue {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  user: { login: string } | null;
  labels: { name: string }[];
}

async function openIssues(sys: Sys, token: string, slug: string, filter: string): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (let page = 1; ; page++) {
    const { status, json } = await sys.http(`${API}/repos/${slug}/issues?state=open&${filter}&per_page=100&page=${page}`, { token });
    if (status !== 200 || !Array.isArray(json)) throw new Error(`cannot list open issues (HTTP ${status})`);
    issues.push(...(json as Issue[]));
    if (json.length < 100) return issues;
  }
}

/**
 * The weekly decisions job, run by the shared workflow on a schedule. For
 * each open Decision issue: a check that reads laptop files is labeled
 * `cannot-run-here`; any other check runs in the checkout, and when it fails
 * the decision gets a comment and one undo issue for the owner; an Override
 * whose expiry is within 30 days is labeled `expiring`. A check runs only
 * when the owner or the agent wrote the issue and was the last to edit it.
 */
export async function decisionsWeekly(sys: Sys, io: Output): Promise<number> {
  const { GITHUB_REPOSITORY: slug, GH_TOKEN: token } = sys.env;
  if (!slug || !token) throw new Error('decisions-weekly runs in GitHub Actions: GITHUB_REPOSITORY and GH_TOKEN must be set');
  const { owner, agent } = loadSettings(sys, sys.cwd);
  const trusted = (login: string | undefined): boolean => sameLogin(login, owner) || sameLogin(login, agent);
  const decisions = await openIssues(sys, token, slug, 'type=Decision');
  const undos = await openIssues(sys, token, slug, 'labels=needs-owner');

  const editors = await lastEditors(sys, token, decisions);

  const today = sys.now();
  const label = async (issue: Issue, name: string): Promise<void> => {
    if (issue.labels.some((had) => had.name === name)) return;
    const added = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/labels`, { method: 'POST', token, body: { labels: [name] } });
    if (added.status !== 200) throw new Error(`cannot label #${issue.number} ${name} (HTTP ${added.status})`);
  };

  // Before the decisions, so one decision's failing call cannot keep vetoes past their week.
  await expireVetoes(sys, io, slug, token);
  const started = sys.now().getTime();
  const tell = async (number: number, check: string, run: { code: number; stdout: string; stderr: string }, undo: number): Promise<void> => {
    const output = `${run.stdout}${run.stderr}`.trim().split('\n').slice(-20).join('\n');
    const commented = await sys.http(`${API}/repos/${slug}/issues/${number}/comments`, {
      method: 'POST',
      token,
      // The output, when the check printed any.
      body: {
        body: `Tripped on ${today.toISOString().slice(0, 10)}: \`${check}\` exited ${run.code}.\n\n${output ? `\`\`\`\n${output}\n\`\`\`\n\n` : ''}Opened #${undo} to undo it.`,
      },
    });
    if (commented.status !== 201) throw new Error(`cannot comment on #${number} (HTTP ${commented.status})`);
  };

  for (const issue of decisions) {
    const decision = parseDecision(issue.body ?? '');
    const where = `#${issue.number}`;
    if (decision.kind?.toLowerCase() === 'override' && decision.expires) {
      // Whole days from today's date to the expiry: 0 is today.
      const left = Math.round((Date.parse(`${decision.expires}T00:00:00Z`) - Date.parse(today.toISOString().slice(0, 10))) / DAY_MS);
      if (left < 0) {
        io.out(`${where}: its expiry ${decision.expires} has passed`);
      } else if (left <= EXPIRING_DAYS) {
        await label(issue, 'expiring');
        io.out(`${where}: expires ${decision.expires}; labeled expiring`);
      }
    }
    if (!decision.check) continue;
    const editor = editors.get(issue.number);
    if (!trusted(issue.user?.login) || (editor !== undefined && !trusted(editor))) {
      io.out(`${where}: not run; only ${owner} or ${agent} may write a decision's check`);
      continue;
    }
    if (LAPTOP_PATH.test(decision.check)) {
      await label(issue, 'cannot-run-here');
      io.out(`${where}: reads laptop files; labeled cannot-run-here`);
      continue;
    }
    if (sys.now().getTime() - started > RUN_BUDGET_MS) {
      io.out(`${where}: not run; this week's run has spent its time, so it waits for next week`);
      continue;
    }
    // GNU timeout ends the whole process group the check starts, not just its shell.
    // The inner shell prints the check's own exit status, so a check that exits 124
    // itself is told apart from one that ran out of time.
    const raw = sys.exec('timeout', ['-k', '5', String(CHECK_TIMEOUT_S), 'sh', '-c', STATUS_WRAPPER, 'process-rules', decision.check], {
      cwd: sys.cwd,
      env: { PATH: sys.env.PATH, HOME: sys.env.HOME },
      timeoutMs: (CHECK_TIMEOUT_S + 10) * 1000,
    });
    const status = new RegExp(`^${STATUS_MARK}(\\d+)$`, 'm').exec(raw.stdout)?.[1];
    const run = { ...raw, code: status === undefined ? raw.code : Number(status), stdout: raw.stdout.replace(new RegExp(`^${STATUS_MARK}\\d+\\n?`, 'm'), '') };
    if (run.code === 0) {
      io.out(`${where}: holds`);
      continue;
    }
    if (status === undefined && raw.code === TIMED_OUT) {
      io.out(`${where}: its check ran past ${CHECK_TIMEOUT_S} seconds; not counted as tripped`);
      continue;
    }
    const open = undos.find((undo) => new RegExp(`^Undoes #${issue.number}\\b`, 'm').test(undo.body ?? ''));
    if (open) {
      // A run that opened the undo issue but failed to comment leaves the comment to this one.
      const comments = await sys.http(`${API}/repos/${slug}/issues/${issue.number}/comments?per_page=100`, { token });
      if (comments.status !== 200 || !Array.isArray(comments.json)) throw new Error(`cannot read #${issue.number}'s comments (HTTP ${comments.status})`);
      const told = (comments.json as { body?: string; user?: { login?: string } | null }[]).some(
        (comment) => comment.user?.login === WORKFLOW_BOT && comment.body?.includes(`Opened #${open.number} to undo it.`),
      );
      if (told) {
        io.out(`${where}: tripped; its undo issue is already open`);
        continue;
      }
      await tell(issue.number, decision.check, run, open.number);
      io.out(`${where}: tripped; its undo issue #${open.number} is open, and the decision now says so`);
      continue;
    }
    const opened = await sys.http(`${API}/repos/${slug}/issues`, {
      method: 'POST',
      token,
      body: {
        title: `Undo: ${issue.title}`,
        body: `Undoes #${issue.number}.\n\nThe weekly check \`${decision.check}\` failed (exit ${run.code}).\n\n${decision.undo ? `Undo: ${decision.undo}` : 'The decision names no undo step; decide what to do.'}`,
        labels: ['needs-owner'],
        type: 'Brief',
      },
    });
    const undo = (opened.json as { number?: number } | null)?.number;
    if (opened.status !== 201 || typeof undo !== 'number') throw new Error(`cannot open the undo issue for #${issue.number} (HTTP ${opened.status})`);
    await tell(issue.number, decision.check, run, undo);
    io.out(`${where}: tripped; opened #${undo} to undo it`);
  }
  io.out(`decisions-weekly: ${decisions.length} open decision${decisions.length === 1 ? '' : 's'} checked`);
  return 0;
}

/** Who last edited each issue's body (undefined when no one has), by issue number. */
export async function lastEditors(sys: Sys, token: string, issues: { number: number; node_id: string }[]): Promise<Map<number, string | undefined>> {
  const editors = new Map<number, string | undefined>();
  if (issues.length === 0) return editors;
  const { status, json } = await sys.http(`${API}/graphql`, {
    method: 'POST',
    token,
    body: {
      query: 'query($ids: [ID!]!) { nodes(ids: $ids) { ... on Issue { number editor { login } } } }',
      variables: { ids: issues.map((issue) => issue.node_id) },
    },
  });
  const nodes = (json as { data?: { nodes?: ({ number: number; editor: { login: string } | null } | null)[] } } | null)?.data?.nodes;
  if (status !== 200 || !nodes) throw new Error(`cannot read who edited the decisions (HTTP ${status})`);
  for (const node of nodes) if (node) editors.set(node.number, node.editor?.login);
  return editors;
}
