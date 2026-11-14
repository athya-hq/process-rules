import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, HOOKS, main, realGit, toStderr } from './hooks-path.mjs';

/** A git that answers from `config`, recording each call. */
function fakeGit({ gitDir = '/repo/.git', commonDir = '/repo/.git', hooksPath, setFails = false } = {}) {
  // null stands for a git that fails.
  const answer = (value) => (value === null ? undefined : value);
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    if (args.includes('--git-dir')) return answer(gitDir);
    if (args.includes('--git-common-dir')) return answer(commonDir);
    if (args.includes('--get')) return hooksPath;
    if (args[0] === 'config') return setFails ? undefined : '';
    return undefined;
  };
  return { git, calls };
}

describe('decide', () => {
  test('sets the hooks folder in the main checkout when nothing is set', () => {
    assert.deepEqual(decide(fakeGit().git, {}).set, true);
    assert.deepEqual(decide(fakeGit({ hooksPath: '' }).git, {}).set, true);
  });

  test('sets nothing in CI, in a worktree, outside git, or when it is set already', () => {
    for (const [git, env] of [
      [fakeGit().git, { CI: 'true' }],
      [fakeGit({ gitDir: '/repo/.git/worktrees/a' }).git, {}],
      [fakeGit({ gitDir: null }).git, {}],
      [fakeGit({ commonDir: null }).git, {}],
      [fakeGit({ hooksPath: HOOKS }).git, {}],
    ]) {
      assert.deepEqual(decide(git, env), { set: false, say: '' });
    }
  });

  test("leaves someone else's hooks folder alone, saying what to add", () => {
    const plan = decide(fakeGit({ hooksPath: '/shared/hooks' }).git, {});
    assert.equal(plan.set, false);
    assert.match(plan.say, /core.hooksPath is \/shared\/hooks, so git does not run .githooks\//);
  });
});

describe('main', () => {
  test('sets core.hooksPath and says so', () => {
    const { git, calls } = fakeGit();
    const said = [];
    assert.equal(main(git, {}, (line) => said.push(line)), 0);
    assert.ok(calls.includes(`config --local core.hooksPath ${HOOKS}`));
    assert.match(said[0], /git now runs the hooks in .githooks\//);
  });

  test('changes nothing in a worktree', () => {
    const { git, calls } = fakeGit({ gitDir: '/repo/.git/worktrees/a' });
    const said = [];
    assert.equal(main(git, {}, (line) => said.push(line)), 0);
    assert.ok(!calls.some((call) => call.startsWith('config --local core.hooksPath')));
    assert.deepEqual(said, []);
  });

  test('exits 1 when git refuses the setting', () => {
    const said = [];
    assert.equal(main(fakeGit({ setFails: true }).git, {}, (line) => said.push(line)), 1);
    assert.match(said[0], /git config refused/);
  });

  test('passes on the note about a foreign hooks folder', () => {
    const said = [];
    assert.equal(main(fakeGit({ hooksPath: '/shared/hooks' }).git, {}, (line) => said.push(line)), 0);
    assert.equal(said.length, 1);
  });
});

describe('realGit', () => {
  test('sets core.hooksPath in a real main checkout, and nothing in its worktree', (t) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-path-')));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const env = { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const name of Object.keys(env)) if (name.startsWith('GIT_CONFIG_KEY_') || name.startsWith('GIT_CONFIG_VALUE_')) delete env[name];
    const run = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    const main_ = join(scratch, 'main');
    run(scratch, 'init', '-q', '-b', 'main', main_);
    run(main_, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'first');
    const tree = join(scratch, 'tree');
    run(main_, 'worktree', 'add', '-q', tree);
    const cwd = process.cwd();
    t.after(() => process.chdir(cwd));
    process.chdir(tree);
    assert.equal(main(realGit, {}, () => {}), 0);
    assert.equal(realGit(['config', '--local', '--get', 'core.hooksPath']), undefined);
    process.chdir(main_);
    assert.equal(main(realGit, {}, () => {}), 0);
    assert.equal(realGit(['config', '--local', '--get', 'core.hooksPath']), HOOKS);
  });
});

test('toStderr writes the line to stderr', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  toStderr('hooks-path: a note');
  assert.deepEqual(lines, ['hooks-path: a note']);
});
