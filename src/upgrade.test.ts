import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { releaseTarball } from './cloud.ts';
import { FakeSys, HOME, capture } from './fake.test.ts';
import { run } from './run.ts';
import type { ExecResult } from './types.ts';
import { installedFindings, upgrade } from './upgrade.ts';
import { packageVersion } from './version.ts';

const LATEST = '/repos/athya-hq/process-rules/releases/latest';
const OLD = '0.5.20';
const NEW = '0.5.99';
const PNPM_BIN = `${HOME}/Library/pnpm/bin`;
const STRAY = '/usr/local/bin';

/**
 * A Mac running `OLD`, with `NEW` released and packaged, whose pnpm installs
 * into PNPM_BIN; `onPath` are the folders PATH names, each given the
 * version its process-rules prints, or undefined for none there.
 */
function machine(onPath: Record<string, string | undefined> = { [PNPM_BIN]: OLD }): FakeSys {
  const sys = new FakeSys();
  sys.env = { PATH: [...Object.keys(onPath), '/usr/bin', '/bin'].join(':') };
  sys.route('GET', LATEST, { status: 200, json: { tag_name: `v${NEW}`, assets: [{ name: 'notes.txt' }, { name: `athya-hq-process-rules-${NEW}.tgz` }] } });
  const versions = new Map<string, string>();
  for (const [dir, version] of Object.entries(onPath)) {
    if (version === undefined) continue;
    sys.files.set(`${dir}/process-rules`, '#!/usr/bin/env node');
    versions.set(`${dir}/process-rules`, version);
  }
  sys.execOverride = ({ command, args }): ExecResult | undefined => {
    if (command === 'pnpm' && args[0] === 'add') {
      // pnpm links the new release into its own folder, whatever PATH says.
      sys.files.set(`${PNPM_BIN}/process-rules`, '#!/usr/bin/env node');
      versions.set(`${PNPM_BIN}/process-rules`, NEW);
      return { code: 0, stdout: 'Done\n', stderr: '' };
    }
    if (command === 'pnpm' && args.join(' ') === 'bin -g') return { code: 0, stdout: `${PNPM_BIN}\n`, stderr: '' };
    const version = versions.get(command);
    if (version !== undefined && args.join(' ') === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
    return undefined;
  };
  return sys;
}

async function upgraded(sys: FakeSys, running = OLD): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  const code = await upgrade(sys, io, running);
  assert.equal(sys.spinning, 0, 'stops every spinner');
  return { code, out, err };
}

function installs(sys: FakeSys): string[][] {
  return sys.calls.filter((call) => call.command === 'pnpm' && call.args[0] === 'add').map((call) => [...call.args]);
}

