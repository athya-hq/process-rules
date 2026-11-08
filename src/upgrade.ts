import { API } from './agent.ts';
import { releaseTarball } from './cloud.ts';
import { type Finding, tilde } from './layout.ts';
import { PRODUCT } from './onboard.ts';
import { CLOUD_SETUP_PATH } from './onboard-pull.ts';
import type { Output, Sys } from './types.ts';
import { isNewer, packageVersion } from './version.ts';

/** The command that updates this machine's CLI, as messages name it. */
export const UPGRADE = 'process-rules upgrade';

/** How long GitHub gets to name the newest release, and pnpm to install it. */
const ASK_MS = 15_000;
const INSTALL_MS = 300_000;
/** How long a copy on PATH gets to print its version. */
const VERSION_MS = 15_000;

/**
 * The newest published release and whether its CLI package is attached, read
 * from GitHub's public releases API with no token: the repository is public,
 * as the README's install line already relies on. GitHub's "latest" is the
 * newest release by date that is neither a draft nor a prerelease, which is
 * also the highest while releases are cut in order from main.
 */
export async function newestRelease(sys: Sys): Promise<{ version: string; packaged: boolean } | { problem: string }> {
  let answer: { status: number; json: unknown };
  try {
    answer = await sys.http(`${API}/repos/${PRODUCT}/releases/latest`, { timeoutMs: ASK_MS });
  } catch (error) {
    return { problem: `GitHub could not be asked for the newest release (${error instanceof Error ? error.message : String(error)})` };
  }
  if (answer.status !== 200) return { problem: `GitHub answered HTTP ${answer.status} when asked for the newest release` };
  const json = answer.json as { tag_name?: unknown; assets?: { name?: unknown }[] } | null;
  const version = typeof json?.tag_name === 'string' ? /^v(\d+\.\d+\.\d+)$/.exec(json.tag_name)?.[1] : undefined;
  if (version === undefined) return { problem: `the newest release's tag, ${JSON.stringify(json?.tag_name ?? null)}, is not vX.Y.Z` };
  const packaged = (json?.assets ?? []).some((asset) => asset.name === `athya-hq-process-rules-${version}.tgz`);
  return { version, packaged };
}

/** One `process-rules` on PATH, in PATH's order, with the version it prints, or why it printed none. */
export interface Copy {
  path: string;
  version?: string;
  problem?: string;
}

/** Each `process-rules` on PATH, as `type -a process-rules` lists them, first the one the shell runs. */
export function copiesOnPath(sys: Sys): Copy[] {
  if (!sys.env.PATH) return [];
  // The shell reads an empty or relative entry against the folder it is in, so this does too.
  const dirs = [...new Set((sys.env.PATH ?? '').split(':').map((dir) => (dir.startsWith('/') ? dir : `${sys.cwd}/${dir || '.'}`.replace(/\/\.$/, ''))))];
  return dirs
    .map((dir) => `${dir.replace(/\/+$/, '')}/process-rules`)
    .filter((path) => sys.exists(path))
    .map((path) => {
      const run = sys.exec(path, ['--version'], { timeoutMs: VERSION_MS });
      const version = run.stdout.trim();
      return run.code === 0 && /^\d+\.\d+\.\d+$/.test(version)
        ? { path, version }
        : { path, problem: run.code === 0 ? `printed ${JSON.stringify(version.split('\n')[0])}` : run.stderr.trim().split('\n')[0] || `exit ${run.code}` };
    });
}

/**
 * What is wrong with the copies on PATH for a machine that should run
 * `wanted`: none when exactly one is there and it prints `wanted`, or when
 * none is and pnpm's own copy is not known (the hooks run the launcher
 * `machine` writes); otherwise lines
 * naming each copy and its version, and which to remove. `keep` is the copy
 * pnpm just installed, when known; `install`, the step that puts `wanted` on
 * PATH when no copy there is it and nothing was installed.
 */
export function strayCopies(copies: readonly Copy[], wanted: string, keep?: string, install?: string): string[] {
  const [first] = copies;
  if (first === undefined) {
    return keep === undefined ? [] : [`no process-rules is on PATH: pnpm put ${wanted} in ${keep}; put ${dirOf(keep)} on PATH (pnpm setup does), then open a new shell`];
  }
  if (copies.length === 1 && first.version === wanted) return [];
  const kept = copies.find((copy) => copy.path === keep && copy.version === wanted) ?? copies.find((copy) => copy.version === wanted);
  const width = Math.max(...copies.map((copy) => copy.path.length));
  const lines = [
    copies.length === 1
      ? `the process-rules on PATH is not ${wanted}:`
      : `${copies.length} copies of process-rules are on PATH, and the shell runs the first:`,
    ...copies.map((copy) => `  ${copy.path.padEnd(width)}  ${copy.version ?? `does not run (${copy.problem})`}${copy === kept ? '  ← keep' : ''}`),
  ];
  const remove = copies.filter((copy) => copy !== kept).map((copy) => copy.path);
  if (kept === undefined) {
    lines.push(
      keep === undefined
        ? `  None of them is ${wanted}: ${install === undefined ? `remove ${remove.join(' and ')}, then run ${UPGRADE} again` : `${install}, then run ${UPGRADE} again to check PATH`}.`
        : `  None of them is ${wanted}, which pnpm put in ${keep}: remove ${remove.join(' and ')}, and put ${dirOf(keep)} on PATH (pnpm setup does).`,
    );
  } else {
    lines.push(`  Remove ${remove.join(' and ')}, or uninstall what put ${remove.length === 1 ? 'it' : 'them'} there, so the shell runs ${kept.path}.`);
  }
  return lines;
}

