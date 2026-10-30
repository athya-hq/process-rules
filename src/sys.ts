import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

import type { Sys } from './types.ts';

/** The real machine: processes, files, the terminal and GitHub's REST API. */
export function realSys(): Sys {
  return {
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    exec(command, args, options = {}) {
      const result = spawnSync(command, args, {
        encoding: 'utf8',
        cwd: options.cwd,
        env: options.env ?? process.env,
        input: options.input,
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
    async http(url, options = {}) {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
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
  };
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
