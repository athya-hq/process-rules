import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  commitMessage,
  cubicDismiss,
  dismissArgs,
  dismissSettings,
  formatEntry,
  parseDismissals,
  parseFrom,
  refusal,
  resolves,
  type DismissOptions,
} from './cubic-dismiss.ts';
import { FakeSys, ROOT, capture, type Call } from './fake.test.ts';
import { realSys } from './sys.ts';
import type { ExecResult } from './types.ts';

const SHA = 'a'.repeat(40);
const options = (over: Partial<DismissOptions> = {}): DismissOptions => ({ dismissals: [{ title: 'T', reason: 'r' }], basis: 'evidence', cite: 'src/a.ts', ...over });

describe('dismissSettings', () => {
  it('fills the defaults, and reads what is named', () => {
    assert.deepEqual(dismissSettings({}), { file: '.cubic-dismiss', subject: 'chore(review): dismiss {count} Cubic finding{s}', ownerBasis: 'owner' });
    assert.deepEqual(dismissSettings(null).file, '.cubic-dismiss');
    assert.deepEqual(dismissSettings({ cubicDismiss: { file: 'review/.dismiss', subject: '🔧 chore(review): dismiss {count}', ownerBasis: 'alok' } }), {
      file: 'review/.dismiss',
      subject: '🔧 chore(review): dismiss {count}',
      ownerBasis: 'alok',
    });
  });

  for (const [value, message] of [
    [[], /must be an object/],
    [null, /must be an object/],
    [{ files: 'x' }, /unknown key "files"/],
    [{ file: '../x' }, /file must be a path in the repository/],
    [{ file: '/x' }, /file must be a path/],
    [{ file: 3 }, /file must be a path/],
    [{ subject: 'a\nb' }, /subject must be one line/],
    [{ subject: ' ' }, /subject must be one line/],
    [{ ownerBasis: 'evidence' }, /ownerBasis must be one lower-case word/],
    [{ ownerBasis: 'Alok' }, /ownerBasis must be one lower-case word/],
  ] as const) {
    it(`refuses ${JSON.stringify(value)}`, () => assert.throws(() => dismissSettings({ cubicDismiss: value }), message));
  }
});

describe('dismissArgs', () => {
  it('pairs titles and reasons in order, with one basis', () => {
    assert.deepEqual(dismissArgs(['--evidence', 'src/a.ts', '--title', 'A', '--reason', 'ra', '--title=B', '--reason=rb', '--context', '0108 S-04']), {
      titles: [{ title: 'A', reason: 'ra' }, { title: 'B', reason: 'rb' }],
      basis: 'evidence',
      cite: 'src/a.ts',
      context: '0108 S-04',
    });
    assert.deepEqual(dismissArgs(['--decision', 'the owner on #12', '--from', '.tmp/d.json']), { titles: [], basis: 'decision', cite: 'the owner on #12', from: '.tmp/d.json' });
  });

  for (const [args, message] of [
    [['--evidence', 'x', '--title', 'A'], /each --title needs its own --reason/],
    [['--title', 'A', '--reason', 'r'], /give exactly one of --evidence or --decision/],
    [['--evidence', 'x', '--decision', 'y', '--title', 'A', '--reason', 'r'], /exactly one/],
    [['--evidence', ' ', '--title', 'A', '--reason', 'r'], /--evidence is blank/],
    [['--evidence', 'x', '--evidence', 'y'], /--evidence is given twice/],
    [['--evidence', 'x\ny', '--title', 'A', '--reason', 'r'], /--evidence spans lines/],
    [['--decision', 'x', '--context', 'a\nb', '--title', 'A', '--reason', 'r'], /--context spans lines/],
    [['--evidence', 'x'], /nothing to dismiss/],
    [['--evidence'], /--evidence needs a value/],
    [['--evidence', '--title'], /--evidence needs a value/],
    [['stray'], /unexpected argument "stray"/],
  ] as const) {
    it(`refuses ${JSON.stringify(args)}`, () => assert.throws(() => dismissArgs(args), message));
  }
});

