import { isAbsolute, relative, resolve } from 'node:path';

import { SETTINGS_PATH } from './agent.ts';
import type { Output, Sys } from './types.ts';

/**
 * Records a dismissal of a Cubic review finding: one the agent proves wrong, or one the owner chose. A dismissal
 * is a dated `#` comment and the finding's exact title appended to the client's dismiss file, committed alone, so
 * the commit is the record. `--evidence` names what proves the finding wrong (a path at HEAD, a commit HEAD
 * contains, or a title already dismissed) and must resolve; `--decision` cites where the owner chose. Each commit
 * carries a `Dismissal-Basis` trailer, so `git log --grep "Dismissal-Basis: evidence" -p -- <file>` lists every call
 * the agent made alone. A true finding left unfixed is the owner's call, so words that say so are refused on
 * evidence.
 *
 * It writes the dismiss file and nothing else: it refuses one that already differs from HEAD, commits with `--only`
 * so nothing else staged rides along, runs every hook, prints their output, and restores the file when the commit
 * fails.
 */

export interface Dismissal {
  readonly title: string;
  readonly reason: string;
}

export interface DismissOptions {
  readonly dismissals: readonly Dismissal[];
  /** `evidence`: the agent proves the finding wrong; `decision`: the owner chose. */
  readonly basis: 'evidence' | 'decision';
  /** For evidence, what proves it; for a decision, where the owner chose. */
  readonly cite: string;
  readonly context?: string;
}

/** What the command line says: the titles given there, and the file that holds more. */
export type DismissArgs = Omit<DismissOptions, 'dismissals'> & { readonly titles: Dismissal[]; readonly from?: string };

/** What `.github/niyam.json`'s `"cubicDismiss"` names, with its defaults. */
export interface DismissSettings {
  /** The dismiss file, by its path in the repository. */
  file: string;
  /** The commit's subject; `{count}` is the number of findings and `{s}` an "s" for more than one. */
  subject: string;
  /** The trailer's word for an owner's decision. */
  ownerBasis: string;
}

const DEFAULTS: DismissSettings = { file: '.cubic-dismiss', subject: 'chore(review): dismiss {count} Cubic finding{s}', ownerBasis: 'owner' };
const WIDTH = 78;
const where = `${SETTINGS_PATH}: "cubicDismiss"`;

/** The settings, its defaults filled in; throws on a malformed entry. */
export function dismissSettings(raw: unknown): DismissSettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).cubicDismiss : undefined;
  if (value === undefined) return { ...DEFAULTS };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  const { file = DEFAULTS.file, subject = DEFAULTS.subject, ownerBasis = DEFAULTS.ownerBasis, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new Error(`${where} has an unknown key "${extra}"; it takes "file", "subject" and "ownerBasis"`);
  if (typeof file !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@+=,.\/-]+$/.test(file)) throw new Error(`${where}.file must be a path in the repository`);
  if (typeof subject !== 'string' || !subject.trim() || /[\r\n]/.test(subject)) throw new Error(`${where}.subject must be one line`);
  if (typeof ownerBasis !== 'string' || !/^[a-z][\w-]*$/.test(ownerBasis) || ownerBasis === 'evidence') throw new Error(`${where}.ownerBasis must be one lower-case word other than "evidence"`);
  return { file, subject, ownerBasis };
}

const USAGE = 'cubic-dismiss (--evidence <what proves it wrong> | --decision <where the owner chose>) ((--title <exact title> --reason <why>)... | --from <file.json>) [--context <work id>]';

/** The arguments: one basis, and titles paired in order with their reasons, from argv or a file. */
export function dismissArgs(args: readonly string[]): DismissArgs {
  const titles: string[] = [];
  const reasons: string[] = [];
  const once = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (!['--evidence', '--decision', '--title', '--reason', '--from', '--context'].includes(name)) throw new Error(`unexpected argument "${token}"`);
    const value = eq > 0 ? token.slice(eq + 1) : args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    if (name === '--title') titles.push(value);
    else if (name === '--reason') reasons.push(value);
    else if (once.has(name)) throw new Error(`${name} is given twice`);
    else once.set(name, value);
  }
  if (titles.length !== reasons.length) throw new Error('each --title needs its own --reason');
  const evidence = once.get('--evidence');
  const decision = once.get('--decision');
  if ((evidence === undefined) === (decision === undefined)) throw new Error(`give exactly one of --evidence or --decision: ${USAGE}`);
  const flag = evidence === undefined ? '--decision' : '--evidence';
  const cite = (evidence ?? decision) as string;
  if (!cite.trim()) throw new Error(`${flag} is blank`);
  const context = once.get('--context');
  // Both land in a comment line; a line break would start an active title.
  for (const [name, value] of [[flag, cite], ['--context', context]] as const) {
    if (value !== undefined && /[\r\n]/.test(value)) throw new Error(`${name} spans lines`);
  }
  const from = once.get('--from');
  if (titles.length === 0 && from === undefined) throw new Error(`nothing to dismiss: ${USAGE}`);
  return {
    titles: titles.map((title, index) => ({ title, reason: reasons[index] as string })),
    basis: evidence === undefined ? 'decision' : 'evidence',
    cite,
    ...(context === undefined ? {} : { context }),
    ...(from === undefined ? {} : { from }),
  };
}