describe('upgrade', () => {
  it('installs the newest release with pnpm, and says what the shell now runs', async () => {
    const sys = machine();
    assert.deepEqual(await upgraded(sys), {
      code: 0,
      out: [
        `upgrade: process-rules ${OLD} → ${NEW}`,
        `  pnpm add -g ${releaseTarball(NEW)}`,
        `upgrade: the shell runs process-rules ${NEW} (${PNPM_BIN}/process-rules)`,
      ],
      err: [],
    });
    assert.deepEqual(installs(sys), [['add', '-g', releaseTarball(NEW)]]);
    const asked = sys.requests.find((request) => request.url.endsWith(LATEST));
    assert.ok(asked, 'asks GitHub for the newest release');
    assert.equal(asked.token, undefined, 'with no token: the releases are public');
    assert.deepEqual(sys.spun, ['Asking GitHub for the newest release', `Installing process-rules ${NEW}`]);
  });

  it('says so and installs nothing when this is the newest release', async () => {
    const sys = machine({ [PNPM_BIN]: NEW });
    assert.deepEqual(await upgraded(sys, NEW), {
      code: 0,
      out: [`upgrade: process-rules ${NEW} is the newest release`, `upgrade: the shell runs process-rules ${NEW} (${PNPM_BIN}/process-rules)`],
      err: [],
    });
    assert.deepEqual(installs(sys), []);
  });

  it('never moves back from a CLI newer than the newest release', async () => {
    const sys = machine({ [PNPM_BIN]: NEW });
    const { code, out } = await upgraded(sys, '0.6.0');
    assert.equal(code, 0);
    assert.deepEqual(out, [
      `upgrade: this is process-rules 0.6.0, newer than the newest release, ${NEW}; upgrade never moves back`,
      `upgrade: the shell runs process-rules ${NEW} (${PNPM_BIN}/process-rules)`,
    ]);
    assert.deepEqual(installs(sys), []);
  });

  it('says how to install the newest release when it runs from elsewhere and PATH holds an older one', async () => {
    const sys = machine({ [PNPM_BIN]: OLD });
    for (const running of [NEW, '0.6.0']) {
      const { code, err } = await upgraded(sys, running);
      assert.equal(code, 1);
      assert.deepEqual(err, [
        `upgrade: the process-rules on PATH is not ${NEW}:`,
        `  ${PNPM_BIN}/process-rules  ${OLD}`,
        `  None of them is ${NEW}: install it with pnpm add -g ${releaseTarball(NEW)}, then run process-rules upgrade again to check PATH.`,
      ]);
    }
    assert.deepEqual(installs(sys), []);
  });

  it('names each copy on PATH when an older one would still run first, and says which to remove', async () => {
    const sys = machine({ [STRAY]: OLD, [PNPM_BIN]: OLD });
    const width = `${PNPM_BIN}/process-rules`.length;
    assert.deepEqual(await upgraded(sys), {
      code: 1,
      out: [`upgrade: process-rules ${OLD} → ${NEW}`, `  pnpm add -g ${releaseTarball(NEW)}`],
      err: [
        'upgrade: 2 copies of process-rules are on PATH, and the shell runs the first:',
        `  ${`${STRAY}/process-rules`.padEnd(width)}  ${OLD}`,
        `  ${PNPM_BIN}/process-rules  ${NEW}  ← keep`,
        `  Remove ${STRAY}/process-rules, or uninstall what put it there, so the shell runs ${PNPM_BIN}/process-rules.`,
      ],
    });
  });

  it('fails when a second copy is on PATH, even one at the new release', async () => {
    const sys = machine({ [PNPM_BIN]: OLD, [STRAY]: NEW });
    const { code, err } = await upgraded(sys);
    assert.equal(code, 1);
    assert.match(err.at(-1) ?? '', new RegExp(`Remove ${STRAY}/process-rules, or uninstall`));
    assert.match(err.join('\n'), new RegExp(`${PNPM_BIN}/process-rules  ${NEW}  ← keep`), "keeps pnpm's own copy");
  });

  it('reads empty and relative PATH entries against the working folder, as the shell does', async () => {
    for (const entry of ['', '.', 'bin']) {
      const sys = machine({ [PNPM_BIN]: OLD });
      const here = entry === 'bin' ? `${sys.cwd}/bin` : sys.cwd;
      sys.env = { PATH: `${entry}:${PNPM_BIN}` };
      sys.files.set(`${here}/process-rules`, '#!/usr/bin/env node');
      const inner = sys.execOverride;
      sys.execOverride = (call) => (call.command === `${here}/process-rules` ? { code: 0, stdout: `${OLD}\n`, stderr: '' } : inner(call));
      const { code, err } = await upgraded(sys);
      assert.equal(code, 1, `PATH entry ${JSON.stringify(entry)}`);
      assert.match(err.at(-1) ?? '', new RegExp(`Remove ${here}/process-rules, or uninstall`));
    }
  });

  it("fails when the only copy on PATH is an older one, and pnpm's folder is not on PATH", async () => {
    const sys = machine({ [STRAY]: OLD });
    const { code, err } = await upgraded(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, [
      `upgrade: the process-rules on PATH is not ${NEW}:`,
      `  ${STRAY}/process-rules  ${OLD}`,
      `  None of them is ${NEW}, which pnpm put in ${PNPM_BIN}/process-rules: remove ${STRAY}/process-rules, and put ${PNPM_BIN} on PATH (pnpm setup does).`,
    ]);
  });

  it('names a copy that does not run, and with pnpm silent about its folder, says to run upgrade again', async () => {
    const sys = machine({ [STRAY]: undefined, [PNPM_BIN]: OLD });
    sys.files.set(`${STRAY}/process-rules`, '');
    const inner = sys.execOverride;
    sys.execOverride = (call) => {
      if (call.command === 'pnpm' && call.args[0] === 'bin') return { code: 1, stdout: '', stderr: 'no global bin' };
      if (call.command === `${PNPM_BIN}/process-rules`) return { code: 0, stdout: 'not a version\n', stderr: '' };
      if (call.command === `${STRAY}/process-rules`) return { code: 126, stdout: '', stderr: 'permission denied\nmore' };
      return inner(call);
    };
    const { code, err } = await upgraded(sys);
    assert.equal(code, 1);
    assert.deepEqual(err.slice(1), [
      `  ${`${STRAY}/process-rules`.padEnd(`${PNPM_BIN}/process-rules`.length)}  does not run (permission denied)`,
      `  ${PNPM_BIN}/process-rules  does not run (printed "not a version")`,
      `  None of them is ${NEW}: remove ${STRAY}/process-rules and ${PNPM_BIN}/process-rules, then run process-rules upgrade again.`,
    ]);
  });

  it("fails when no process-rules is on PATH after the install, naming pnpm's folder", async () => {
    const sys = machine({});
    const { code, err } = await upgraded(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, [
      `upgrade: no process-rules is on PATH: pnpm put ${NEW} in ${PNPM_BIN}/process-rules; put ${PNPM_BIN} on PATH (pnpm setup does), then open a new shell`,
    ]);
  });

  it('passes with none on PATH when nothing was installed: the hooks run the launcher', async () => {
    const sys = machine({});
    sys.env = {};
    const { code, out } = await upgraded(sys, NEW);
    assert.equal(code, 0);
    assert.equal(out.at(-1), 'upgrade: no process-rules is on PATH; the hooks run the launcher process-rules machine writes');
  });

  it('fails without installing when GitHub cannot be reached', async () => {
    const sys = machine();
    sys.route('GET', LATEST, () => {
      throw new Error('GET api.github.com/repos could not be made: ENOTFOUND');
    });
    assert.deepEqual(await upgraded(sys), {
      code: 1,
      out: [],
      err: ['upgrade: GitHub could not be asked for the newest release (GET api.github.com/repos could not be made: ENOTFOUND); nothing installed'],
    });
    assert.deepEqual(installs(sys), []);
  });

  it("fails naming GitHub's answer when it is not a release", async () => {
    const sys = machine();
    sys.route('GET', LATEST, { status: 403, json: { message: 'rate limited' } });
    assert.deepEqual((await upgraded(sys)).err, ['upgrade: GitHub answered HTTP 403 when asked for the newest release; nothing installed']);
    sys.route('GET', LATEST, { status: 200, json: { tag_name: 'nightly' } });
    assert.deepEqual((await upgraded(sys)).err, ['upgrade: the newest release\'s tag, "nightly", is not vX.Y.Z; nothing installed']);
    sys.route('GET', LATEST, { status: 200, json: null });
    assert.deepEqual((await upgraded(sys)).err, ["upgrade: the newest release's tag, null, is not vX.Y.Z; nothing installed"]);
    assert.deepEqual(installs(sys), []);
  });

  it('waits for a release whose package is not attached yet', async () => {
    const sys = machine();
    sys.route('GET', LATEST, { status: 200, json: { tag_name: `v${NEW}` } });
    assert.deepEqual((await upgraded(sys)).err, [
      `upgrade: the v${NEW} release has no athya-hq-process-rules-${NEW}.tgz yet; run process-rules upgrade again once the Release workflow attaches it`,
    ]);
    assert.deepEqual(installs(sys), []);
  });

  it("fails with pnpm's own words when the install fails", async () => {
    const sys = machine();
    const inner = sys.execOverride;
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    sys.execOverride = (call) =>
      call.command === 'pnpm' && call.args[0] === 'add' ? { code: 1, stdout: 'Progress\n', stderr: `${lines.join('\n')}\n` } : inner(call);
    const { code, err } = await upgraded(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, [`upgrade: pnpm add -g failed (exit 1), so process-rules is still ${OLD}:`, ...lines.slice(3).map((line) => `  ${line}`), '  Progress']);
  });

  it('says pnpm is missing when it is not on PATH', async () => {
    const sys = machine();
    const inner = sys.execOverride;
    sys.execOverride = (call) => (call.command === 'pnpm' ? { code: 127, stdout: '', stderr: 'ENOENT' } : inner(call));
    assert.deepEqual((await upgraded(sys)).err, ['upgrade: pnpm is not on PATH, so nothing was installed; install pnpm, then run process-rules upgrade again']);
  });

  it('refuses in a Claude cloud session, whose CLI comes from the repo\'s cloud setup file', async () => {
    const sys = machine();
    sys.env = { ...sys.env, CLAUDE_CODE_REMOTE: 'true' };
    const { code, err } = await upgraded(sys);
    assert.equal(code, 1);
    assert.match(err[0] ?? '', /a Claude cloud session runs the release \.github\/process-rules\/cloud-setup\.sh installs/);
    assert.deepEqual(sys.requests, [], 'asks GitHub nothing');
    assert.deepEqual(installs(sys), []);
  });

  it('runs as a command, which takes no argument', async () => {
    const sys = machine({ [PNPM_BIN]: packageVersion() });
    sys.route('GET', LATEST, { status: 200, json: { tag_name: `v${packageVersion()}`, assets: [] } });
    const { io, out } = capture();
    assert.equal(await run(['upgrade'], io, () => sys), 0);
    assert.equal(out[0], `upgrade: process-rules ${packageVersion()} is the newest release`);
    const bad = capture();
    assert.equal(await run(['upgrade', 'now'], bad.io, () => sys), 2);
    assert.equal(bad.err[0], 'process-rules: unexpected argument "now"');
  });
});

