import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GITHUB_API, GITHUB_HOST, GITHUB_HOST_RE, GITHUB_NOREPLY, GITHUB_SSH, GITHUB_SSH_443, GITHUB_WEB } from './host.ts';

const SRC = new URL('.', import.meta.url);
/** The host written out, plain or escaped for a RegExp. */
const LITERAL = /github(?:\\)*\.com/i;

describe('host', () => {
  it('derives every address from the one host', () => {
    assert.equal(GITHUB_HOST, 'github.com');
    assert.equal(GITHUB_WEB, 'https://github.com');
    assert.equal(GITHUB_API, 'https://api.github.com');
    assert.equal(GITHUB_SSH, 'git@github.com');
    assert.equal(GITHUB_SSH_443, 'git@ssh.github.com');
    assert.equal(GITHUB_NOREPLY, 'users.noreply.github.com');
    assert.ok(new RegExp(`^${GITHUB_HOST_RE}$`).test('github.com'));
    assert.ok(!new RegExp(`^${GITHUB_HOST_RE}$`).test('githubXcom'));
  });

  it('is written out in host.ts alone', () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'host.ts');
    assert.ok(files.length > 10);
    const offenders = files.flatMap((name) =>
      readFileSync(new URL(name, SRC), 'utf8')
        .split('\n')
        .flatMap((line, i) => (LITERAL.test(line) ? [`src/${name}:${i + 1}: ${line.trim()}`] : [])),
    );
    assert.deepEqual(offenders, []);
  });
});
