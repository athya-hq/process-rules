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
        err: [`process-rules ${command}: not inside a git repository`],
      });
    });
  }

  it('runs doctor', async () => {
    const { code, err } = await capture(['doctor'], () => new FakeSys());
    assert.equal(code, 1);
    assert.match(err.at(-1) ?? '', /must not push as AthyaBot/);
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
