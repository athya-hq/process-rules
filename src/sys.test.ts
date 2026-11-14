import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { realSys } from './sys.ts';

describe('realSys', () => {
  const sys = realSys();
  const dir = mkdtempSync(join(tmpdir(), 'process-rules-sys-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('runs a command with its own env, cwd and stdin', () => {
    assert.deepEqual(
      sys.exec('sh', ['-c', 'printf "%s %s " "$X" "$(pwd -P)"; cat'], {
        cwd: dir,
        env: { PATH: process.env.PATH, X: 'x' },
        input: 'in',
      }),
      { code: 0, stdout: `x ${realpathSync(dir)} in`, stderr: '' },
    );
  });

  it('reports a failing or missing command', () => {
    assert.equal(sys.exec('sh', ['-c', 'echo e >&2; exit 3']).code, 3);
    const missing = sys.exec('/no/such/command', []);
    assert.equal(missing.code, 127);
    assert.match(missing.stderr, /ENOENT/);
  });

  it('gives an interactive command the terminal and its exit code, as a shell would', () => {
    assert.deepEqual(sys.exec('sh', ['-c', 'exit 5'], { interactive: true }), { code: 5, stdout: '', stderr: '' });
    assert.equal(sys.exec('sh', ['-c', 'kill -TERM $$'], { interactive: true }).code, 143);
    assert.equal(sys.exec('/no/such/command', [], { interactive: true }).code, 127);
  });

  it('reads and writes files, private when asked', () => {
    const nested = join(dir, 'a', 'b');
    sys.mkdir(nested);
    const path = join(nested, 'f');
    assert.equal(sys.exists(path), false);
    sys.write(path, 'data', 0o600);
    assert.equal(sys.read(path), 'data');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    sys.append(path, '+more');
    assert.equal(sys.read(path), 'data+more');
    sys.write(join(dir, 'g'), 'plain');
    assert.equal(sys.exists(join(dir, 'g')), true);
  });

  it('makes a private temporary folder and removes it with what is in it', () => {
    const temp = sys.tempDir();
    assert.equal(statSync(temp).mode & 0o777, 0o700);
    sys.write(join(temp, 'hosts.yml'), 'token');
    sys.remove(temp);
    assert.equal(sys.exists(temp), false);
    sys.remove(temp);
    const named = sys.tempDir(join(dir, 'niyam-owner-step-'));
    assert.match(named, /\/niyam-owner-step-\w+$/);
    assert.equal(statSync(named).mode & 0o777, 0o700);
  });

  it('calls a Ctrl-C handler instead of ending, until it is taken off', () => {
    const seen: string[] = [];
    const before = process.listenerCount('SIGINT');
    const off = sys.onInterrupt(() => seen.push('interrupted'));
    assert.equal(process.listenerCount('SIGINT'), before + 1);
    process.emit('SIGINT');
    assert.deepEqual(seen, ['interrupted']);
    off();
    assert.equal(process.listenerCount('SIGINT'), before);
  });

  it('leaves an interactive command the terminal, capturing nothing', () => {
    assert.deepEqual(sys.exec('sh', ['-c', 'exit 0'], { interactive: true }), { code: 0, stdout: '', stderr: '' });
  });

  it("hands a conversing command's lines from both streams to the caller, with its exit code", async () => {
    const lines: string[] = [];
    const code = await sys.converse('sh', ['-c', 'test "$SEEN" = x || exit 4; echo one; echo two >&2; printf three; exit 3'], { env: { PATH: '/usr/bin:/bin', SEEN: 'x' } }, (line) => lines.push(line));
    assert.equal(code, 3);
    assert.deepEqual([...lines].sort(), ['one', 'three', 'two']);
    assert.equal(await sys.converse('/no/such/command', [], {}, () => {}), 127);
    assert.equal(await sys.converse('sh', ['-c', 'kill -TERM $$'], {}, () => {}), 128 + 15);
  });

  it('shows no spinner without a terminal', () => {
    const module = new URL('./sys.ts', import.meta.url).href;
    const shown = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const { realSys } = await import(${JSON.stringify(module)}); const one = realSys().spin('working'); await new Promise((r) => setTimeout(r, 300)); one.stop(); one.stop();`],
      { encoding: 'utf8' },
    );
    assert.deepEqual([shown.status, shown.stdout], [0, '']);
  });

  it('knows home, cwd, env and the time', () => {
    assert.equal(sys.cwd, process.cwd());
    assert.ok(sys.home.length > 0);
    assert.equal(sys.env, process.env);
    assert.ok(sys.now() instanceof Date);
  });

  it('calls a JSON API with a token and body', async () => {
    const seen: { auth?: string; body: string; method?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body, ...(req.method ? { method: req.method } : {}) });
        res.statusCode = req.url === '/empty' ? 204 : req.url === '/log' ? 200 : 201;
        res.setHeader('X-OAuth-Scopes', 'repo, workflow');
        res.end(req.url === '/empty' ? '' : req.url === '/log' ? 'step 1\nerror: no' : '{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const posted = await sys.http(`${base}/x`, { method: 'POST', token: 't', body: { a: 1 } });
      assert.deepEqual([posted.status, posted.json, posted.headers?.['x-oauth-scopes']], [201, { ok: true }, 'repo, workflow']);
      const empty = await sys.http(`${base}/empty`);
      assert.deepEqual([empty.status, empty.json], [204, null]);
      const log = await sys.http(`${base}/log`, { token: 't', text: true });
      assert.deepEqual([log.status, log.json, log.text], [200, null, 'step 1\nerror: no']);
      assert.equal((await sys.http(`${base}/x`)).text, undefined);
      assert.deepEqual(seen, [
        { auth: 'Bearer t', body: '{"a":1}', method: 'POST' },
        { body: '', method: 'GET' },
        { auth: 'Bearer t', body: '', method: 'GET' },
        { body: '', method: 'GET' },
      ]);
    } finally {
      server.close();
    }
  });

  /** A local server that cuts the connection for the first `drops` requests, then answers; and how many it saw. */
  async function flaky(drops: number, hang = false): Promise<{ base: string; seen: () => number; close: () => void }> {
    let count = 0;
    const server = createServer((req, res) => {
      count++;
      if (hang) return;
      if (count <= drops) {
        req.socket.destroy();
        return;
      }
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      base,
      seen: () => count,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  it('tries a GET, PUT or DELETE once more after a network failure', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const server = await flaky(1);
      try {
        const got = await sys.http(`${server.base}/x`, { method, ...(method === 'PUT' ? { body: { a: 1 } } : {}) });
        assert.deepEqual([got.status, got.json, server.seen()], [200, { ok: true }, 2], method);
      } finally {
        server.close();
      }
    }
  });

  it('says which request got no answer and why, never just "fetch failed" and never its query', async () => {
    const server = await flaky(2);
    try {
      await assert.rejects(sys.http(`${server.base}/repos/x/y/actions/secrets/public-key?token=hidden`, { token: 't' }), (error: Error) => {
        assert.match(error.message, /^GET 127\.0\.0\.1:\d+\/repos\/x\/y\/actions\/secrets\/public-key could not be made: \S/);
        assert.ok(!error.message.includes('hidden') && !error.message.includes('fetch failed'), error.message);
        return true;
      });
      assert.equal(server.seen(), 2);
    } finally {
      server.close();
    }
  });

  it('never repeats a POST or PATCH', async () => {
    for (const method of ['POST', 'PATCH']) {
      const server = await flaky(1);
      try {
        await assert.rejects(sys.http(`${server.base}/x`, { method, body: { a: 1 } }), new RegExp(`^Error: ${method} 127\\.0\\.0\\.1:\\d+/x could not be made: `));
        assert.equal(server.seen(), 1, method);
      } finally {
        server.close();
      }
    }
  });

  it('names a refused connection by its code', async () => {
    const server = await flaky(0);
    const { base } = server;
    server.close();
    await assert.rejects(sys.http(`${base}/x`, { method: 'POST' }), /^Error: POST 127\.0\.0\.1:\d+\/x could not be made: .*ECONNREFUSED/);
  });

  it('names a URL it cannot read by nothing more', async () => {
    await assert.rejects(sys.http('not a url?token=hidden', { method: 'POST' }), /^Error: POST a request could not be made: (?!.*hidden)/);
  });

  it('keeps one deadline for both tries', async () => {
    const server = await flaky(1);
    try {
      const started = Date.now();
      await assert.rejects(sys.http(`${server.base}/x`, { timeoutMs: 200 }), { name: 'TimeoutError' });
      assert.ok(Date.now() - started < 900, 'the repeat waits no longer than what is left of the deadline');
      assert.equal(server.seen(), 1);
    } finally {
      server.close();
    }
  });

  it('keeps a timeout as a TimeoutError, tried once', async () => {
    const server = await flaky(0, true);
    try {
      await assert.rejects(sys.http(`${server.base}/x`, { timeoutMs: 50 }), { name: 'TimeoutError' });
      assert.equal(server.seen(), 1);
    } finally {
      server.close();
    }
  });

  it('refuses a hidden prompt without a terminal', async () => {
    if (process.stdin.isTTY) return;
    await assert.rejects(sys.askSecret('token: '), /needs a terminal/);
  });

  it('asks a question on the terminal', () => {
    const module = fileURLToPath(new URL('./sys.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `const { realSys } = await import(${JSON.stringify(module)}); console.log('got', await realSys().ask('q? '));`],
      { input: 'yes\n', encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'q? got yes\n');
  });
});
