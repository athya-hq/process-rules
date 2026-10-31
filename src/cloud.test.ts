import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CLOUD_NODE, cloudSetup, cloudSetupScript } from './cloud.ts';
import { capture } from './fake.test.ts';
import { packageVersion } from './version.ts';

describe('cloudSetupScript', () => {
  const script = cloudSetupScript('9.8.7');

  it('installs Node and that release of the CLI, and puts process-rules on PATH', () => {
    assert.match(script, /^#!\/bin\/bash\n# process-rules 9\.8\.7 for Claude cloud sessions/);
    assert.ok(script.includes(`node=${CLOUD_NODE}\n`));
    assert.ok(script.includes('https://nodejs.org/dist/v$node/node-v$node-linux-$arch.tar.xz'));
    assert.ok(script.includes('https://github.com/athya-hq/process-rules/releases/download/v9.8.7/athya-hq-process-rules-9.8.7.tgz'));
    assert.equal(spawnSync('bash', ['-n', '-c', script]).status, 0, 'bash reads it');
  });

  describe('run by a real shell, with the downloads stood in for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-rules-cloud-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('writes a process-rules that runs the CLI with that Node', () => {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      // curl, tar and uname stand in; /opt and /usr/local/bin become folders under `dir`.
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\necho "$2"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'tar'), '#!/bin/sh\ncat >> "$3/fetched"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho aarch64\n', { mode: 0o755 });
      const local = join(dir, 'local');
      mkdirSync(local);
      const runnable = cloudSetupScript('9.8.7')
        .replaceAll('/opt/process-rules', join(dir, 'opt'))
        .replaceAll('/usr/local/bin/process-rules', join(local, 'process-rules'))
        .replace('process-rules version', 'true');
      const result = spawnSync('bash', ['-c', runnable], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(join(local, 'process-rules'), 'utf8'),
        `#!/bin/sh\nexec ${join(dir, 'opt')}/node-v${CLOUD_NODE}-linux-arm64/bin/node ${join(dir, 'opt')}/package/dist/cli.js "$@"\n`,
      );
      assert.match(readFileSync(join(dir, 'opt', 'fetched'), 'utf8'), /linux-arm64\.tar\.xz\nhttps:\/\/github\.com\/.*-9\.8\.7\.tgz\n/);
    });

    it('stops on a machine with no Node build', () => {
      const bin = join(dir, 'odd');
      mkdirSync(bin);
      writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho riscv64\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', cloudSetupScript('9.8.7')], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
      assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 1, stderr: 'process-rules: no Node for riscv64\n' });
    });
  });
});

describe('cloudSetup', () => {
  it("prints this release's setup script, and what else agent sessions need", () => {
    const { io, out, err } = capture();
    assert.equal(cloudSetup(io), 0);
    assert.deepEqual(out, [cloudSetupScript(packageVersion()).trimEnd()]);
    assert.match(err[0] ?? '', /Setup script; connect claude\.ai's GitHub as the agent account/);
  });
});
