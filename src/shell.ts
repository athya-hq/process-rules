/**
 * Enough of a shell's reading of a command line to see the text a command
 * would be given: its words, with quotes, escapes and heredocs worked out.
 * A part whose text only the running shell knows, a variable or a command
 * substitution other than `cat` of a heredoc or a file, is marked unknown
 * rather than guessed.
 */

/** Text the command line spells out; `known` is false where some of it only the running shell knows. */
export interface Text {
  text: string;
  known: boolean;
  /** Whether the text starts with a part only the running shell knows. */
  opensUnknown: boolean;
}

/** One simple command: its words and, when a heredoc, here-string or `<` file feeds it, its standard input. */
export interface Simple {
  words: Text[];
  stdin?: Text;
}

/** Reads a file the command line names, relative to where it runs; undefined when there is none. */
export type ReadFile = (path: string) => string | undefined;

/** Stands in, in a word's text, for a part only the running shell knows. */
export const UNKNOWN = '\u0000';

const UNREAD: Text = { text: '', known: false, opensUnknown: true };

interface Builder {
  text: string;
  known: boolean;
  opensUnknown: boolean;
  started: boolean;
}

const fresh = (): Builder => ({ text: '', known: true, opensUnknown: false, started: false });

type Append = (text: string, known?: boolean) => void;

class Reader {
  pos = 0;
  /** Heredocs waiting for the next line break, each with the command it feeds. */
  private readonly pending: { delimiter: string; strip: boolean; quoted: boolean; into: Simple }[] = [];
  /** The commands run inside $(…) and backquotes, which the shell runs too. */
  readonly nested: Simple[] = [];

  private readonly src: string;
  private readonly read: ReadFile;

  constructor(src: string, read: ReadFile) {
    this.src = src;
    this.read = read;
  }

  /** The commands up to the end, or up to the `)` closing a `$(` when `nested`. */
  list(nested: boolean): Simple[] {
    const commands: Simple[] = [];
    let current: Simple = { words: [] };
    let word = fresh();
    const endWord = (): void => {
      if (word.started) current.words.push({ text: word.text, known: word.known, opensUnknown: word.opensUnknown });
      word = fresh();
    };
    const endCommand = (): void => {
      endWord();
      if (current.words.length > 0) commands.push(current);
      current = { words: [] };
    };
    const append: Append = (text, known = true) => {
      if (word.text === '' && !known) word.opensUnknown = true;
      word.started = true;
      word.text += known ? text : UNKNOWN;
      if (!known) word.known = false;
    };
    const src = this.src;
    while (this.pos < src.length) {
      const c = src[this.pos] as string;
      if (c === ' ' || c === '\t') {
        endWord();
        this.pos++;
      } else if (c === '\n') {
        // A command's heredocs start on the line after it.
        endWord();
        this.pos++;
        this.heredocs();
        endCommand();
      } else if (c === ')' && nested) {
        this.pos++;
        endCommand();
        return commands;
      } else if (';&|()'.includes(c)) {
        endCommand();
        this.pos++;
      } else if (c === '#' && !word.started) {
        while (this.pos < src.length && src[this.pos] !== '\n') this.pos++;
      } else if (c === '<' || c === '>') {
        // A file descriptor's number, as in 2>&1, belongs to the redirection.
        if (word.known && /^\d+$/.test(word.text)) word = fresh();
        else endWord();
        this.redirect(current);
      } else if (c === "'") {
        const end = src.indexOf("'", this.pos + 1);
        const stop = end < 0 ? src.length : end;
        append(src.slice(this.pos + 1, stop));
        this.pos = stop + 1;
      } else if (c === '"') {
        this.pos++;
        this.doubleQuoted(append);
      } else if (c === '\\') {
        const next = src[this.pos + 1];
        if (next !== undefined && next !== '\n') append(next);
        this.pos += 2;
      } else if (c === '$') {
        this.dollar(append, false);
      } else if (c === '`') {
        this.backquoted();
        append('', false);
      } else {
        append(c);
        this.pos++;
      }
    }
    endCommand();
    return commands;
  }

