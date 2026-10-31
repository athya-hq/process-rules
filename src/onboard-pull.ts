import { API, SETTINGS_PATH, pathsFor, sessionEnv } from './agent.ts';
import { CODEOWNERS_PATHS } from './codeowners.ts';
import type { Output, Sys } from './types.ts';

/** The branch onboard's pull request comes from: a run again updates the same one. */
export const ONBOARD_BRANCH = 'process-rules/onboard';
export const HOOKS_PATH = '.claude/settings.json';
export const WORKFLOW_PATH = '.github/workflows/process-rules.yml';
/** Every file onboard's pull request may change. */
export const ONBOARD_FILES = [SETTINGS_PATH, HOOKS_PATH, WORKFLOW_PATH, ...CODEOWNERS_PATHS];

/** A file onboard changes: what this checkout has (undefined when none), and what onboard writes. */
export interface Change {
  path: string;
  before: string | undefined;
  text: string;
  /** What changed, for the pull request's description. */
  what: string;
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
 * happens. Returns the pull request's link, or 1 having said why not.
 */
export async function openPull(sys: Sys, io: Output, target: PullTarget, changes: readonly Change[]): Promise<string | 1> {
  const { agent, id, token, slug, branch, version } = target;
  const dir = sys.tempDir();
  const env = sessionEnv(sys.env, agent, id, token, pathsFor(sys.home, agent));
  const git = (args: string[], input?: string) => sys.exec('git', args, { cwd: dir, env, ...(input === undefined ? {} : { input }) });
  const url = `https://github.com/${slug}.git`;
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
    const title = `process-rules onboard at v${version}`;
    const made = git(['commit-tree', '-S', tree.stdout.trim(), '-p', 'FETCH_HEAD', '-m', title]);
    const sha = made.stdout.trim();
    if (made.code !== 0 || !sha) return failed('signing the commit', made.stderr);
    // Forced: a run again replaces what an earlier run pushed there.
    const push = git(['push', '-q', url, `+${sha}:refs/heads/${ONBOARD_BRANCH}`]);
    if (push.code !== 0) return failed(`pushing as ${agent}`, push.stderr);

    const body = [
      `\`process-rules onboard\` v${version}, run by the owner, sets this repository up. Every change below was confirmed at the terminal:`,
      '',
      ...changes.map((change) => `- \`${change.path}\`: ${change.what}`),
      '',
      `Merge it to finish onboarding; agent sessions then work as ${agent}. Running onboard again updates this pull request.`,
    ].join('\n');
    const pulls = `${API}/repos/${slug}/pulls`;
    const opened = await sys.http(pulls, { method: 'POST', token, body: { title, head: ONBOARD_BRANCH, base: branch, body } });
    if (opened.status === 201) return (opened.json as { html_url: string }).html_url;
    // 422: the branch has a pull request open already, which the push has just updated.
    const open = opened.status === 422 ? await sys.http(`${pulls}?state=open&head=${slug.split('/')[0]}:${ONBOARD_BRANCH}`, { token }) : undefined;
    const pull = Array.isArray(open?.json) ? (open.json[0] as { number: number; html_url: string } | undefined) : undefined;
    if (!pull) {
      const why = (opened.json as { message?: unknown } | null)?.message;
      io.err(`onboard: GitHub did not open the pull request (HTTP ${opened.status}${typeof why === 'string' ? `: ${why}` : ''}); the changes are on ${ONBOARD_BRANCH}`);
      return 1;
    }
    const edited = await sys.http(`${pulls}/${pull.number}`, { method: 'PATCH', token, body: { title, body } });
    if (edited.status !== 200) io.err(`onboard: could not update the description of ${pull.html_url} (HTTP ${edited.status})`);
    return pull.html_url;
  } finally {
    sys.remove(dir);
  }
}
