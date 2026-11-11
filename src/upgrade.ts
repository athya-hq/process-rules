import { API, launcherPath, repointedLauncher } from './agent.ts';
import { LAST_OLD_RELEASE, releaseAsset } from './cloud.ts';
import { type Finding, tilde } from './layout.ts';
import { CLI, OLD_CLI, OLD_PACKAGE, OLD_PRODUCT, PACKAGE, PRODUCT, tarballName } from './names.ts';
import { CLOUD_SETUP_PATH } from './onboard-pull.ts';
import type { Output, Sys } from './types.ts';
import { GITHUB_WEB } from './host.ts';
import { isNewer, packageName, packageVersion } from './version.ts';

/** The command that updates this machine's CLI, as messages name it. */
export const UPGRADE = `${CLI} upgrade`;

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
 * also the highest while releases are cut in order from main. It asks
 * veda-hq/niyam, and athya-hq/process-rules when that is not there yet; GitHub
 * forwards the old name once the repository has moved.
 */
export async function newestRelease(sys: Sys): Promise<{ version: string; packaged: boolean; repo: string } | { problem: string }> {
  let answer: { status: number; json: unknown } | undefined;
  let repo = PRODUCT;
  for (repo of [PRODUCT, OLD_PRODUCT]) {
    try {
      answer = await sys.http(`${API}/repos/${repo}/releases/latest`, { timeoutMs: ASK_MS });
    } catch (error) {
      return { problem: `GitHub could not be asked for the newest release (${error instanceof Error ? error.message : String(error)})` };
    }
    if (answer.status !== 404) break;
  }
  if (answer?.status !== 200) return { problem: `GitHub answered HTTP ${answer?.status} when asked for the newest release` };
  const json = answer.json as { tag_name?: unknown; assets?: { name?: unknown }[] } | null;
  const version = typeof json?.tag_name === 'string' ? /^v(\d+\.\d+\.\d+)$/.exec(json.tag_name)?.[1] : undefined;
  if (version === undefined) return { problem: `the newest release's tag, ${JSON.stringify(json?.tag_name ?? null)}, is not vX.Y.Z` };
  const packaged = (json?.assets ?? []).some((asset) => asset.name === releaseAsset(version));
  return { version, packaged, repo };
}

/** One copy of a command on PATH, in PATH's order, with the version it prints, or why it printed none. */
export interface Copy {
  path: string;
  version?: string;
  problem?: string;
}