  /** Inside double quotes, from just past the opening one to just past the closing one. */
  private doubleQuoted(append: Append): void {
    const src = this.src;
    append('');
    while (this.pos < src.length && src[this.pos] !== '"') {
      const c = src[this.pos] as string;
      if (c === '\\' && /["\\$`\n]/.test(src[this.pos + 1] ?? '')) {
        if (src[this.pos + 1] !== '\n') append(src[this.pos + 1] as string);
        this.pos += 2;
      } else if (c === '$') {
        this.dollar(append, true);
      } else if (c === '`') {
        this.backquoted();
        append('', false);
      } else {
        append(c);
        this.pos++;
      }
    }
    this.pos++;
  }

  /** A `$` expansion: `$(…)` worked out where it can be, `$'…'` read, anything else unknown. */
  private dollar(append: Append, quoted: boolean): void {
    const src = this.src;
    const next = src[this.pos + 1];
    if (next === '(' && src[this.pos + 2] === '(') {
      this.pos = closing(src, this.pos + 3, '((', '))');
      append('', false);
    } else if (next === '(') {
      this.pos += 2;
      const inner = this.list(true);
      this.nested.push(...inner);
      const value = this.substitution(inner);
      if (value === undefined) append('', false);
      else append(value);
    } else if (next === '{') {
      this.pos = closing(src, this.pos + 2, '{', '}');
      append('', false);
    } else if (next === "'" && !quoted) {
      this.pos += 2;
      let text = '';
      while (this.pos < src.length && src[this.pos] !== "'") {
        if (src[this.pos] === '\\' && this.pos + 1 < src.length) {
          const escaped = src[this.pos + 1] as string;
          text += ({ n: '\n', t: '\t' } as Record<string, string>)[escaped] ?? escaped;
          this.pos += 2;
        } else {
          text += src[this.pos];
          this.pos++;
        }
      }
      this.pos++;
      append(text);
    } else if (next !== undefined && /[\w@*#?$!-]/.test(next)) {
      this.pos += 2;
      if (/[A-Za-z_]/.test(next)) while (/\w/.test(src[this.pos] ?? '')) this.pos++;
      append('', false);
    } else {
      append('$');
      this.pos++;
    }
  }

  /** What `$(…)` gives, when it is `cat` of a heredoc or a file; undefined otherwise. */
  private substitution(inner: Simple[]): string | undefined {
    const [only] = inner;
    if (inner.length !== 1 || !only || !only.words.every((word) => word.known)) return undefined;
    const [command, file, extra] = only.words.map((word) => word.text);
    if (command !== 'cat' || extra !== undefined) return undefined;
    const text = file !== undefined ? this.read(file) : only.stdin?.known ? only.stdin.text : undefined;
    // A substitution drops the newlines its output ends with.
    return text?.replace(/\n+$/, '');
  }

  /** From an opening backquote to just past its closing one: its output stays unknown, but the commands it runs are kept. */
  private backquoted(): void {
    const src = this.src;
    const start = ++this.pos;
    while (this.pos < src.length && src[this.pos] !== '`') this.pos += src[this.pos] === '\\' ? 2 : 1;
    const inner = new Reader(src.slice(start, this.pos).replace(/\\([`\\$])/g, '$1'), this.read);
    this.nested.push(...inner.list(false), ...inner.nested);
    this.pos++;
  }

  /** A redirection at `<` or `>`: heredocs, here-strings and `<` files feed `into`; the rest is skipped. */
  private redirect(into: Simple): void {
    const src = this.src;
    if (src.startsWith('<<<', this.pos)) {
      this.pos += 3;
      const word = this.word();
      into.stdin = { known: word.known, opensUnknown: word.opensUnknown, text: `${word.text}\n` };
      return;
    }
    if (src.startsWith('<<', this.pos)) {
      this.pos += 2;
      const strip = src[this.pos] === '-';
      if (strip) this.pos++;
      const word = this.word();
      // The shell does not expand a delimiter; it only takes its quotes off.
      const delimiter = word.raw.replace(/\\(.)/g, '$1').replace(/['"]/g, '');
      this.pending.push({ delimiter, strip, quoted: /['"\\]/.test(word.raw), into });
      return;
    }
    const input = src[this.pos] === '<' && src[this.pos + 1] !== '&';
    this.pos++;
    while (/[<>&|]/.test(src[this.pos] ?? '')) this.pos++;
    const target = this.word();
    if (input) {
      const text = target.known ? this.read(target.text) : undefined;
      into.stdin = text === undefined ? UNREAD : { text, known: true, opensUnknown: false };
    }
  }

  /** The next word, past blanks: a redirection's target or a heredoc's delimiter, with how it was written. */
  private word(): Text & { raw: string } {
    const src = this.src;
    while (src[this.pos] === ' ' || src[this.pos] === '\t') this.pos++;
    const start = this.pos;
    let quote: string | undefined;
    while (this.pos < src.length) {
      const c = src[this.pos] as string;
      if (quote) {
        if (c === quote) quote = undefined;
        else if (c === '\\' && quote === '"') this.pos++;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === '\\') this.pos++;
      else if (/[\s;&|()<>]/.test(c)) break;
      this.pos++;
    }
    const raw = src.slice(start, this.pos);
    const first = new Reader(raw, this.read).list(false)[0]?.words[0];
    return { ...(first ?? { text: '', known: true, opensUnknown: false }), raw };
  }

  /** At a line break: the bodies of the heredocs the line opened, each given to its command. */
  private heredocs(): void {
    const src = this.src;
    for (const doc of this.pending.splice(0)) {
      const lines: string[] = [];
      while (this.pos < src.length) {
        const end = src.indexOf('\n', this.pos);
        const line = src.slice(this.pos, end < 0 ? src.length : end);
        this.pos = end < 0 ? src.length : end + 1;
        const bare = doc.strip ? line.replace(/^\t+/, '') : line;
        if (bare === doc.delimiter) break;
        lines.push(bare);
      }
      const text = lines.map((line) => `${line}\n`).join('');
      // An unquoted delimiter lets the shell expand the body; a body with nothing to expand reads the same.
      const expands = !doc.quoted && /\$[\w{(@*#?!-]|`/.test(text);
      doc.into.stdin = { text, known: !expands, opensUnknown: expands && /^\s*[$`]/.test(text) };
    }
  }
}

/** Just past the `close` that matches the `open` before `from`, counting nested pairs. */
function closing(src: string, from: number, open: string, close: string): number {
  let depth = 1;
  let at = from;
  while (at < src.length) {
    if (src.startsWith(close, at)) {
      depth--;
      at += close.length;
      if (depth === 0) return at;
    } else if (src.startsWith(open, at)) {
      depth++;
      at += open.length;
    } else at++;
  }
  return at;
}

/**
 * The simple commands a command line runs, read as a shell would: those
 * inside `$(…)` and backquotes, and a nested `sh -c` (or `bash -lc`)
 * script's, included.
 */
export function commands(line: string, read: ReadFile): Simple[] {
  const found: Simple[] = [];
  const reader = new Reader(line, read);
  const top = reader.list(false);
  for (const simple of [...top, ...reader.nested]) {
    found.push(simple);
    const words = simple.words;
    const shell = words.findIndex((word) => /^(?:.*\/)?(?:ba|z|da)?sh$/.test(word.text));
    const script = shell < 0 ? -1 : words.findIndex((word, at) => at > shell && /^-[A-Za-z]*c[A-Za-z]*$/.test(word.text));
    const body = script < 0 ? undefined : words[script + 1];
    if (body?.known) found.push(...commands(body.text, read));
  }
  return found;
}