describe("doctor's findings about the CLI", () => {
  it('is fine on the newest release, alone on PATH', async () => {
    assert.deepEqual(await installedFindings(machine({ [PNPM_BIN]: NEW }), NEW), [{ mark: '✓', text: `process-rules ${NEW}, the newest release` }]);
    assert.deepEqual(await installedFindings(machine({}), '0.6.0'), [{ mark: '✓', text: 'process-rules 0.6.0, the newest release' }]);
  });

  it('points at upgrade when a newer release is out', async () => {
    assert.deepEqual(await installedFindings(machine(), OLD), [{ mark: '▲', text: `process-rules ${OLD} runs here; ${NEW} is out`, fix: 'process-rules upgrade' }]);
  });

  it('says when GitHub cannot name the newest release', async () => {
    const sys = machine();
    sys.route('GET', LATEST, { status: 502, json: null });
    assert.deepEqual(await installedFindings(sys, OLD), [
      { mark: '▲', text: `process-rules ${OLD} runs here; GitHub answered HTTP 502 when asked for the newest release`, fix: 'process-rules doctor again' },
    ]);
  });

  it('is broken when PATH holds another copy', async () => {
    const findings = await installedFindings(machine({ [STRAY]: OLD, [PNPM_BIN]: NEW }), NEW);
    assert.deepEqual(findings.at(-1), {
      mark: '✗',
      text: `process-rules on PATH, the first runs: ${STRAY}/process-rules ${OLD}, ~/Library/pnpm/bin/process-rules ${NEW}`,
      fix: 'remove all but one, then process-rules upgrade',
    });
    const broken = machine({ [STRAY]: OLD });
    broken.execOverride = () => ({ code: 1, stdout: '', stderr: '' });
    assert.match((await installedFindings(broken, NEW)).at(-1)?.text ?? '', /process-rules does not run$/);
  });
});
