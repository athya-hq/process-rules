/**
 * The product's names. process-rules became niyam (docs/decisions.md, P-49):
 * the old names are still read, and still run, for at least one release.
 */

/** The command, and the one it was before, which only the bridge archive still installs (P-54). */
export const CLI = 'niyam';
export const OLD_CLI = 'process-rules';

/** The product's GitHub repository, and the one GitHub forwards to it. */
export const PRODUCT = 'veda-hq/niyam';
export const OLD_PRODUCT = 'athya-hq/process-rules';

/** The package, and the old name the bridge release carries for 0.6.x's `upgrade`. */
export const PACKAGE = '@veda-hq/niyam';
export const OLD_PACKAGE = '@athya-hq/process-rules';

/** The file `pnpm pack` makes of a package at a version, which a release attaches. */
export function tarballName(version: string, pkg: string = PACKAGE): string {
  return `${pkg.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** This Mac's files, under the home folder: the agents' folders, the session records, the locked gh folder and the launcher. */
export const CONFIG_DIR = '.config/niyam';

/** The variable naming the agent in an agent session's shells. */
export const AGENT_VAR = 'NIYAM_AGENT';
