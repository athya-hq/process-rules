import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CLOUD_DIR, CLOUD_NODE, CLOUD_NODE_SHA256, INSTALL_FAILED as FAILED, cloudRepoScript, cloudScriptVersion, cloudSetup, cloudSetupSnippet, releaseTarball } from './cloud.ts';
import { capture } from './fake.test.ts';
import { CLOUD_SETUP_PATH, WORKFLOW_PATH } from './onboard-pull.ts';

const SHA = 'ab'.repeat(32);

describe('cloudScriptVersion', () => {
  it('reads the release the cloud setup file installs, and nothing from another file', () => {
    assert.equal(cloudScriptVersion(cloudRepoScript('9.8.7', SHA)), '9.8.7');
    assert.equal(cloudScriptVersion('#!/bin/bash\necho hi\n'), undefined);
  });
});

describe('cloudRepoScript', () => {
  const script = cloudRepoScript('9.8.7', SHA);

  it('installs Node and that release of the CLI, each checked, and puts niyam on PATH', () => {
    assert.match(script, /^#!\/bin\/bash\n# process-rules 9\.8\.7 for Claude cloud sessions/);
    assert.ok(script.includes(`node=${CLOUD_NODE}\n`));
    assert.ok(script.includes('https://nodejs.org/dist/v$node/node-v$node-linux-$arch.tar.xz'));
    assert.ok(script.includes(`-o "$dir/process-rules.tgz" ${releaseTarball('9.8.7')}\n`));
    assert.equal(releaseTarball('9.8.7'), 'https://github.com/veda-hq/niyam/releases/download/v9.8.7/veda-hq-niyam-9.8.7.tgz');
    assert.equal(releaseTarball('0.6.1'), 'https://github.com/veda-hq/niyam/releases/download/v0.6.1/athya-hq-process-rules-0.6.1.tgz', 'a release before niyam: its old asset');
    assert.ok(script.includes('ln -sf /usr/local/bin/process-rules /usr/local/bin/niyam\n'), 'niyam and its old name both run it');
    assert.ok(script.includes(`echo "${SHA}  $dir/process-rules.tgz" | sha256sum -c --quiet -\n`));
    assert.ok(script.includes(`at the version ${WORKFLOW_PATH} pins`));
    assert.equal(spawnSync('bash', ['-n', '-c', script]).status, 0, 'bash reads it');
  });

  describe('run by a real shell, with the downloads stood in for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-rules-cloud-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    /**
     * Runs the script in a folder of its own, with curl, tar, uname and sha256sum stood in: sha256sum exits
     * `checked`, and `node`, when given, is a Node already unpacked that answers its version so.
     */
    function setup(name: string, checked: number, options: { node?: string; env?: Record<string, string> } = {}) {
      const root = join(dir, name);
      const bin = join(root, 'bin');
      const local = join(root, 'local');
      const opt = join(root, 'opt');
      mkdirSync(bin, { recursive: true });
      mkdirSync(local);
      const log = join(root, 'fetched');
      writeFileSync(join(bin, 'curl'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; https*) url=$1 ;; esac; shift; done\necho "$url" > "$out"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'tar'), `#!/bin/sh\ncat "$3" >> "${log}"\necho "$5" >> "${log}"\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho aarch64\n', { mode: 0o755 });
      writeFileSync(join(bin, 'sha256sum'), `#!/bin/sh\ncat >> "${root}/checked"\nexit ${checked}\n`, { mode: 0o755 });
      if (options.node) {
        const nodeBin = join(opt, `node-v${CLOUD_NODE}-linux-arm64`, 'bin');
        mkdirSync(nodeBin, { recursive: true });
        writeFileSync(join(nodeBin, 'node'), `#!/bin/sh\necho ${options.node}\n`, { mode: 0o755 });
      }
      // /opt and /usr/local/bin become folders under `root`.
      const runnable = cloudRepoScript('9.8.7', SHA)
        .replaceAll(CLOUD_DIR, opt)
        .replaceAll('/usr/local/bin/process-rules', join(local, 'process-rules'))
        .replaceAll('/usr/local/bin/niyam', join(local, 'niyam'))
        .replace('process-rules version', 'true');
      const result = spawnSync('bash', ['-c', runnable], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, ...options.env } });
      const read = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');
      return { result, opt, local, fetched: read(log), checked: read(join(root, 'checked')) };
    }

    it('writes a niyam that runs the CLI with that Node, once each matches its sha256', () => {
      const { result, opt, local, fetched, checked } = setup('good', 0);
      assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: '', stderr: '' });
      assert.equal(checked, `${CLOUD_NODE_SHA256.arm64}  ${opt}/node.tar.xz\n${SHA}  ${opt}/process-rules.tgz\n`);
      assert.equal(
        readFileSync(join(local, 'niyam'), 'utf8'),
        `#!/bin/sh\nexec ${opt}/node-v${CLOUD_NODE}-linux-arm64/bin/node ${opt}/cli-9.8.7/package/dist/cli.js "$@"\n`,
      );
      assert.equal(fetched, `https://nodejs.org/dist/v${CLOUD_NODE}/node-v${CLOUD_NODE}-linux-arm64.tar.xz\n${opt}\n${releaseTarball('9.8.7')}\n${opt}/cli-9.8.7\n`);
      assert.equal(existsSync(join(opt, 'from-setup')), false, 'not run by the Setup snippet');
    });

    it('keeps a Node already unpacked at its version, fetching the CLI alone', () => {
      const { result, opt, fetched, checked } = setup('kept', 0, { node: `v${CLOUD_NODE}` });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(checked, `${SHA}  ${opt}/process-rules.tgz\n`);
      assert.equal(fetched, `${releaseTarball('9.8.7')}\n${opt}/cli-9.8.7\n`);
      const other = setup('other', 0, { node: 'v22.0.0' });
      assert.match(other.fetched, /^https:\/\/nodejs\.org\//, 'another Node is fetched again');
    });

    it('leaves a mark when the Setup snippet ran it', () => {
      const { result, opt } = setup('marked', 0, { env: { PROCESS_RULES_SETUP: '1' } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(opt, 'from-setup')), true);
    });

    it('stops, unpacking nothing and writing no niyam, when a download does not match its sha256', () => {
      const { result, local, fetched } = setup('bad', 1);
      assert.equal(result.status, 1);
      assert.equal(fetched, '');
      assert.equal(existsSync(join(local, 'niyam')), false);
      const cli = setup('bad-cli', 1, { node: `v${CLOUD_NODE}` });
      assert.equal(cli.result.status, 1);
      assert.equal(cli.fetched, '');
    });

    it('stops on a machine with no Node build', () => {
      const bin = join(dir, 'odd');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho riscv64\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', cloudRepoScript('9.8.7', SHA)], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
      assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 1, stderr: 'niyam: no Node for riscv64\n' });
    });
  });
});

