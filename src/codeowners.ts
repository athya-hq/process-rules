import { SETTINGS_PATH, loadSettings, sameLogin } from './agent.ts';
import type { Sys } from './types.ts';

/** Where GitHub looks for CODEOWNERS, in its order; it uses the first it finds. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** A pattern or owner: a run of non-space characters, a backslash escaping the next one. */
const TOKEN = /(?:\\.|[^\s\\])+/g;

export interface OwnerRules {
  /** The file GitHub uses, relative to the repository. */
  path: string;
  /** The rules naming the owner, by line number from 1. */
  lines: number[];
  /** How many of them name no one else, and so go. */
  dropped: number;
  /** The file with the owner removed from those rules. */
  text: string;
}

/**
 * The rules of a CODEOWNERS file naming `owner` (`@owner`, in any case), and
 * the file without them: the handle goes with the space before it, and a rule
 * left with no owners goes. Team handles, emails, other owners and comments,
 * whole-line or after the owners, stay.
 */
export function withoutOwner(text: string, owner: string): Omit<OwnerRules, 'path'> {
  const lines: number[] = [];
  let dropped = 0;
  const kept: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const tokens = [...line.matchAll(TOKEN)];
    const comment = tokens.findIndex((token) => token[0].startsWith('#'));
    // A line starting with # is a comment; after the pattern, # starts one.
    const owners = comment === 0 ? [] : tokens.slice(1, comment === -1 ? undefined : comment);
    const named = owners.filter((token) => token[0].startsWith('@') && sameLogin(token[0].slice(1), owner));
    if (named.length === 0) {
      kept.push(line);
      continue;
    }
    lines.push(i + 1);
    if (named.length === owners.length) {
      dropped++;
      continue;
    }
    let edited = line;
    for (const token of named.reverse()) {
      const start = token.index;
      const before = start - (/\s*$/.exec(line.slice(0, start))?.[0].length ?? 0);
      edited = edited.slice(0, before) + edited.slice(start + token[0].length);
    }
    kept.push(edited);
  }
  return { lines, dropped, text: kept.join('\n') };
}

/** The rules naming `owner` in the CODEOWNERS file GitHub uses at `root`, if any. */
export function ownerRules(sys: Sys, root: string, owner: string): OwnerRules | undefined {
  const path = CODEOWNERS_PATHS.find((candidate) => sys.exists(`${root}/${candidate}`));
  if (!path) return undefined;
  const found = withoutOwner(sys.read(`${root}/${path}`), owner);
  return found.lines.length > 0 ? { path, ...found } : undefined;
}

/** What such rules do once the agent authors the pull requests. */
export function ownerRulesProblem(rules: OwnerRules, owner: string, agent: string): string {
  const where = rules.lines.length === 1 ? `a rule (line ${rules.lines[0]})` : `${rules.lines.length} rules (lines ${rules.lines.join(', ')})`;
  return (
    `${rules.path} names ${owner} in ${where}: GitHub will ask ${owner} to review every pull request ${agent} opens, ` +
    `because ${agent} authors them and GitHub never asks a pull request's author`
  );
}

/** For doctor: the problem in the adopting repository around the working directory, when its settings name `agent`. */
export function ownerRulesHere(sys: Sys, agent: string): string | undefined {
  const top = sys.exec('git', ['rev-parse', '--show-toplevel'], { cwd: sys.cwd });
  const root = top.stdout.trim();
  if (top.code !== 0 || !sys.exists(`${root}/${SETTINGS_PATH}`)) return undefined;
  let settings;
  try {
    settings = loadSettings(sys, root);
  } catch {
    return undefined;
  }
  if (!sameLogin(settings.agent, agent)) return undefined;
  const rules = ownerRules(sys, root, settings.owner);
  return rules && `${ownerRulesProblem(rules, settings.owner, agent)}; run process-rules onboard to remove ${settings.owner} from them`;
}
