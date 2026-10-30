import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeSys } from './fake.test.ts';
import { USAGE, packageVersion, run, versionOf } from './run.ts';

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

  it('refuses an unknown command with usage on stderr', async () => {
    assert.deepEqual(await capture(['deploy']), {
      code: 2,
      out: [],
      err: ['process-rules: unknown command "deploy"', USAGE],
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
          `process-rules ${command}: name the agent account after the command, or run it in a repo whose .github/process-rules.json names one`,
        ],
      });
    });
  }

  it('runs doctor', async () => {
    const { code, err } = await capture(['doctor'], () => new FakeSys());
    assert.equal(code, 1);
    assert.match(err.at(-1) ?? '', /must not push as ExampleBot/);
  });

  it('runs session-start, which always exits 0', async () => {
    const { code, out } = await capture(['session-start'], () => new FakeSys());
    assert.equal(code, 0);
    assert.match(out[0] ?? '', /CLAUDE_ENV_FILE is unset/);
  });

  it('passes the named agent on', async () => {
    const { err } = await capture(['doctor', 'OtherBot'], () => new FakeSys());
    assert.match(err.at(-1) ?? '', /must not push as OtherBot/);
  });

  it('runs pr-work-rules and pre-push, which takes git\'s two arguments and no third', async () => {
    assert.match((await capture(['pr-work-rules'], () => new FakeSys())).err[0] ?? '', /pr-work-rules runs in GitHub Actions/);
    const agent = new FakeSys();
    agent.env = { PROCESS_RULES_AGENT: 'ExampleBot' };
    agent.stdin = `refs/heads/work ${'a'.repeat(40)} refs/heads/work ${'b'.repeat(40)}\n`;
    const refused = await capture(['pre-push', 'origin', 'https://github.com/a/b.git'], () => agent);
    assert.equal(refused.code, 1);
    assert.match(refused.err[0] ?? '', /this agent session has no token/);
    assert.equal((await capture(['pre-push', 'origin', 'url', 'extra'])).code, 2);
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
      err: ['process-rules: unexpected argument "now"', USAGE],
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
      err: ['process-rules machine: odd'],
    });
  });

  it('refuses an extra argument', async () => {
    assert.deepEqual(await capture(['version', 'now']), {
      code: 2,
      out: [],
      err: ['process-rules: unexpected argument "now"', USAGE],
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
});
