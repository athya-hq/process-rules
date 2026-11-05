import type { Output, Sys } from './types.ts';

/**
 * The terminal layout `onboard`, `machine` and `doctor` share, after
 * `@clack/prompts`: a ◆ header, ◇ groups of short lines behind a │ bar, one
 * line per step, and └ to close. The prompts and the spinner themselves
 * come from `sys.choose` and `sys.spin`, which load `@clack/prompts` only
 * when they run.
 */

/** Colours for the terminal's marks. */
export interface Paint {
  dim(text: string): string;
  accent(text: string): string;
  done(text: string): string;
  failed(text: string): string;
  warn(text: string): string;
}

/**
 * Colours only when a person is at a terminal that has colours, and never
 * with NO_COLOR set (https://no-color.org).
 */
export function painter(sys: Sys): Paint {
  const on = sys.tty && !sys.env.NO_COLOR && !!sys.env.TERM && sys.env.TERM !== 'dumb';
  const paint = (code: number) => (text: string): string => (on ? `\u001b[${code}m${text}\u001b[0m` : text);
  return { dim: paint(2), accent: paint(36), done: paint(32), failed: paint(31), warn: paint(33) };
}

/** One line of a plan: a short label, and what changes there. */
export interface Item {
  label: string;
  detail?: string;
}

/** A ◇ group of a plan. */
export interface Group {
  title: string;
  items: Item[];
}

/** The run's first line: the command, then what it is about. */
export function heading(paint: Paint, command: string, about: string): string {
  return `${paint.accent('◆')}  process-rules ${command}   ${about}`;
}

/** The lines of `head`, then each group that lists something, its labels lined up, then a bar. */
export function planLines(paint: Paint, head: string[], groups: Group[]): string[] {
  const bar = paint.dim('│');
  const lines = [...head];
  for (const { title, items } of groups) {
    if (items.length === 0) continue;
    const width = Math.max(...items.map((item) => (item.detail ? item.label.length : 0)));
    lines.push(bar, `${paint.done('◇')}  ${title}`, ...items.map((item) => `${bar}    ${item.detail ? `${item.label.padEnd(width)}  ${item.detail}` : item.label}`));
  }
  lines.push(bar);
  return lines;
}

/** How a check or a finding stands: ✓ fine, ▲ worth fixing, ✗ broken. */
export type Mark = '✓' | '▲' | '✗';

/** One finding: what is so, and, for a problem, the one command or step that fixes it. */
export interface Finding {
  mark: Mark;
  text: string;
  fix?: string;
}

/** A finding as one line: its mark, what is so, and → its fix. */
export function findingLine(paint: Paint, { mark, text, fix }: Finding): string {
  const colour = { '✓': paint.done, '▲': paint.warn, '✗': paint.failed }[mark];
  return `${colour(mark)}  ${text}${fix ? ` ${paint.dim('→')} ${fix}` : ''}`;
}

/** A ◇ group of findings, after a bar; nothing when it has none. */
export function findingLines(paint: Paint, title: string, findings: Finding[]): string[] {
  if (findings.length === 0) return [];
  return [paint.dim('│'), `${paint.done('◇')}  ${title}`, ...findings.map((finding) => findingLine(paint, finding))];
}

/** The run's last line. */
export function closing(paint: Paint, text: string): string {
  return `${paint.dim('└')}  ${text}`;
}

/** `path` with the home folder as ~, as the person would type it. */
export function tilde(home: string, path: string): string {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Runs `work` with a spinner by `label` on the terminal, taken off when it ends, however it ends. */
export async function spinning<T>(sys: Sys, label: string, work: () => Promise<T>): Promise<T> {
  const spinner = sys.spin(label);
  try {
    return await work();
  } finally {
    spinner.stop();
  }
}

/**
 * Runs one step after the yes, with a spinner, and shows it as one line: ◇
 * when it worked, ■ when it failed, followed then by what it said before it
 * failed. What it says on error goes to standard error either way, and a
 * step that throws shows as failed before the error goes on. With no `run`,
 * the step fails without running.
 */
export async function runStep(
  sys: Sys,
  io: Output,
  paint: Paint,
  label: string,
  run?: (out: Output) => Promise<boolean>,
): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];
  const errors: string[] = [];
  let ok = false;
  try {
    ok = run ? await spinning(sys, label, () => run({ out: (line) => log.push(line), err: (line) => errors.push(line) })) : false;
  } finally {
    // A step that throws still shows as failed, with what it said first.
    io.out(`${ok ? paint.done('◇') : paint.failed('■')}  ${label}`);
    if (!ok) for (const line of log) io.out(`${paint.dim('│')}  ${line.trim()}`);
    for (const line of errors) io.err(line);
  }
  return { ok, log };
}
