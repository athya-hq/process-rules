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
  });

  it('leaves an interactive command the terminal, capturing nothing', () => {
    assert.deepEqual(sys.exec('sh', ['-c', 'exit 0'], { interactive: true }), { code: 0, stdout: '', stderr: '' });
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
        res.statusCode = req.url === '/empty' ? 204 : 201;
        res.setHeader('X-OAuth-Scopes', 'repo, workflow');
        res.end(req.url === '/empty' ? '' : '{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const posted = await sys.http(`${base}/x`, { method: 'POST', token: 't', body: { a: 1 } });
      assert.deepEqual([posted.status, posted.json, posted.headers?.['x-oauth-scopes']], [201, { ok: true }, 'repo, workflow']);
      const empty = await sys.http(`${base}/empty`);
      assert.deepEqual([empty.status, empty.json], [204, null]);
      assert.deepEqual(seen, [
        { auth: 'Bearer t', body: '{"a":1}', method: 'POST' },
        { body: '', method: 'GET' },
      ]);
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
