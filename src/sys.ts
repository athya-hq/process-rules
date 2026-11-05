import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import { constants, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isatty } from 'node:tty';

import type { Sys } from './types.ts';

/** The real machine: processes, files, the terminal and GitHub's REST API. */
export function realSys(): Sys {
  // Behind a proxy, such as a Claude cloud session's GitHub proxy, GitHub is reached through it, as gh and git reach it.
  // Node's own types do not name it yet.
  if (process.env.HTTPS_PROXY || process.env.https_proxy) (http as { setGlobalProxyFromEnv?: () => void }).setGlobalProxyFromEnv?.();
  return {
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    runtime: { node: realPath(process.execPath), cli: realPath(process.argv[1] ?? '') },
    platform: process.platform,
    exec(command, args, options = {}) {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        cwd: options.cwd,
        env: options.env ?? process.env,
        input: options.input,
        timeout: options.timeoutMs,
        ...(options.interactive ? { stdio: 'inherit' as const } : {}),
      });
      return {
        code: result.status ?? exitCode(result),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error ? String(result.error) : ''),
      };
    },
    exists: (path) => existsSync(path),
    read: (path) => readFileSync(path, 'utf8'),
    write(path, data, mode) {
      writeFileSync(path, data, { mode });
      if (mode !== undefined) chmodSync(path, mode);
    },
    append: (path, data) => appendFileSync(path, data),
    mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
    list: (path) => (existsSync(path) ? readdirSync(path) : []),
    tempDir: () => mkdtempSync(join(tmpdir(), 'process-rules-')),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    async http(url, options = {}) {
      const method = (options.method ?? 'GET').toUpperCase();
      // One deadline for the call, a repeat included, so timeoutMs bounds all of it.
      const signal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
      const request = async (): Promise<{ response: Response; text: string }> => {
        const response = await fetch(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          ...(signal ? { signal } : {}),
        });
        return { response, text: await response.text() };
      };
      let got: { response: Response; text: string };
      try {
        got = await request();
      } catch (error) {
        // A timeout keeps its own error, which callers name; a request that can be repeated safely is tried once more.
        if (isTimeout(error)) throw error;
        if (!REPEATABLE.has(method)) throw notMade(method, url, error);
        // The wait ends early when the deadline passes, and the repeat then stops with its TimeoutError.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, RETRY_MS);
          signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
        try {
          got = await request();
        } catch (again) {
          throw isTimeout(again) ? again : notMade(method, url, again);
        }
      }
      const { response, text } = got;
      return {
        status: response.status,
        json: text ? JSON.parse(text) : null,
        headers: Object.fromEntries(response.headers),
      };
    },
    // isatty(0), not process.stdin, which would open the stream and could make the read fail.
    readStdin: () => (isatty(0) ? '' : readFileSync(0, 'utf8')),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    askSecret: (question) => readHidden(question),
    open(url) {
      spawnSync('open', [url]);
    },
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Methods a request can be repeated with after a network failure, since repeating one changes nothing more. */
const REPEATABLE = new Set(['GET', 'PUT', 'DELETE']);

/** How long to wait before trying such a request again. */
export const RETRY_MS = 1000;

function isTimeout(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError';
}

/**
 * Why a request got no answer, naming the request by method, host and path, never its query, and giving the
 * reason that fetch's own "fetch failed" holds in its cause, such as "ECONNRESET (other side closed)".
 */
export function notMade(method: string, url: string, error: unknown): Error {
  let where = 'a request';
  try {
    const parsed = new URL(url);
    where = `${parsed.host}${parsed.pathname}`;
  } catch {
    // A URL fetch could not read is named by nothing more.
  }
  return new Error(`${method} ${where} could not be made: ${reason(error)}`, { cause: error });
}

/** The innermost cause's code and message, or what there is of them. */
function reason(error: unknown): string {
  let inner = error as { cause?: unknown; code?: unknown; message?: unknown } | null;
  while (inner && typeof inner === 'object' && inner.cause && typeof inner.cause === 'object') {
    inner = inner.cause as typeof inner;
  }
  const code = typeof inner?.code === 'string' ? inner.code : '';
  const message = typeof inner?.message === 'string' ? inner.message : '';
  if (code && message && !message.includes(code)) return `${code} (${message})`;
  return message || code || String(error);
}

/** A path with its links resolved, or as given when it cannot be. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Reads one line from the terminal without echoing it. */
function readHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('a hidden prompt needs a terminal'));
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return new Promise((resolve, reject) => {
    const done = (error?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003') return done(new Error('cancelled'));
        if (char === '\u007f') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * What a shell would exit with for a command that did not exit itself: 128
 * plus the signal that ended it, 127 when it was not found, 126 when it
 * could not be run, and 1 otherwise.
 */
function exitCode(result: { signal: NodeJS.Signals | null; error?: Error }): number {
  if (result.signal) return 128 + (constants.signals[result.signal] ?? 0);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' ? 127 : code === 'EACCES' ? 126 : 1;
}
