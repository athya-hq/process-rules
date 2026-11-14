// .githooks/, run by git in a throwaway repository laid out as niyam is: the
// hooks, released-pins.mjs, a package.json pinning dvara with its lockfile
// entry, and that dvara installed (linked to this checkout's install, which
// `pnpm install` must have laid out, as in CI). `niyam` on PATH is a
// stand-in that records its arguments and the refs git gave the hook.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DVARA = '@veda-hq/dvara';
const PIN = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies[DVARA];
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'githooks-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const bin = join(scratch, 'bin');
const niyamCalls = join(scratch, 'niyam-calls');
// HOME is the scratch folder, so the hook finds the stand-in niyam on PATH,
// never this machine's launcher.
const env = { ...process.env, HOME: scratch, PATH: `${bin}${delimiter}${process.env.PATH}`, NIYAM_CALLS: niyamCalls };
for (const name of Object.keys(env)) {
  if (name.startsWith('DVARA_') || name.startsWith('GIT_') || name === 'NIYAM_AGENT' || name === 'CLAUDECODE') delete env[name];
}
// No machine git config, and no automatic maintenance: a commit's detached
// `git maintenance run --auto` outlives it and can write into the scratch
// folder while it is removed.
Object.assign(env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto',
  GIT_CONFIG_VALUE_1: '0',
});

/** @param {string} cwd @param {string[]} args @param {Record<string, string>} [extra] */
function git(cwd, args, extra = {}) {
  const result = spawnSync('git', args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout.trim() };
}

let repo = '';
before(() => {
  mkdirSync(bin);
  writeFileSync(join(bin, 'niyam'), '#!/bin/sh\n{ echo "args: $*"; cat; } >> "$NIYAM_CALLS"\n');
  chmodSync(join(bin, 'niyam'), 0o755);

  const remote = join(scratch, 'remote.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env }).status, 0);

  repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', '@veda-hq'), { recursive: true });
  cpSync(join(ROOT, '.githooks'), join(repo, '.githooks'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'released-pins.mjs'), join(repo, 'scripts', 'released-pins.mjs'));
  // released-pins reads the lockfile with yaml, which resolves from the script's own folder upward.
  symlinkSync(realpathSync(join(ROOT, 'node_modules', 'yaml')), join(repo, 'node_modules', 'yaml'));
  symlinkSync(realpathSync(join(ROOT, 'node_modules', DVARA)), join(repo, 'node_modules', DVARA));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ devDependencies: { [DVARA]: PIN } }));
  writeFileSync(
    join(repo, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    devDependencies:',
      `      '${DVARA}':`,
      `        specifier: ${PIN}`,
      `        version: ${PIN}`,
      'packages:',
      `  '${DVARA}@${PIN}':`,
      '    resolution: {integrity: sha512-abc}',
      '',
    ].join('\n'),
  );
  // niyam's own stage lists, so a hook that strays from them fails here.
  const { stages } = JSON.parse(readFileSync(join(ROOT, '.dvara.json'), 'utf8'));
  writeFileSync(join(repo, '.dvara.json'), JSON.stringify({ stages, records: {} }));
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.dvara/\n');
  git(repo, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.name', 'Hook Test'], ['user.email', 'hooks@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.githooks']]) {
    git(repo, ['config', key, value]);
  }
  git(repo, ['remote', 'add', 'origin', remote]);
});

describe('pre-commit', () => {
  test('passes a clean commit, under dvara', () => {
    git(repo, ['add', '-A']);
    const result = git(repo, ['commit', '-q', '-m', 'first']);
    assert.equal(result.code, 0, result.out);
    assert.ok(existsSync(join(repo, '.dvara', 'history.jsonl')), 'dvara records the run');
  });

  test('refuses a staged machine path (dvara records)', () => {
    writeFileSync(join(repo, 'notes.md'), 'See /Users/someone/notes for the log.\n');
    git(repo, ['add', 'notes.md']);
    const result = git(repo, ['commit', '-q', '-m', 'notes']);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /EVIDENCE-02/);
    git(repo, ['reset', '-q', 'notes.md']);
    rmSync(join(repo, 'notes.md'));
  });

  test('refuses when the pinned dvara is not installed', () => {
    const link = join(repo, 'node_modules', DVARA);
    const target = realpathSync(link);
    rmSync(link);
    try {
      writeFileSync(join(repo, 'ok.md'), 'fine\n');
      git(repo, ['add', 'ok.md']);
      const result = git(repo, ['commit', '-q', '-m', 'ok']);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /@veda-hq\/dvara .* is not installed in .*; run pnpm install there/);
    } finally {
      symlinkSync(target, link);
      git(repo, ['reset', '-q', 'ok.md']);
      rmSync(join(repo, 'ok.md'));
    }
  });
});

describe('pre-push', () => {
  test('passes a push outside an agent session without running niyam', () => {
    const result = git(repo, ['push', '-q', 'origin', 'main']);
    assert.equal(result.code, 0, result.out);
    assert.ok(!existsSync(niyamCalls), 'niyam pre-push runs only for an agent session');
  });

  test("hands an agent session's push to niyam pre-push, with git's refs", () => {
    writeFileSync(join(repo, 'two.md'), 'second\n');
    git(repo, ['add', 'two.md']);
    assert.equal(git(repo, ['commit', '-q', '-m', 'second']).code, 0);
    const head = git(repo, ['rev-parse', 'HEAD']).stdout;
    const result = git(repo, ['push', '-q', 'origin', 'main'], { CLAUDECODE: '1' });
    assert.equal(result.code, 0, result.out);
    const calls = readFileSync(niyamCalls, 'utf8');
    assert.match(calls, /^args: pre-push origin /m);
    assert.match(calls, new RegExp(`refs/heads/main ${head} refs/heads/main`));
  });

  test('refuses an agent push when the niyam CLI is missing', () => {
    writeFileSync(join(repo, 'three.md'), 'third\n');
    git(repo, ['add', 'three.md']);
    assert.equal(git(repo, ['commit', '-q', '-m', 'third']).code, 0);
    rmSync(join(bin, 'niyam'));
    try {
      const result = git(repo, ['push', '-q', 'origin', 'main'], { CLAUDECODE: '1', PATH: process.env.PATH.split(delimiter).filter((dir) => !existsSync(join(dir, 'niyam'))).join(delimiter) });
      assert.notEqual(result.code, 0);
      assert.match(result.out, /the CLI is not installed, so this agent push cannot be checked/);
    } finally {
      writeFileSync(join(bin, 'niyam'), '#!/bin/sh\n{ echo "args: $*"; cat; } >> "$NIYAM_CALLS"\n');
      chmodSync(join(bin, 'niyam'), 0o755);
    }
  });

  test('refuses a push whose pins are not registry releases', () => {
    const lock = join(repo, 'pnpm-lock.yaml');
    const text = readFileSync(lock, 'utf8');
    writeFileSync(lock, text.replace(`        version: ${PIN}`, '        version: link:../veda/packages/dvara'));
    try {
      const result = git(repo, ['push', '-q', 'origin', 'main']);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /resolves @veda-hq\/dvara to link:/);
    } finally {
      writeFileSync(lock, text);
    }
  });
});