/**
 * Updates this machine's CLI to the newest release: the README's install,
 * `pnpm add -g` of that release's package, never an older one and never
 * signed in to GitHub. Then it walks PATH, as `type -a` does, and fails
 * when an older copy would still run first. Exit 0 when the shell runs the
 * newest release and nothing else is on PATH, 1 otherwise.
 */
export async function upgrade(sys: Sys, io: Output, running: string = packageVersion()): Promise<number> {
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') {
    io.err(`upgrade: a Claude cloud session runs the release ${CLOUD_SETUP_PATH} installs, not pnpm's; run process-rules onboard on a Mac to move the repo's pin, then bash ${CLOUD_SETUP_PATH} or start a new session`);
    return 1;
  }
  const spinner = sys.spin('Asking GitHub for the newest release');
  const newest = await newestRelease(sys);
  spinner.stop();
  if ('problem' in newest) {
    io.err(`upgrade: ${newest.problem}; nothing installed`);
    return 1;
  }
  const { version } = newest;
  if (!isNewer(version, running)) {
    io.out(
      version === running
        ? `upgrade: process-rules ${running} is the newest release`
        : `upgrade: this is process-rules ${running}, newer than the newest release, ${version}; upgrade never moves back`,
    );
    // The release, not a newer build run from elsewhere, is what PATH should hold.
    return pathCheck(sys, io, version, undefined, `install it with pnpm add -g ${releaseTarball(version)}`);
  }
  if (!newest.packaged) {
    io.err(`upgrade: the v${version} release has no athya-hq-process-rules-${version}.tgz yet; run ${UPGRADE} again once the Release workflow attaches it`);
    return 1;
  }
  const url = releaseTarball(version);
  io.out(`upgrade: process-rules ${running} → ${version}`);
  io.out(`  pnpm add -g ${url}`);
  const installing = sys.spin(`Installing process-rules ${version}`);
  const install = sys.exec('pnpm', ['add', '-g', url], { timeoutMs: INSTALL_MS });
  installing.stop();
  if (install.code !== 0) {
    if (install.code === 127) {
      io.err('upgrade: pnpm is not on PATH, so nothing was installed; install pnpm, then run process-rules upgrade again');
      return 1;
    }
    io.err(`upgrade: pnpm add -g failed (exit ${install.code}), so process-rules is still ${running}:`);
    const said = `${install.stderr}\n${install.stdout}`.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    for (const line of said.slice(-10)) io.err(`  ${line}`);
    return 1;
  }
  return pathCheck(sys, io, version, pnpmBin(sys));
}

/** The folder pnpm puts global commands in, or undefined when pnpm will not say. */
function pnpmBin(sys: Sys): string | undefined {
  const bin = sys.exec('pnpm', ['bin', '-g'], { timeoutMs: VERSION_MS });
  const dir = bin.stdout.trim();
  return bin.code === 0 && dir.startsWith('/') ? `${dir.replace(/\/+$/, '')}/process-rules` : undefined;
}

/** Says which process-rules the shell now runs; exit 1, naming each copy, when it is not `wanted` alone. */
function pathCheck(sys: Sys, io: Output, wanted: string, keep?: string, install?: string): number {
  const copies = copiesOnPath(sys);
  const stray = strayCopies(copies, wanted, keep, install);
  if (stray.length > 0) {
    for (const [i, line] of stray.entries()) io.err(i === 0 ? `upgrade: ${line}` : line);
    return 1;
  }
  const [first] = copies;
  io.out(first === undefined ? `upgrade: no process-rules is on PATH; the hooks run the launcher process-rules machine writes` : `upgrade: the shell runs process-rules ${wanted} (${first.path})`);
  return 0;
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

/**
 * doctor's findings on a Mac about the CLI itself: whether it is the newest
 * release (▲ when a newer one is out, or GitHub cannot say), and ✗ when PATH
 * holds more than one process-rules or one that is not this release.
 */
export async function installedFindings(sys: Sys, running: string = packageVersion()): Promise<Finding[]> {
  const newest = await newestRelease(sys);
  const findings: Finding[] = [
    'problem' in newest
      ? { mark: '▲', text: `process-rules ${running} runs here; ${newest.problem}`, fix: 'process-rules doctor again' }
      : isNewer(newest.version, running)
        ? { mark: '▲', text: `process-rules ${running} runs here; ${newest.version} is out`, fix: UPGRADE }
        : { mark: '✓', text: `process-rules ${running}, the newest release` },
  ];
  const copies = copiesOnPath(sys);
  if (strayCopies(copies, running).length > 0) {
    findings.push({
      mark: '✗',
      text: `process-rules on PATH, the first runs: ${copies.map((copy) => `${tilde(sys.home, copy.path)} ${copy.version ?? 'does not run'}`).join(', ')}`,
      fix: `remove all but one, then ${UPGRADE}`,
    });
  }
  return findings;
}
