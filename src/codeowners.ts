import { SETTINGS_PATH, anyLogin, loadSettings } from './agent.ts';
import type { Sys } from './types.ts';

/** Where GitHub looks for CODEOWNERS, in its order; it uses the first it finds. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** A pattern or owner: a run of non-space characters, a backslash escaping the next one. */
const TOKEN = /(?:\\.|[^\s\\])+/g;

export interface OwnerRules {
  /** The file GitHub uses, relative to the repository. */
  path: string;
  /** The owners those rules name, as the settings spell them. */
  owners: string[];
  /** The rules naming an owner, by line number from 1. */
  lines: number[];
  /** How many of them name no one else, and so go. */
  dropped: number;
  /** The file with the owners removed from those rules. */
  text: string;
}

/**
 * The rules of a CODEOWNERS file naming any of `owners` (`@owner`, in any
 * case), and the file without them: the handle goes with the space before it, and a rule
 * left with no owners goes, so its paths fall to the rules before it. Team handles, emails, other owners and comments,
 * whole-line or after the owners, stay.
 */
export function withoutOwner(text: string, owners: readonly string[]): Omit<OwnerRules, 'path'> {
  const lines: number[] = [];
  const handles = new Set<string>();
  let dropped = 0;
  const kept: string[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    const tokens = [...line.matchAll(TOKEN)];
    const comment = tokens.findIndex((token) => token[0].startsWith('#'));
    // A line starting with # is a comment; after the pattern, # starts one.
    const listed = comment === 0 ? [] : tokens.slice(1, comment === -1 ? undefined : comment);
    const named = listed.filter((token) => token[0].startsWith('@') && anyLogin(owners, token[0].slice(1)));
    for (const token of named) handles.add(token[0].slice(1).toLowerCase());
    if (named.length === 0) {
      kept.push(line);
      continue;
    }
    lines.push(i + 1);
    if (named.length === listed.length) {
      dropped++;
      continue;
    }
    let edited = line;
    for (const token of named.reverse()) {
      // From the end of the token before, so a pattern ending in an escaped space keeps it.
      const previous = tokens[tokens.indexOf(token) - 1];
      const before = previous ? previous.index + previous[0].length : token.index;
      edited = edited.slice(0, before) + edited.slice(token.index + token[0].length);
    }
    kept.push(edited);
  }
  return { owners: owners.filter((owner) => handles.has(owner.toLowerCase())), lines, dropped, text: kept.join('\n') };
}

/** The rules naming any of `owners` in the CODEOWNERS file GitHub uses at `root`, if any. */
export function ownerRules(sys: Sys, root: string, owners: readonly string[]): OwnerRules | undefined {
  const path = CODEOWNERS_PATHS.find((candidate) => sys.exists(`${root}/${candidate}`));
  if (!path) return undefined;
  const found = withoutOwner(sys.read(`${root}/${path}`), owners);
  return found.lines.length > 0 ? { path, ...found } : undefined;
}

/** What such rules do once the agent authors the pull requests. */
export function ownerRulesProblem(rules: OwnerRules, agent: string): string {
  const owner = rules.owners.join(' and ');
  const where = rules.lines.length === 1 ? `a rule (line ${rules.lines[0]})` : `${rules.lines.length} rules (lines ${rules.lines.join(', ')})`;
  return (
    `${rules.path} names ${owner} in ${where}: GitHub will ask ${owner} to review every pull request ${agent} opens that changes a file ${rules.lines.length === 1 ? 'it matches' : 'they match'}, ` +
    `because ${agent} authors them and GitHub never asks a pull request's author`
  );
}

/** For doctor: the problem in the adopting repository around the working directory, when its settings name `agent` as an agent. */
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
  if (!anyLogin(settings.agents, agent)) return undefined;
  const rules = ownerRules(sys, root, settings.owners);
  return rules && `${ownerRulesProblem(rules, agent)}; run process-rules onboard to remove ${rules.owners.join(' and ')} from them`;
}
