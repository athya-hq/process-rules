import { API, SETTINGS_PATH, pathsFor, sessionEnv } from './agent.ts';
import type { Output, Sys } from './types.ts';
import { GITHUB_WEB } from './host.ts';

/** The branch onboard's pull request comes from: a run again updates the same one. */
export const ONBOARD_BRANCH = 'process-rules/onboard';
export const HOOKS_PATH = '.claude/settings.json';
export const WORKFLOW_PATH = '.github/workflows/process-rules.yml';
/** The repo's cloud setup file, which installs the pinned CLI in Claude cloud sessions. */
export const CLOUD_SETUP_PATH = '.github/process-rules/cloud-setup.sh';
/** Every file onboard's pull request may change. */
export const ONBOARD_FILES = [SETTINGS_PATH, HOOKS_PATH, WORKFLOW_PATH, CLOUD_SETUP_PATH];

/** A subject's leading emoji, or gitmoji shortcode, and the rest of it. */
const LEADING_EMOJI = /^(\p{Regional_Indicator}{2}|\p{Extended_Pictographic}\p{Emoji_Modifier}?️?(?:‍\p{Extended_Pictographic}\p{Emoji_Modifier}?️?)*|:[a-z0-9_+-]+:)\s+(.*)$/u;

/**
 * onboard's commit header and pull request title: Conventional Commits,
 * scoped to the product, in the style of `recent`, the default branch's
 * latest commit subjects. When most of them lead with an emoji (gitmoji),
 * so does the title: the one an earlier onboard commit had, else the one the
 * repository puts most on chores, else gitmoji's for configuration. Merge
 * commits are git's own words, so they count for neither style.
 */
export function pullTitle(version: string, recent: readonly string[] = []): string {
  const title = `chore(process-rules): onboard at v${version}`;
  const subjects = recent.filter((subject) => !subject.startsWith('Merge '));
  const led = subjects.flatMap((subject) => {
    const match = LEADING_EMOJI.exec(subject);
    return match ? [{ emoji: match[1] as string, rest: match[2] as string }] : [];
  });
  if (led.length * 2 <= subjects.length) return title;
  const before = led.find((one) => one.rest.startsWith('chore(process-rules)'))?.emoji;
  const counts = new Map<string, number>();
  for (const { emoji, rest } of led) if (/^chore\b/.test(rest)) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
  const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const shortcodes = led.filter((one) => one.emoji.startsWith(':')).length * 2 > led.length;
  return `${before ?? most ?? (shortcodes ? ':wrench:' : '🔧')} ${title}`;
}

/** Where Mergify reads its configuration from, in the order it looks: it uses the first the branch has. */
export const MERGIFY_PATHS = ['.mergify.yml', '.mergify/config.yml', '.github/mergify.yml'];

/** A pull request rule's top-level conditions that a pull request meets only once someone labels it. */
function asksForLabel(conditions: unknown): boolean {
  return Array.isArray(conditions) && conditions.some((condition) => typeof condition === 'string' && /^label\s*[=~]/.test(condition.trim()));
}

/**
 * The path of the default branch's Mergify configuration when its merge
 * queue takes pull requests by itself, so it merges onboard's and GitHub's
 * auto-merge is not needed; undefined otherwise, or when GitHub does not say.
 * Mergify reads the first of MERGIFY_PATHS the branch has. It queues by
 * itself where the configuration has a queue rule and either merge
 * protections' `auto_merge_conditions` (`true`, or conditions that ask for
 * no label), or a pull request rule whose actions hold `queue` and whose
 * conditions ask for no label. Mergify replaced the queue rules' own
 * `autoqueue` with `auto_merge_conditions`, so it does not count. Read as the agent, from GitHub,
 * since a checkout may be behind the default branch.
 */
export async function mergeQueue(sys: Sys, slug: string, branch: string, token: string): Promise<string | undefined> {
  for (const path of MERGIFY_PATHS) {
    const { status, json } = await sys.http(`${API}/repos/${slug}/contents/${path}?ref=${encodeURIComponent(branch)}`, { token }).catch(() => ({ status: 0, json: undefined }));
    if (status === 404) continue;
    const content = (json as { content?: unknown } | null)?.content;
    if (status !== 200 || typeof content !== 'string') return undefined;
    const { parse } = await import('yaml');
    let config: { queue_rules?: unknown; pull_request_rules?: unknown; merge_protections_settings?: unknown; merge_protection_settings?: unknown } | null;
    try {
      config = parse(Buffer.from(content, 'base64').toString('utf8')) as typeof config;
    } catch {
      return undefined;
    }
    const queues = Array.isArray(config?.queue_rules) ? config.queue_rules : [];
    const rules = Array.isArray(config?.pull_request_rules) ? (config.pull_request_rules as ({ conditions?: unknown; actions?: unknown } | null)[]) : [];
    const queuing = rules.some((rule) => typeof rule?.actions === 'object' && rule.actions !== null && 'queue' in rule.actions && !asksForLabel(rule.conditions));
    // Mergify's docs spell the key both ways.
    const protections = (config?.merge_protections_settings ?? config?.merge_protection_settings) as { auto_merge_conditions?: unknown } | null | undefined;
    const conditions = protections?.auto_merge_conditions;
    const auto = conditions === true || (Array.isArray(conditions) && !asksForLabel(conditions));
    return queues.length > 0 && (queuing || auto) ? path : undefined;
  }
  return undefined;
}

