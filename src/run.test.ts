import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeSys } from './fake.test.ts';
import { USAGE, packageVersion, proposeArgs, run, versionOf } from './run.ts';
import { nameOf, packageName } from './version.ts';

const manifest: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const expectedVersion =
  typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? manifest.version
    : undefined;

const noSys = (): never => {
  throw new Error('this command must not touch the machine');
};

async function capture(
  args: readonly string[],
  sys: () => FakeSys = noSys,
): Promise<{
  code: number;
  out: string[];
  err: string[];
}> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    args,
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    sys,
  );
  return { code, out, err };
}

describe('run', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    it(`prints usage for ${JSON.stringify(args)}`, async () => {
      assert.deepEqual(await capture(args), { code: 0, out: [USAGE], err: [] });
    });
  }

  for (const flag of ['version', '--version', '-v']) {
    it(`prints the package version for ${flag}`, async () => {
      assert.deepEqual(await capture([flag]), {
        code: 0,
        out: [expectedVersion],
        err: [],
      });
    });
  }

  it('prints the Setup snippet for cloud-setup, which names no version', async () => {
    const { code, out } = await capture(['cloud-setup']);
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /^#!\/bin\/bash\n# niyam for Claude cloud sessions: runs the clone's \.github\/niyam\/cloud-setup\.sh, else its \.github\/process-rules\/cloud-setup\.sh/);
    assert.ok(!(out[0] ?? '').includes(String(expectedVersion)));
  });

  it('refuses an unknown command with usage on stderr', async () => {
    assert.deepEqual(await capture(['deploy']), {
      code: 2,
      out: [],
      err: ['niyam: unknown command "deploy"', USAGE],
    });
  });

  for (const command of ['machine', 'doctor']) {
    it(`reports a ${command} failure with exit 1`, async () => {
      const sys = new FakeSys();
      sys.inRepo = false;
      assert.deepEqual(await capture([command], () => sys), {
        code: 1,
        out: [],
        err: [
          `niyam ${command}: name the agent account after the command, or run it in a repo whose .github/niyam.json names one`,
        ],
      });
    });
  }

  it('runs doctor', async () => {
    const { code, out } = await capture(['doctor'], () => new FakeSys());
    assert.equal(code, 1);
    assert.equal(out[0], '◆  niyam doctor   ExampleBot');
    assert.equal(out.at(-1), '└  5 to fix');
  });

  it('runs session-start, which always exits 0', async () => {
    const { code, out } = await capture(['session-start'], () => new FakeSys());
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /CLAUDE_ENV_FILE is unset.*runs only as the SessionStart hook, so a run by hand says nothing about this session/);
  });

  it('passes the named agent on', async () => {
    const { out } = await capture(['doctor', 'OtherBot'], () => new FakeSys());
    assert.equal(out[0], '◆  niyam doctor   OtherBot');
  });

  it('passes machine its agent and flags, and treats a bad one as bad usage', async () => {
    const { code, out } = await capture(['machine', 'examplebot', '--dry-run'], () => new FakeSys());
    assert.equal(code, 0);
    assert.equal(out[0], '◆  niyam machine   ExampleBot');
    assert.equal(out.at(-1), '└  Dry run: nothing changed.');
    for (const args of [['machine', '--force'], ['machine', 'a', 'b']]) {
      const { code: bad, err } = await capture(args);
      assert.equal(bad, 2, args.join(' '));
      assert.match(err[0] ?? '', /^niyam: (unknown option --force|unexpected argument "b")$/);
    }
  });

  it('runs pr-work-rules and pre-push, which takes git\'s two arguments and no third', async () => {
    assert.match((await capture(['pr-work-rules'], () => new FakeSys())).err[0] ?? '', /pr-work-rules runs in GitHub Actions/);
    assert.match((await capture(['pr-merged'], () => new FakeSys())).err[0] ?? '', /pr-merged runs in GitHub Actions/);
    const agent = new FakeSys();
    agent.env = { NIYAM_AGENT: 'ExampleBot' };
    agent.stdin = `refs/heads/work ${'a'.repeat(40)} refs/heads/work ${'b'.repeat(40)}\n`;
    const refused = await capture(['pre-push', 'origin', 'https://github.com/a/b.git'], () => agent);
    assert.equal(refused.code, 1);
    assert.match(refused.err[0] ?? '', /git has no credentials for github.com here/, 'git\'s URL reaches the identity guard');
    assert.equal((await capture(['pre-push', 'origin', 'url', 'extra'])).code, 2);
  });

  it('runs propose, which takes one issue number or several', async () => {
    const refused = await capture(['propose', '#12'], () => new FakeSys());
    assert.equal(refused.code, 1);
    assert.match(refused.err[0] ?? '', /this session has no token/);
    const several = await capture(['propose', '12', '#13'], () => new FakeSys());
    assert.equal(several.code, 1);
    assert.match(several.err[0] ?? '', /this session has no token/);
    assert.deepEqual(await capture(['propose']), { code: 2, out: [], err: ['niyam: propose needs an issue number', USAGE] });
    assert.deepEqual(await capture(['propose', 'twelve']), { code: 2, out: [], err: ['niyam: propose needs an issue number, not "twelve"', USAGE] });
    assert.deepEqual(await capture(['propose', '12', 'x', 'y']), { code: 2, out: [], err: ['niyam: propose needs an issue number, not "x"', USAGE] });
    assert.deepEqual(await capture(['propose', '#0']), { code: 2, out: [], err: ['niyam: propose needs an issue number, not "#0"', USAGE] });
  });

  it("takes propose's page once, before or after the numbers, with its value", async () => {
    const PAGE = 'https://claude.ai/artifact/W48-page';
    assert.deepEqual(proposeArgs(['12', '--page', PAGE]), { numbers: [12], page: PAGE });
    assert.deepEqual(proposeArgs([`--page=${PAGE}`, '#12', '30']), { numbers: [12, 30], page: PAGE });
    assert.deepEqual(proposeArgs(['12']), { numbers: [12] });
    const paged = await capture(['propose', '12', '--page', PAGE], () => new FakeSys());
    assert.equal(paged.code, 1);
    assert.match(paged.err[0] ?? '', /this session has no token/);
    const bad: Array<[string[], string]> = [
      [['12', '--page'], "propose --page needs the published page's link"],
      [['12', '--page', '--other'], "propose --page needs the published page's link"],
      [['12', '--page='], "propose --page needs the published page's link"],
      [['12', '--page', PAGE, '--page', PAGE], 'propose takes one --page: one page argues every proposal of the run'],
      [['--page', PAGE], 'propose needs an issue number'],
      [['12', PAGE], `propose needs an issue number, not "${PAGE}"`],
    ];
    for (const [args, message] of bad) {
      assert.deepEqual(await capture(['propose', ...args]), { code: 2, out: [], err: [`niyam: ${message}`, USAGE] }, args.join(' '));
    }
  });

  it('runs review-thread, whose arguments are checked first', async () => {
    const refused = await capture(['review-thread', 'PRRT_x', '--resolve'], () => new FakeSys());
    assert.deepEqual(refused, { code: 1, out: [], err: ['✗ this session has no token; run niyam doctor', 'review-thread: refused'] });
    assert.deepEqual(await capture(['review-thread', 'PRRT_x']), {
      code: 2,
      out: [],
      err: ['niyam: review-thread needs --reply <text>, --resolve, or both', USAGE],
    });
    assert.equal((await capture(['review-thread', 'PRRT_x', '--resolve', 'more'])).code, 2);
  });

  it('runs guard, refusing when the check itself fails', async () => {
    const sys = new FakeSys();
    sys.stdin = JSON.stringify({ session_id: 's', tool_input: { command: 'ls' } });
    assert.equal((await capture(['guard'], () => sys)).code, 0);
    const failed = await capture(['guard']);
    assert.deepEqual(failed, { code: 2, out: [], err: ['niyam guard: refused, because the check failed: this command must not touch the machine'] });
    const thrown = await capture(['guard'], () => {
      throw 'odd';
    });
    assert.equal(thrown.err[0], 'niyam guard: refused, because the check failed: odd');
  });

  it('treats a bad onboard option as bad usage', async () => {
    for (const args of [['onboard', 'a', 'b', 'c'], ['onboard', '--add', 'boards'], ['onboard', '--force']]) {
      const { code, err } = await capture(args);
      assert.equal(code, 2, args.join(' '));
      assert.equal(err.at(-1), USAGE);
    }
  });

  it('refuses a second argument after the agent', async () => {
    assert.deepEqual(await capture(['machine', 'OtherBot', 'now']), {
      code: 2,
      out: [],
      err: ['niyam: unexpected argument "now"', USAGE],
    });
  });

  it('reports a thrown non-error', async () => {
    const sys = new FakeSys();
    sys.exec = () => {
      throw 'odd';
    };
    assert.deepEqual(await capture(['machine'], () => sys), {
      code: 1,
      out: [],
      err: ['niyam machine: odd'],
    });
  });

  it('refuses an extra argument', async () => {
    assert.deepEqual(await capture(['version', 'now']), {
      code: 2,
      out: [],
      err: ['niyam: unexpected argument "now"', USAGE],
    });
  });
});