/** Each `name` on PATH, as `type -a <name>` lists them, first the one the shell runs. */
export function copiesOnPath(sys: Sys, name: string = CLI): Copy[] {
  if (!sys.env.PATH) return [];
  // The shell reads an empty or relative entry against the folder it is in, so this does too.
  const dirs = [...new Set((sys.env.PATH ?? '').split(':').map((dir) => (dir.startsWith('/') ? dir : `${sys.cwd}/${dir || '.'}`.replace(/\/\.$/, ''))))];
  return dirs
    .map((dir) => `${dir.replace(/\/+$/, '')}/${name}`)
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
export function strayCopies(copies: readonly Copy[], wanted: string, keep?: string, install?: string, name: string = CLI): string[] {
  const [first] = copies;
  if (first === undefined) {
    return keep === undefined ? [] : [`no ${name} is on PATH: pnpm put ${wanted} in ${keep}; put ${dirOf(keep)} on PATH (pnpm setup does), then open a new shell`];
  }
  if (copies.length === 1 && first.version === wanted) return [];
  const kept = copies.find((copy) => copy.path === keep && copy.version === wanted) ?? copies.find((copy) => copy.version === wanted);
  const width = Math.max(...copies.map((copy) => copy.path.length));
  const lines = [
    copies.length === 1
      ? `the ${name} on PATH is not ${wanted}:`
      : `${copies.length} copies of ${name} are on PATH, and the shell runs the first:`,
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
 *
 * A CLI installed under the old package name (the bridge release 0.6.x's
 * `upgrade` installs) moves to @veda-hq/niyam, at the same release when that
 * is the newest. pnpm refuses two global packages with the same bin, so the
 * old one goes first; when the new one then fails to install, the old one is
 * put back.
 */
export async function upgrade(sys: Sys, io: Output, running: string = packageVersion(), name: string = packageName()): Promise<number> {
  if (sys.env.CLAUDE_CODE_REMOTE === 'true') {
    io.err(`upgrade: a Claude cloud session runs the release ${CLOUD_SETUP_PATH} installs, not pnpm's; run ${CLI} onboard on a Mac to move the repo's pin, then bash ${CLOUD_SETUP_PATH} or start a new session`);
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
  // The repository that answered: before the transfer veda-hq/niyam has no releases to download from.
  const url = `${GITHUB_WEB}/${newest.repo}/releases/download/v${version}/${releaseAsset(version)}`;
  const renaming = name === OLD_PACKAGE && version === running && isNewer(version, LAST_OLD_RELEASE);
  if (!isNewer(version, running) && !renaming) {
    io.out(
      version === running
        ? `upgrade: ${CLI} ${running} is the newest release`
        : `upgrade: this is ${CLI} ${running}, newer than the newest release, ${version}; upgrade never moves back`,
    );
    // The release, not a newer build run from elsewhere, is what PATH should hold.
    return Math.max(repoint(sys, io), pathCheck(sys, io, version, undefined, `install it with pnpm add -g ${url}`));
  }
  if (!newest.packaged) {
    io.err(`upgrade: the v${version} release has no ${releaseAsset(version)} yet; run ${UPGRADE} again once the Release workflow attaches it`);
    return 1;
  }
  io.out(renaming ? `upgrade: ${CLI} ${running}, from ${OLD_PACKAGE} to ${PACKAGE}` : `upgrade: ${CLI} ${running} → ${version}`);
  if (name === OLD_PACKAGE) io.out(`  pnpm remove -g ${OLD_PACKAGE}`);
  io.out(`  pnpm add -g ${url}`);
  const installing = sys.spin(`Installing ${CLI} ${version}`);
  const removed = name === OLD_PACKAGE ? sys.exec('pnpm', ['remove', '-g', OLD_PACKAGE], { timeoutMs: INSTALL_MS }) : undefined;
  const install = removed === undefined || removed.code === 0 ? sys.exec('pnpm', ['add', '-g', url], { timeoutMs: INSTALL_MS }) : removed;
  installing.stop();
  if (install.code !== 0) {
    if (install.code === 127) {
      io.err(`upgrade: pnpm is not on PATH, so nothing was installed; install pnpm, then run ${UPGRADE} again`);
      return 1;
    }
    io.err(`upgrade: pnpm ${install === removed ? 'remove' : 'add'} -g failed (exit ${install.code}), so ${CLI} is still ${running}:`);
    const said = `${install.stderr}\n${install.stdout}`.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    for (const line of said.slice(-10)) io.err(`  ${line}`);
    if (removed !== undefined && install !== removed) {
      // From the old repository, which has the bridge before the transfer and forwards to it after.
      const back = `${GITHUB_WEB}/${OLD_PRODUCT}/releases/download/v${running}/${tarballName(running, OLD_PACKAGE)}`;
      const restored = sys.exec('pnpm', ['add', '-g', back], { timeoutMs: INSTALL_MS });
      io.err(restored.code === 0 ? `  ${OLD_PACKAGE} ${running} is installed again` : `  putting ${OLD_PACKAGE} ${running} back failed too (exit ${restored.code}); install it with pnpm add -g ${back}`);
    }
    return 1;
  }
  return Math.max(repoint(sys, io), pathCheck(sys, io, version, pnpmBin(sys)));
}

/**
 * Points a launcher an older `machine` wrote, which runs pnpm's
 * process-rules, at the niyam beside it, which a release after P-53 alone
 * installs: without it the hooks would find no CLI and lock GitHub out.
 * Both launchers: the one `machine` writes, and the one it wrote before
 * P-55, which hooks older releases wrote still run. Exit 1 when one runs
 * process-rules and no niyam is there to run.
 */
function repoint(sys: Sys, io: Output): number {
  return Math.max(...[launcherPath(sys.home), launcherPath(sys.home, true)].map((launcher) => repointOne(sys, io, launcher)));
}

function repointOne(sys: Sys, io: Output, launcher: string): number {
  const moved = sys.exists(launcher) ? repointedLauncher(sys.read(launcher)) : undefined;
  if (moved === undefined) return 0;
  if (!sys.exists(moved.command)) {
    io.err(`upgrade: the launcher ${tilde(sys.home, launcher)} runs ${OLD_CLI}, and no ${moved.command} is there to run instead; run ${CLI} machine`);
    return 1;
  }
  sys.write(launcher, moved.text, 0o755);
  io.out(`upgrade: the launcher ${tilde(sys.home, launcher)} now runs ${tilde(sys.home, moved.command)}, not ${OLD_CLI}`);
  return 0;
}

/** The folder pnpm puts global commands in, or undefined when pnpm will not say. */
function pnpmBin(sys: Sys): string | undefined {
  const bin = sys.exec('pnpm', ['bin', '-g'], { timeoutMs: VERSION_MS });
  const dir = bin.stdout.trim();
  return bin.code === 0 && dir.startsWith('/') ? dir.replace(/\/+$/, '') : undefined;
}

/**
 * Copies of the old name, process-rules, in a PATH folder that has no niyam:
 * an older package's, which the shell may run where a hook or the owner types
 * the old name. One package gives both names, so a process-rules beside a
 * niyam is that package's and judged with it.
 */
export function apartCopies(niyams: readonly Copy[], olds: readonly Copy[]): Copy[] {
  const dirs = new Set(niyams.map((copy) => dirOf(copy.path)));
  return olds.filter((copy) => !dirs.has(dirOf(copy.path)));
}

/** The line naming copies of the old name apart from niyam, or none. */
function apartLines(copies: readonly Copy[]): string[] {
  if (copies.length === 0) return [];
  return [
    `${OLD_CLI}, niyam's old name, is on PATH apart from niyam: ${copies.map((copy) => `${copy.path} ${copy.version ?? 'does not run'}`).join(', ')}`,
    `  Remove ${copies.map((copy) => copy.path).join(' and ')}, or uninstall what put ${copies.length === 1 ? 'it' : 'them'} there.`,
  ];
}

/** What is wrong with niyam on PATH, and with its old name where no niyam is beside it. */
function strayBoth(niyams: readonly Copy[], olds: readonly Copy[], wanted: string, bin?: string, install?: string): string[] {
  return [...strayCopies(niyams, wanted, bin === undefined ? undefined : `${bin}/${CLI}`, install), ...apartLines(apartCopies(niyams, olds))];
}

/** Says which niyam the shell now runs; exit 1, naming each copy, when it is not `wanted` alone. */
function pathCheck(sys: Sys, io: Output, wanted: string, bin?: string, install?: string): number {
  // Each copy prints its version once: every check below reads these.
  const niyams = copiesOnPath(sys);
  const stray = strayBoth(niyams, copiesOnPath(sys, OLD_CLI), wanted, bin, install);
  if (stray.length > 0) {
    for (const line of stray) io.err(/^ /.test(line) ? line : `upgrade: ${line}`);
    return 1;
  }
  const [first] = niyams;
  io.out(first === undefined ? `upgrade: no ${CLI} is on PATH; the hooks run the launcher ${CLI} machine writes` : `upgrade: the shell runs ${CLI} ${wanted} (${first.path})`);
  return 0;
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

/**
 * doctor's findings on a Mac about the CLI itself: whether it is the newest
 * release (▲ when a newer one is out, or GitHub cannot say), and ✗ when PATH
 * holds more than one niyam or process-rules, or one that is not this release.
 */
export async function installedFindings(sys: Sys, running: string = packageVersion(), name: string = packageName()): Promise<Finding[]> {
  const newest = await newestRelease(sys);
  const findings: Finding[] = [
    'problem' in newest
      ? { mark: '▲', text: `${CLI} ${running} runs here; ${newest.problem}`, fix: `${CLI} doctor again` }
      : isNewer(newest.version, running)
        ? { mark: '▲', text: `${CLI} ${running} runs here; ${newest.version} is out`, fix: UPGRADE }
        : name === OLD_PACKAGE && isNewer(running, LAST_OLD_RELEASE)
          ? { mark: '▲', text: `${CLI} ${running} runs here, installed as ${OLD_PACKAGE}`, fix: UPGRADE }
          : { mark: '✓', text: `${CLI} ${running}, the newest release` },
  ];
  const copies = copiesOnPath(sys);
  if (strayCopies(copies, running).length > 0) {
    findings.push({
      mark: '✗',
      text: `${CLI} on PATH, the first runs: ${copies.map((copy) => `${tilde(sys.home, copy.path)} ${copy.version ?? 'does not run'}`).join(', ')}`,
      fix: `remove all but one, then ${UPGRADE}`,
    });
  }
  const apart = apartCopies(copies, copiesOnPath(sys, OLD_CLI));
  if (apart.length > 0) {
    findings.push({
      mark: '✗',
      text: `${OLD_CLI} on PATH apart from ${CLI}: ${apart.map((copy) => `${tilde(sys.home, copy.path)} ${copy.version ?? 'does not run'}`).join(', ')}`,
      fix: `remove ${apart.length === 1 ? 'it' : 'them'}, then ${UPGRADE}`,
    });
  }
  return findings;
}