describe('cloudSetupSnippet', () => {
  const snippet = cloudSetupSnippet();

  it('names no version, so a new release needs no new paste', () => {
    assert.doesNotMatch(snippet, /\d+\.\d+\.\d+/);
    assert.ok(snippet.includes(CLOUD_SETUP_PATH));
    assert.equal(spawnSync('bash', ['-n', '-c', snippet]).status, 0, 'bash reads it');
  });

  it('runs in a shell of its own, so it can go first in a Setup script', () => {
    const lines = snippet.trimEnd().split('\n');
    assert.match(lines[2] ?? '', /^bash <<'PROCESS_RULES' \|\| echo ".*" >&2$/);
    assert.equal(lines.at(-1), 'PROCESS_RULES');
    assert.equal(lines.filter((line) => line === 'PROCESS_RULES').length, 1);
    assert.equal(lines.slice(0, 3).some((line) => /^set /.test(line)), false, "the repo's own setup after it keeps its shell options");
  });

  describe('run by a real shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'process-rules-snippet-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const then = 'echo "repo setup ran"\nexit 0\n';

    /** Runs the snippet, then the repo's own setup, from `cwd`, as the Setup script runs from the folder holding the clone. */
    function setup(cwd: string) {
      const result = spawnSync('bash', ['-c', `${snippet}${then}`], { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    /** A clone at `clone` whose cloud setup file says how it ran and exits `code`. */
    function clone(at: string, code = 0): void {
      mkdirSync(join(at, dirname(CLOUD_SETUP_PATH)), { recursive: true });
      writeFileSync(join(at, CLOUD_SETUP_PATH), `echo "ran mark=$PROCESS_RULES_SETUP stdin=$(cat)"\nexit ${code}\n`);
    }

    it("runs the clone's cloud setup file from the folder that holds the clone, then the repo's own setup", () => {
      const home = join(dir, 'home');
      clone(join(home, 'example-app'));
      assert.deepEqual(setup(home), { status: 0, stdout: 'ran mark=1 stdin=\nrepo setup ran\n', stderr: '' });
    });

    it('runs it from the clone itself', () => {
      const app = join(dir, 'app');
      clone(app);
      assert.deepEqual(setup(app), { status: 0, stdout: 'ran mark=1 stdin=\nrepo setup ran\n', stderr: '' });
    });

    it("says so when the install fails, and runs the repo's own setup", () => {
      const home = join(dir, 'failing');
      clone(join(home, 'example-app'), 1);
      assert.deepEqual(setup(home), { status: 0, stdout: 'ran mark=1 stdin=\nrepo setup ran\n', stderr: `${FAILED}\n` });
    });

    it('names the missing file and its fix, and goes on', () => {
      const empty = join(dir, 'empty');
      mkdirSync(empty);
      assert.deepEqual(setup(empty), {
        status: 0,
        stdout: 'repo setup ran\n',
        stderr: `niyam: no ${CLOUD_SETUP_PATH} in the clone under ${realpathSync(empty)}; run niyam onboard, which writes it\n${FAILED}\n`,
      });
    });
  });
});

describe('cloudSetup', () => {
  it('prints the Setup snippet, and what else agent sessions need', () => {
    const { io, out, err } = capture();
    assert.equal(cloudSetup(io), 0);
    assert.deepEqual(out, [cloudSetupSnippet().trimEnd()]);
    assert.match(err[0] ?? '', /Setup script, once; it runs \.github\/process-rules\/cloud-setup\.sh, which niyam onboard writes, so a new release needs no new paste/);
    assert.match(err[0] ?? '', /Connect claude\.ai's GitHub as the agent account/);
    assert.match(err[0] ?? '', /its own Setup script, put this first, then the repo's own: a repo's script may end with exit/);
  });
});