describe('parseFrom and parseDismissals', () => {
  it('reads a JSON array of titles and reasons', () => {
    assert.deepEqual(parseFrom('[{"title":"`a{b}`","reason":"r","extra":1}]'), [{ title: '`a{b}`', reason: 'r' }]);
    assert.throws(() => parseFrom('{'), /it is not JSON/);
    assert.throws(() => parseFrom('[{"title":1,"reason":"r"}]'), /JSON array of/);
    assert.throws(() => parseFrom('[null]'), /JSON array of/);
    assert.throws(() => parseFrom('{}'), /JSON array of/);
  });

  it('reads every line that is neither blank nor a comment', () => {
    assert.deepEqual([...parseDismissals('# c\r\nA\r\n\nB\n')], ['A', 'B']);
  });
});

describe('refusal', () => {
  for (const [name, title, reason, over, message] of [
    ['an empty title', ' ', 'r', {}, 'a title is empty'],
    ['a title on two lines', 'a\nb', 'r', {}, '"a\nb" spans lines; a dismissal is one line'],
    ['a title read as a comment', '#x', 'r', {}, '"#x" starts with #, which the dismiss file reads as a comment'],
    ['no reason', 'T', ' ', {}, '"T" has no reason'],
    ['a title already dismissed', 'Old', 'r', {}, '"Old" is already dismissed'],
    ['a deferral in the reason', 'T', 'pre-existing on main', {}, /says "pre-existing": a true finding left unfixed is the owner's call; use --decision/],
    ['a deferral in the context', 'T', 'r', { context: 'a follow-up' }, /says "follow-up"/],
  ] as const) {
    it(`refuses ${name}`, () => {
      const why = refusal({ title, reason }, new Set(['Old']), options(over));
      if (typeof message === 'string') assert.equal(why, message);
      else assert.match(why ?? '', message);
    });
  }

  it('lets the owner defer, and the title say anything', () => {
    assert.equal(refusal({ title: 'T', reason: 'later' }, new Set(), options({ basis: 'decision', cite: '#12' })), null);
    assert.equal(refusal({ title: 'Pre-existing bug', reason: 'the code is gone' }, new Set(), options()), null);
  });
});

describe('resolves', () => {
  const git = (answers: Record<string, string>) => (args: string[]) => answers[args.join(' ')] ?? '';
  it('takes a dismissed title, a commit HEAD contains, or a path at HEAD', () => {
    assert.equal(resolves('Old', new Set(['Old']), git({})), true);
    assert.equal(resolves(SHA, new Set(), git({ [`rev-list --no-walk --ignore-missing ${SHA}`]: SHA })), true);
    assert.equal(resolves(SHA, new Set(), git({ [`rev-list --no-walk --ignore-missing ${SHA}`]: SHA, [`rev-list -n 1 ${SHA} ^HEAD`]: SHA })), false);
    assert.equal(resolves(SHA, new Set(), git({})), false);
    assert.equal(resolves('abc1234', new Set(), git({})), false);
    const tree = git({ 'ls-tree --full-tree --name-only HEAD -- docs/rule.md': 'docs/rule.md', 'ls-tree --full-tree --name-only HEAD -- .github/x.yml': '.github/x.yml' });
    assert.equal(resolves('docs/rule.md#why', new Set(), tree), true);
    assert.equal(resolves('.github/x.yml:12-14', new Set(), tree), true);
    assert.equal(resolves('docs/gone.md', new Set(), tree), false);
    for (const path of ['/etc/x', '../x', 'a//b', '-x', 'HEAD:x', 'a/./b']) assert.equal(resolves(path, new Set(), tree), false, path);
  });
});

describe('formatEntry and commitMessage', () => {
  it('wraps the dated reason at 78 columns, then the title', () => {
    const lines = formatEntry({ title: 'T', reason: `${'word '.repeat(30)}end` }, '2026-11-14', options({ context: '0108 S-04' }));
    assert.equal(lines[0]?.startsWith('# 2026-11-14 (0108 S-04; evidence: src/a.ts): word'), true);
    assert.ok(lines.slice(0, -1).every((line) => line.length <= 78 && line.startsWith('#')));
    assert.equal(lines.at(-1), 'T');
    assert.deepEqual(formatEntry({ title: 'T', reason: 'r' }, 'd', options({ basis: 'decision', cite: '#12' })), ['# d (#12): r', 'T']);
  });

  it('counts the findings, lists twelve, clips long lines and names the basis', () => {
    const settings = dismissSettings({ cubicDismiss: { subject: '🔧 chore(review): dismiss {count} Cubic finding{s}', ownerBasis: 'alok' } });
    const many = Array.from({ length: 13 }, (_, i) => ({ title: `${'x'.repeat(100)}${i}`, reason: 'r' }));
    const message = commitMessage(options({ dismissals: many }), settings);
    assert.equal(message.subject, '🔧 chore(review): dismiss 13 Cubic findings');
    assert.equal(message.body.split('\n').length, 13);
    assert.ok(message.body.split('\n')[1]?.endsWith('...'));
    assert.equal(message.trailer, 'Dismissal-Basis: evidence');
    const one = commitMessage(options({ basis: 'decision', cite: '#12' }), settings);
    assert.deepEqual(one, { subject: '🔧 chore(review): dismiss 1 Cubic finding', body: 'Decision: #12\n- T', trailer: 'Dismissal-Basis: alok' });
  });
});

/** A checkout whose git keeps the dismiss file's working, index and HEAD copies, and the commits made. */
function checkout(prior = '# 2026-10-01 (old): r\nOld\n') {
  const sys = new FakeSys();
  const world = { head: prior, index: prior, commits: [] as string[][], sha: 1, commitCode: 0, landOnFail: false, fail: new Set<string>(), mutate: undefined as string | undefined };
  const path = `${ROOT}/.cubic-dismiss`;
  sys.files.set(path, prior);
  sys.files.set(`${ROOT}/src/a.ts`, 'x');
  sys.execOverride = (call: Call): ExecResult | undefined => {
    if (call.command !== 'git') return undefined;
    const [verb] = call.args;
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    if (world.fail.has(call.args.join(' ')) || world.fail.has(verb as string)) return { code: 1, stdout: '', stderr: `${verb} broke` };
    const file = sys.files.get(path) ?? '';
    if (call.args.join(' ') === 'rev-parse --show-toplevel') return ok(`${ROOT}\n`);
    if (verb === 'rev-parse') return ok(`${world.sha}\n`);
    if (verb === 'status') return ok(file !== world.head || world.index !== world.head ? ' M .cubic-dismiss\n' : '');
    if (verb === 'ls-tree') return ok(call.args.at(-1) === 'src/a.ts' ? 'src/a.ts\n' : '');
    if (verb === 'add') return ((world.index = file), ok());
    if (verb === 'reset') return ((world.index = world.head), ok());
    if (verb === 'commit') {
      if (world.commitCode !== 0) {
        if (world.landOnFail) world.sha++, (world.head = world.index);
        return { code: world.commitCode, stdout: '', stderr: 'hook refused' };
      }
      world.commits.push([...call.args]);
      world.head = world.mutate ?? world.index;
      world.index = world.head;
      world.sha++;
      return { code: 0, stdout: 'hooks ran\n', stderr: '' };
    }
    if (verb === 'show') return ok(world.head);
    return undefined;
  };
  return { sys, world, path };
}

describe('cubicDismiss', () => {
  const run = (sys: FakeSys, args: string[]) => {
    const { io, out, err } = capture();
    return { code: cubicDismiss(sys, io, args), out, err };
  };
  const evidence = ['--evidence', 'src/a.ts', '--title', 'New finding', '--reason', 'the null check is on line 3'];

  it('appends, stages the file alone and commits it with its basis', () => {
    const { sys, world } = checkout();
    sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'o', agent: 'a', cubicDismiss: { ownerBasis: 'alok' } }));
    const done = run(sys, evidence);
    assert.deepEqual([done.code, done.out, done.err], [0, ['hooks ran', '✓ committed 1 dismissal(s) alone'], []]);
    assert.match(world.head, /^# 2026-10-01 \(old\): r\nOld\n# \d{4}-\d\d-\d\d \(evidence: src\/a.ts\): the null check is on line 3\nNew finding\n$/);
    const commit = world.commits[0] ?? [];
    assert.deepEqual(commit.slice(0, 3), ['commit', '--only', '-m']);
    assert.deepEqual(commit.slice(-3), ['Dismissal-Basis: evidence', '--', '.cubic-dismiss']);
    const decided = run(sys, ['--decision', 'the owner on #12', '--title', 'Later', '--reason', 'later']);
    assert.equal(decided.code, 0);
    assert.equal(world.commits[1]?.at(-3), 'Dismissal-Basis: alok');
  });

  it('starts a file that is not there, and ends one with no last newline first', () => {
    const empty = checkout('');
    empty.sys.files.delete(empty.path);
    assert.equal(run(empty.sys, evidence).code, 0);
    assert.match(empty.world.head, /^# .*\nNew finding\n$/);
    const open = checkout('Old');
    assert.equal(run(open.sys, evidence).code, 0);
    assert.match(open.world.head, /^Old\n# /);
  });

  it('reads more findings from a file in the repository, and none from elsewhere', () => {
    const { sys, world } = checkout();
    sys.files.set(`${ROOT}/.tmp/d.json`, '[{"title":"`x{y}`","reason":"r"}]');
    sys.cwd = `${ROOT}/.tmp`;
    assert.equal(run(sys, ['--decision', '#12', '--from', 'd.json']).code, 0);
    assert.match(world.head, /\n`x\{y\}`\n$/);
    const outside = run(sys, ['--decision', '#12', '--from', '/etc/d.json']);
    assert.deepEqual([outside.code, outside.err], [1, ['✗ --from must be a file in the repository: /etc/d.json']]);
    sys.files.set(`${ROOT}/.tmp/none.json`, '[]');
    assert.deepEqual(run(sys, ['--decision', '#12', '--from', 'none.json']).err, ['✗ none.json holds nothing to dismiss']);
  });

  for (const [name, setup, args, message] of [
    ['a dismiss file that already differs from HEAD', (w: ReturnType<typeof checkout>) => w.sys.files.set(w.path, 'changed\n'), evidence, /already differs from HEAD \(M \.cubic-dismiss\); commit or restore it first/],
    ['evidence that does not resolve', () => {}, ['--evidence', 'docs/gone.md', '--title', 'T', '--reason', 'r'], /--evidence "docs\/gone.md" is no path at HEAD/],
    ['a title already dismissed', () => {}, ['--evidence', 'Old', '--title', 'Old', '--reason', 'r'], /"Old" is already dismissed; nothing was written/],
    ['the same title twice', () => {}, ['--evidence', 'src/a.ts', '--title', 'T', '--reason', 'r', '--title', 'T', '--reason', 'r'], /"T" is already dismissed/],
    ['a deferral on evidence', () => {}, ['--evidence', 'src/a.ts', '--title', 'T', '--reason', 'out of scope here'], /use --decision/],
  ] as const) {
    it(`refuses ${name}, writing nothing`, () => {
      const world = checkout();
      setup(world);
      const before = world.sys.files.get(world.path);
      const done = run(world.sys, [...args]);
      assert.equal(done.code, 1);
      assert.match(done.err[0] ?? '', message);
      assert.equal(world.sys.files.get(world.path), before);
      assert.equal(world.world.commits.length, 0);
    });
  }

  it('restores the file when the commit is refused', () => {
    const { sys, world, path } = checkout();
    world.commitCode = 1;
    const done = run(sys, evidence);
    assert.deepEqual([done.code, done.out, done.err], [1, ['hook refused'], ['✗ the commit failed; .cubic-dismiss is restored']]);
    assert.equal(sys.files.get(path), world.head);
    assert.equal(world.index, world.head);
  });

  it('keeps a commit that landed though git reported a failure', () => {
    const { sys, world } = checkout();
    world.commitCode = 1;
    world.landOnFail = true;
    assert.match(run(sys, evidence).err[0] ?? '', /git reported a failure, but the commit landed \(2\); \.cubic-dismiss is left as committed/);
  });

  it('names a restore that leaves the file changed, or cannot run', () => {
    const left = checkout();
    left.world.commitCode = 1;
    left.world.fail.add('reset');
    assert.match(run(left.sys, evidence).err[0] ?? '', /restoring \.cubic-dismiss failed too \(git reset failed: reset broke\)/);
    // A reset that does nothing leaves the staged lines in the index.
    const stuck = checkout();
    stuck.world.commitCode = 1;
    const real = stuck.sys.execOverride;
    stuck.sys.execOverride = (call) => (call.args[0] === 'reset' ? { code: 0, stdout: '', stderr: '' } : real(call));
    assert.match(run(stuck.sys, evidence).err[0] ?? '', /the commit failed and \.cubic-dismiss still differs from HEAD \(M \.cubic-dismiss\)/);
  });

  it('undoes and throws when staging fails', () => {
    const { sys, world, path } = checkout();
    world.fail.add('add');
    const { io, err } = capture();
    assert.throws(() => cubicDismiss(sys, io, evidence), /git add failed: add broke/);
    assert.deepEqual(err, ['✗ the commit failed; .cubic-dismiss is restored']);
    assert.equal(sys.files.get(path), world.head);
  });

  // The faults sweep: whichever git call fails, the run never exits 0 without the commit, the file is as it was or
  // as a clean run leaves it, and a rerun converges on one commit.
  it('survives a failure at every git call, and a rerun converges', () => {
    const clean = checkout();
    let calls = 0;
    const counting = clean.sys.execOverride;
    clean.sys.execOverride = (call) => (call.command === 'git' && calls++, counting(call));
    assert.equal(run(clean.sys, evidence).code, 0);
    const done = clean.world.head;
    for (let failAt = 1; failAt <= calls; failAt++) {
      const { sys, world, path } = checkout();
      const real = sys.execOverride;
      let seen = 0;
      sys.execOverride = (call) => (call.command === 'git' && ++seen === failAt ? { code: 1, stdout: '', stderr: 'injected' } : real(call));
      let code: number;
      try {
        code = cubicDismiss(sys, capture().io, evidence);
      } catch {
        code = 1;
      }
      assert.ok(code !== 0 || world.commits.length === 1, `call ${failAt}: exit 0 without a commit`);
      assert.ok([world.head, done].includes(sys.files.get(path) ?? ''), `call ${failAt}: the file is half-written`);
      sys.execOverride = real;
      if (world.commits.length === 0) assert.equal(run(sys, evidence).code, 0, `call ${failAt}: the rerun`);
      assert.equal(world.commits.length, 1, `call ${failAt}: one commit`);
      assert.equal(world.head, done);
    }
  });

  it('removes a dismiss file it started when the commit fails, so the rerun is not refused (real git)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'niyam-dismiss-')));
    try {
      const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 't@example.invalid');
      git('config', 'user.name', 'T');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(dir, 'a.ts'), 'x\n');
      git('add', 'a.ts');
      git('commit', '-q', '-m', 'base');
      mkdirSync(join(dir, 'hooks'));
      writeFileSync(join(dir, 'hooks/commit-msg'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      git('config', 'core.hooksPath', 'hooks');
      const sys = { ...realSys(), cwd: dir };
      const args = ['--evidence', 'a.ts', '--title', 'T', '--reason', 'r'];
      const first = capture();
      assert.equal(cubicDismiss(sys, first.io, args), 1);
      assert.deepEqual(first.err, ['✗ the commit failed; .cubic-dismiss is restored']);
      assert.equal(existsSync(join(dir, '.cubic-dismiss')), false);
      git('config', '--unset', 'core.hooksPath');
      const again = capture();
      assert.equal(cubicDismiss(sys, again.io, args), 0, again.err.join('\n'));
      assert.match(git('log', '-1', '--format=%(trailers:key=Dismissal-Basis,valueonly)'), /^evidence/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never reports text it did not write as recorded, and keeps a commit it cannot read back', () => {
    const changed = checkout();
    changed.world.mutate = 'someone else\n';
    assert.deepEqual(run(changed.sys, evidence).err, ['✗ the commit holds a .cubic-dismiss this did not write; something changed it meanwhile: check git show HEAD']);
    const unread = checkout();
    unread.world.fail.add('show');
    const done = run(unread.sys, evidence);
    assert.deepEqual([done.code, done.err], [0, ['! committed, but .cubic-dismiss could not be read back from HEAD to check it: check git show HEAD']]);
  });
});
