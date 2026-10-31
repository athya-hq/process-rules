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
import { homedir, tmpdir } from 'node:os';
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
        code: result.status ?? 1,
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
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
      const text = await response.text();
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