/** A file onboard changes: what this checkout has (undefined when none), and what onboard writes. */
export interface Change {
  path: string;
  before: string | undefined;
  text: string;
  /** What changed, for the pull request's description. */
  what: string;
}

/** The pull request onboard opened or updated: its link, and GitHub's id for it, which auto-merge needs. */
export interface Pull {
  url: string;
  id: string | undefined;
}

export interface PullTarget {
  agent: string;
  id: number;
  token: string;
  slug: string;
  /** The default branch, which the pull request is opened against. */
  branch: string;
  version: string;
}

/**
 * Opens onboard's changes as the agent's pull request, never touching the
 * owner's checkout: a temporary repository holding the default branch's tip
 * (its trees, not its files' contents), each changed file put in its index,
 * one commit signed as the agent, pushed as the agent to ONBOARD_BRANCH,
 * and a pull request opened, or the open one updated. A file the default
 * branch has otherwise than this checkout is refused, so nothing on the
 * default branch is undone. The temporary repository is deleted whatever
 * happens. `notes`, lines of Markdown, follow the list of files in the
 * description. Returns the pull request's link, or 1 having said why not.
 */
export async function openPull(sys: Sys, io: Output, target: PullTarget, changes: readonly Change[], notes: readonly string[] = []): Promise<Pull | 1> {
  const { agent, id, token, slug, branch, version } = target;
  const dir = sys.tempDir();
  const env = sessionEnv(sys.env, agent, id, token, pathsFor(sys.home, agent));
  const git = (args: string[], input?: string) => sys.exec('git', args, { cwd: dir, env, ...(input === undefined ? {} : { input }) });
  const url = `${GITHUB_WEB}/${slug}.git`;
  const failed = (what: string, stderr: string): 1 => {
    io.err(`onboard: ${what} failed: ${stderr.trim()}`);
    return 1;
  };
  try {
    for (const args of [
      ['init', '-q'],
      // The tip's trees alone: a file's contents is fetched only should git need it.
      ['fetch', '-q', '--depth=1', '--filter=blob:none', url, `refs/heads/${branch}`],
      ['read-tree', 'FETCH_HEAD'],
    ]) {
      const step = git(args);
      if (step.code !== 0) return failed(`git ${args[0]}`, step.stderr);
    }
    for (const change of changes) {
      const tip = git(['rev-parse', '--verify', '-q', `FETCH_HEAD:${change.path}`]).stdout.trim() || undefined;
      const here = change.before === undefined ? undefined : git(['hash-object', '--stdin'], change.before).stdout.trim();
      if (tip !== here) {
        io.err(`onboard: ${change.path} on ${branch} is not what this checkout has; bring this checkout up to date with ${branch} and run onboard again`);
        return 1;
      }
      const blob = git(['hash-object', '-w', '--stdin'], change.text);
      if (blob.code !== 0) return failed(`storing ${change.path}`, blob.stderr);
      const added = git(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},${change.path}`]);
      if (added.code !== 0) return failed(`staging ${change.path}`, added.stderr);
    }
    // --missing-ok: the files onboard leaves alone have no contents here.
    const tree = git(['write-tree', '--missing-ok']);
    if (tree.code !== 0) return failed('git write-tree', tree.stderr);
    const title = pullTitle(version, await recentSubjects(sys, slug, branch, token));
    const made = git(['commit-tree', '-S', tree.stdout.trim(), '-p', 'FETCH_HEAD', '-m', title]);
    const sha = made.stdout.trim();
    if (made.code !== 0 || !sha) return failed('signing the commit', made.stderr);
    // Forced: a run again replaces what an earlier run pushed there.
    const push = git(['push', '-q', url, `+${sha}:refs/heads/${ONBOARD_BRANCH}`]);
    if (push.code !== 0) return failed(`pushing as ${agent}`, push.stderr);

    const body = [
      `\`process-rules onboard\` v${version}, run by the owner, sets this repository up. The owner approved the plan holding every change below at the terminal:`,
      '',
      ...changes.map((change) => `- \`${change.path}\`: ${change.what}`),
      '',
      ...(notes.length > 0 ? [...notes, ''] : []),
      `Merge it to finish onboarding; agent sessions then work as ${agent}. Running onboard again updates this pull request.`,
    ].join('\n');
    const pulls = `${API}/repos/${slug}/pulls`;
    const opened = await sys.http(pulls, { method: 'POST', token, body: { title, head: ONBOARD_BRANCH, base: branch, body } });
    if (opened.status === 201) {
      const made = opened.json as { html_url: string; node_id?: unknown };
      return { url: made.html_url, id: typeof made.node_id === 'string' ? made.node_id : undefined };
    }
    // 422: the branch has a pull request open already, which the push has just updated.
    const open = opened.status === 422 ? await sys.http(`${pulls}?state=open&head=${slug.split('/')[0]}:${ONBOARD_BRANCH}`, { token }) : undefined;
    const pull = Array.isArray(open?.json) ? (open.json[0] as { number: number; html_url: string; node_id?: unknown } | undefined) : undefined;
    if (!pull) {
      const why = (opened.json as { message?: unknown } | null)?.message;
      io.err(`onboard: GitHub did not open the pull request (HTTP ${opened.status}${typeof why === 'string' ? `: ${why}` : ''}); the changes are on ${ONBOARD_BRANCH}`);
      return 1;
    }
    const edited = await sys.http(`${pulls}/${pull.number}`, { method: 'PATCH', token, body: { title, body } });
    if (edited.status !== 200) io.err(`onboard: could not update the description of ${pull.html_url} (HTTP ${edited.status})`);
    return { url: pull.html_url, id: typeof pull.node_id === 'string' ? pull.node_id : undefined };
  } finally {
    sys.remove(dir);
  }
}

