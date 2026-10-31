/**
 * Small edits to JSON text that keep everything else as it was: the client's
 * own layout, spacing and key order. Only well-formed JSON objects are read.
 */

interface Span {
  start: number;
  end: number;
}

const skipSpace = (text: string, at: number): number => {
  while (at < text.length && /\s/.test(text[at] as string)) at++;
  return at;
};

/** The end of the JSON value starting at `at`. */
function valueEnd(text: string, at: number): number {
  const first = text[at];
  if (first === '"') {
    let i = at + 1;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    return i + 1;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let i = at; i < text.length; i++) {
      const c = text[i];
      if (c === '"') i = valueEnd(text, i) - 1;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
    }
  }
  let i = at;
  while (i < text.length && !/[\s,}\]]/.test(text[i] as string)) i++;
  return i;
}

/** The span of `key`'s value in the object starting at `objectStart`, or undefined. */
function memberSpan(text: string, objectStart: number, key: string): Span | undefined {
  let at = skipSpace(text, objectStart + 1);
  while (text[at] === '"') {
    const keyEnd = valueEnd(text, at);
    const name = JSON.parse(text.slice(at, keyEnd)) as string;
    at = skipSpace(text, skipSpace(text, keyEnd) + 1);
    const end = valueEnd(text, at);
    if (name === key) return { start: at, end };
    at = skipSpace(text, end);
    if (text[at] === ',') at = skipSpace(text, at + 1);
  }
  return undefined;
}

/** The indentation of the line `at` is on. */
function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/** `value` as JSON, indented to sit at `indent`. */
function indented(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`);
}

/**
 * The text with `value` added to the array at `object.key`, creating the key
 * (and the arrays and objects on the way) when missing, written in the same
 * two-space layout as its neighbours. `path` names the objects to walk.
 */
export function appendToArray(text: string, path: string[], key: string, value: unknown): string {
  let objectStart = skipSpace(text, 0);
  for (const name of path) {
    const span = memberSpan(text, objectStart, name);
    if (!span) return addMember(text, objectStart, name, nest([...path.slice(path.indexOf(name) + 1), key], [value]));
    objectStart = span.start;
  }
  const array = memberSpan(text, objectStart, key);
  if (!array) return addMember(text, objectStart, key, [value]);
  const close = array.end - 1;
  const last = text.slice(array.start + 1, close).trimEnd();
  const outer = lineIndent(text, close);
  const inner = `${outer}  `;
  if (!last.trim()) return `${text.slice(0, array.start)}[\n${inner}${indented(value, inner)}\n${outer}]${text.slice(array.end)}`;
  const lastEnd = array.start + 1 + last.length;
  return `${text.slice(0, lastEnd)},\n${inner}${indented(value, inner)}${text.slice(lastEnd)}`;
}

/** `{ a: { b: value } }` for the path `[a, b]`. */
function nest(path: string[], value: unknown): unknown {
  return path.reduceRight<unknown>((inner, name) => ({ [name]: inner }), value);
}

/** The text with `name: value` added last in the object starting at `objectStart`. */
function addMember(text: string, objectStart: number, name: string, value: unknown): string {
  const close = valueEnd(text, objectStart) - 1;
  const body = text.slice(objectStart + 1, close).trimEnd();
  const outer = lineIndent(text, close);
  const inner = `${outer}  `;
  const member = `${inner}${JSON.stringify(name)}: ${indented(value, inner)}`;
  const at = objectStart + 1 + body.length;
  return body.trim() ? `${text.slice(0, at)},\n${member}\n${outer}}${text.slice(close + 1)}` : `${text.slice(0, objectStart)}{\n${member}\n${outer}}${text.slice(close + 1)}`;
}