describe('packageVersion', () => {
  it('reads the version from package.json', () => {
    assert.equal(packageVersion(), expectedVersion);
  });
});

describe('versionOf', () => {
  for (const raw of [null, 'x', {}, { version: 1 }]) {
    it(`throws for ${JSON.stringify(raw)}`, () => {
      assert.throws(() => versionOf(raw), /no string "version"/);
    });
  }
});

describe('cli entry', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));

  it('prints the version and exits 0', () => {
    assert.equal(
      execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }),
      `${String(expectedVersion)}\n`,
    );
  });

  it('exits 2 on an unknown command', () => {
    const result = spawnSync(process.execPath, [cli, 'nope'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /unknown command "nope"/);
  });

  it('runs the same CLI as process-rules, the old bin, which names niyam to the owner alone (P-49)', () => {
    const old = fileURLToPath(new URL('./old-cli.ts', import.meta.url));
    assert.equal(execFileSync(process.execPath, [old, '--version'], { encoding: 'utf8' }), `${String(expectedVersion)}\n`, 'what upgrade and hooks parse stays bare');
    const help = spawnSync(process.execPath, [old, 'help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.equal(help.stderr, 'process-rules is now niyam: run niyam help. The old name still works for now.\n');
    assert.equal(help.stdout, `${USAGE}\n`);
  });

  it('names niyam only for the commands the owner types', async () => {
    const said = async (args: string[], invokedAs?: string): Promise<string[]> => {
      const err: string[] = [];
      await run(args, { out: () => {}, err: (line) => err.push(line) }, () => new FakeSys(), invokedAs);
      return err;
    };
    assert.deepEqual(await said([], 'process-rules'), ['process-rules is now niyam: run niyam. The old name still works for now.']);
    assert.deepEqual(await said(['version'], 'process-rules'), [], 'not version');
    assert.deepEqual(await said(['help']), [], 'not as niyam');
  });
});

describe('nameOf', () => {
  it("reads the package's name, as the bridge release's archive renames it", () => {
    assert.equal(nameOf({ name: '@athya-hq/process-rules', version: '1.0.0' }), '@athya-hq/process-rules');
    assert.equal(packageName(), '@veda-hq/niyam');
  });

  for (const raw of [null, 'x', {}, { name: 1 }]) {
    it(`throws for ${JSON.stringify(raw)}`, () => {
      assert.throws(() => nameOf(raw), /no string "name"/);
    });
  }
});