const FROM_SHAPE = '--from must hold a JSON array of { "title", "reason" } strings';

/** `--from`'s findings: a JSON array of `{ title, reason }`. */
export function parseFrom(text: string): Dismissal[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${FROM_SHAPE}; it is not JSON`);
  }
  if (!Array.isArray(json) || !json.every((one) => typeof one?.title === 'string' && typeof one.reason === 'string')) throw new Error(FROM_SHAPE);
  return (json as Dismissal[]).map(({ title, reason }) => ({ title, reason }));
}

/** The titles a dismiss file holds: every line that is neither blank nor a comment. */
export function parseDismissals(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line !== '' && !line.startsWith('#')),
  );
}

/** Words that mark a true finding left unfixed: the owner's call, never the agent's on evidence. */
const DEFERRED = /pre-?existing|predates|out of scope|\blater\b|follow-?up/i;

/** Why a finding cannot be dismissed, or null when it can; the deferral words are looked for in what the agent wrote, not in the title. */
export function refusal(dismissal: Dismissal, dismissed: ReadonlySet<string>, options: DismissOptions): string | null {
  const { title, reason } = dismissal;
  if (title.trim() === '') return 'a title is empty';
  if (/[\r\n]/.test(title)) return `"${title}" spans lines; a dismissal is one line`;
  if (title.startsWith('#')) return `"${title}" starts with #, which the dismiss file reads as a comment`;
  if (reason.trim() === '') return `"${title}" has no reason`;
  if (dismissed.has(title)) return `"${title}" is already dismissed`;
  const deferred = options.basis === 'evidence' ? DEFERRED.exec([reason, options.cite, options.context ?? ''].join('\n')) : null;
  if (deferred) return `"${title}": the reason, evidence or context says "${deferred[0]}": a true finding left unfixed is the owner's call; use --decision`;
  return null;
}

/**
 * Whether evidence names something there: a title already dismissed, a commit HEAD contains named by its full
 * 40-hex id, or a path at HEAD (a trailing `#section` or `:line` dropped). Seven to 39 hex digits read as an
 * abbreviated commit and resolve as nothing, so one is never taken for a path. git failing throws, never reading
 * as evidence that does not resolve.
 */
export function resolves(cite: string, dismissed: ReadonlySet<string>, git: (args: string[]) => string): boolean {
  if (dismissed.has(cite)) return true;
  if (/^[0-9a-f]{40}$/i.test(cite)) {
    if (git(['rev-list', '--no-walk', '--ignore-missing', cite]).trim() === '') return false;
    return git(['rev-list', '-n', '1', cite, '^HEAD']).trim() === '';
  }
  if (/^[0-9a-f]{7,39}$/i.test(cite)) return false;
  const path = cite.replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '');
  // Only plain repository-relative segments: no root, `.`, `..`, empty segment, leading `-` or revision syntax.
  if (!path.split('/').every((segment) => /^(?!\.+$)(?!-)[\w@+=,.-]+$/.test(segment))) return false;
  return git(['ls-tree', '--full-tree', '--name-only', 'HEAD', '--', path]).trim() !== '';
}

/** One dismissal as dismiss-file lines: the dated reason, wrapped, then the title. */
export function formatEntry(dismissal: Dismissal, date: string, options: DismissOptions): string[] {
  const basis = options.basis === 'evidence' ? `evidence: ${options.cite}` : options.cite;
  const cited = [options.context, basis].filter(Boolean).join('; ');
  const lines: string[] = [];
  let line = `# ${date} (${cited}):`;
  for (const word of dismissal.reason.split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = '#';
    }
    line += ` ${word}`;
  }
  return [...lines, line, dismissal.title];
}

const clip = (text: string): string => (text.length > 96 ? `${text.slice(0, 93)}...` : text);

/** The subject, a body citing the basis and listing up to 12 titles, and the trailer. */
export function commitMessage(options: DismissOptions, settings: DismissSettings): { subject: string; body: string; trailer: string } {
  const count = options.dismissals.length;
  const subject = settings.subject.replaceAll('{count}', String(count)).replaceAll('{s}', count === 1 ? '' : 's');
  const titles = options.dismissals.slice(0, 12).map(({ title }) => `- ${clip(title)}`);
  const label = options.basis === 'evidence' ? 'Evidence' : 'Decision';
  return {
    subject,
    body: [clip(`${label}: ${options.cite}`), ...titles].join('\n'),
    trailer: `Dismissal-Basis: ${options.basis === 'evidence' ? 'evidence' : settings.ownerBasis}`,
  };
}