/** The default branch's latest commit subjects, newest first; none when GitHub does not say. */
async function recentSubjects(sys: Sys, slug: string, branch: string, token: string): Promise<string[]> {
  const { status, json } = await sys.http(`${API}/repos/${slug}/commits?sha=${encodeURIComponent(branch)}&per_page=20`, { token }).catch(() => ({ status: 0, json: undefined }));
  if (status !== 200 || !Array.isArray(json)) return [];
  return json.flatMap((one: { commit?: { message?: unknown } }) => (typeof one?.commit?.message === 'string' ? [one.commit.message.split('\n')[0] as string] : []));
}

/** The merge methods auto-merge may use, in the order onboard prefers them, by the repository setting that allows each. */
const MERGE_METHODS = [
  ['allow_squash_merge', 'SQUASH'],
  ['allow_rebase_merge', 'REBASE'],
  ['allow_merge_commit', 'MERGE'],
] as const;

/**
 * Turns on GitHub's auto-merge for onboard's pull request, as the agent,
 * which can push: it then merges itself once its checks pass. REST has no
 * call for it, so GraphQL's enablePullRequestAutoMerge, with the first
 * merge method the repository allows of squash, rebase and merge. Returns
 * why not, without failing: the repository does not allow auto-merge
 * (`notAllowed`), or GitHub refused, as it does for a pull request already
 * clean to merge.
 */
export async function autoMerge(sys: Sys, slug: string, token: string, id: string | undefined): Promise<{ problem: string; notAllowed?: true } | undefined> {
  const repo = await sys.http(`${API}/repos/${slug}`, { token });
  const settings = (repo.json ?? {}) as Record<string, unknown>;
  // A setting GitHub does not report is not taken as off: GitHub refuses the request itself then, saying why.
  if (settings.allow_auto_merge === false) return { problem: `${slug} does not allow auto-merge`, notAllowed: true };
  const method = MERGE_METHODS.find(([setting]) => settings[setting] !== false)?.[1];
  if (!method) return { problem: `${slug} allows no merge method` };
  if (!id) return { problem: 'GitHub gave no id for the pull request' };
  const { status, json } = await sys.http(`${API}/graphql`, {
    method: 'POST',
    token,
    body: {
      query: 'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { id } } }',
      variables: { id, method },
    },
  });
  const reply = json as { data?: unknown; errors?: { message?: string }[] } | null;
  if (status === 200 && !reply?.errors?.length && reply?.data) return undefined;
  const why = reply?.errors?.map((error) => error.message).join('; ') || `HTTP ${status}`;
  return /not allowed|not enabled/i.test(why) ? { problem: why, notAllowed: true } : { problem: why };
}
