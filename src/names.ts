/**
 * The product's names. process-rules became niyam (docs/decisions.md, P-49),
 * and since P-57 no release reads or writes the old names; what still says
 * process-rules, and why, is in the README.
 */

/** The command. */
export const CLI = 'niyam';

/** The product's GitHub repository. */
export const PRODUCT = 'veda-hq/niyam';

/** The package. */
export const PACKAGE = '@veda-hq/niyam';

/** The file `pnpm pack` makes of the package at a version, which a release attaches. */
export function tarballName(version: string): string {
  return `${PACKAGE.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** This Mac's files, under the home folder: the agents' folders, the session records, the locked gh folder and the launcher. */
export const CONFIG_DIR = '.config/niyam';

/** The variable naming the agent in an agent session's shells. */
export const AGENT_VAR = 'NIYAM_AGENT';