function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `niyam cubic-dismiss`: appends, stages the dismiss file alone and commits it; 0 committed, 1 refused or failed. */
export function cubicDismiss(sys: Sys, io: Output, args: readonly string[]): number {
  const parsed = dismissArgs(args);
  const git = (gitArgs: string[], cwd = sys.cwd): string => {
    const run = sys.exec('git', gitArgs, { cwd });
    if (run.code !== 0) throw new Error(`git ${gitArgs[0]} failed: ${run.stderr.trim() || `exit ${run.code}`}`);
    return run.stdout;
  };
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const run = (gitArgs: string[]): string => git(gitArgs, root);
  const settingsFile = `${root}/${SETTINGS_PATH}`;
  const settings = dismissSettings(sys.exists(settingsFile) ? JSON.parse(sys.read(settingsFile)) : {});
  let fromFile: Dismissal[] = [];
  if (parsed.from !== undefined) {
    // Its titles are committed and pushed, and the allow rule runs this without a prompt: only a file in the repository.
    const at = resolve(sys.cwd, parsed.from);
    const inside = relative(root, at);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
      io.err(`✗ --from must be a file in the repository: ${parsed.from}`);
      return 1;
    }
    fromFile = parseFrom(sys.read(at));
  }
  const { titles, from: _from, ...rest } = parsed;
  const options: DismissOptions = { ...rest, dismissals: [...titles, ...fromFile] };
  if (options.dismissals.length === 0) {
    io.err(`✗ ${parsed.from} holds nothing to dismiss`);
    return 1;
  }
  const file = settings.file;
  const path = `${root}/${file}`;
  const changed = run(['status', '--porcelain', '--', file]).trim();
  if (changed) {
    io.err(`✗ ${file} already differs from HEAD (${changed}); commit or restore it first`);
    return 1;
  }
  // The first dismissal starts the file; undone, it is removed, since an empty file left behind is untracked.
  const existed = sys.exists(path);
  const before = existed ? sys.read(path) : '';
  const dismissed = parseDismissals(before);
  if (options.basis === 'evidence' && !resolves(options.cite, dismissed, run)) {
    io.err(`✗ refused: --evidence "${options.cite}" is no path at HEAD, commit HEAD contains (by its full 40-hex id), or dismissed title; nothing was written`);
    return 1;
  }
  for (const dismissal of options.dismissals) {
    const why = refusal(dismissal, dismissed, options);
    if (why !== null) {
      io.err(`✗ refused: ${why}; nothing was written`);
      return 1;
    }
    dismissed.add(dismissal.title);
  }
  const added = options.dismissals.flatMap((dismissal) => formatEntry(dismissal, localDate(sys.now()), options));
  const written = `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${added.join('\n')}\n`;
  const head = run(['rev-parse', 'HEAD']).trim();
  sys.write(path, written);
  // A commit that landed is kept even when git reports a failure; only one that did not is undone, and a cleanup
  // that cannot finish is named, so a leftover line is never taken as recorded: a rerun refuses a changed file.
  const undo = (): void => {
    let now: string;
    try {
      now = run(['rev-parse', 'HEAD']).trim();
      if (now === head) {
        if (existed) sys.write(path, before);
        else sys.remove(path);
        run(['reset', '-q', 'HEAD', '--', file]);
        const left = run(['status', '--porcelain', '--', file]).trim();
        io.err(left ? `✗ the commit failed and ${file} still differs from HEAD (${left}); check git status and git log` : `✗ the commit failed; ${file} is restored`);
        return;
      }
    } catch (error) {
      io.err(`✗ the commit failed and restoring ${file} failed too (${error instanceof Error ? error.message : String(error)}); it may still hold the new lines: check git status`);
      return;
    }
    io.err(`✗ git reported a failure, but the commit landed (${now}); ${file} is left as committed: check git log`);
  };
  const { subject, body, trailer } = commitMessage(options, settings);
  let committed: { code: number; stdout: string; stderr: string };
  try {
    run(['add', '--', file]);
    committed = sys.exec('git', ['commit', '--only', '-m', subject, '-m', body, '-m', trailer, '--', file], { cwd: root });
  } catch (error) {
    undo();
    throw error;
  }
  const output = `${committed.stdout}${committed.stderr}`.trimEnd();
  if (output) io.out(output);
  if (committed.code !== 0) {
    undo();
    return 1;
  }
  // Nothing locks the file, so a process writing it meanwhile would have its text committed: never report success
  // for text this did not write. A read-back that cannot run leaves the landed commit standing, named.
  let recorded: string;
  try {
    recorded = run(['show', `HEAD:${file}`]);
  } catch {
    io.err(`! committed, but ${file} could not be read back from HEAD to check it: check git show HEAD`);
    return 0;
  }
  if (recorded !== written) {
    io.err(`✗ the commit holds a ${file} this did not write; something changed it meanwhile: check git show HEAD`);
    return 1;
  }
  io.out(`✓ committed ${options.dismissals.length} dismissal(s) alone`);
  return 0;
}
