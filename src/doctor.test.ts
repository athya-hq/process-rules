import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_TOKEN, launcherPath, pathsFor, sessionScript } from './agent.ts';
import { FROM_SETUP, PROXY_TOKEN, cloudRepoScript } from './cloud.ts';
import { doctor } from './doctor.ts';
import { declinedPath, movedPath, ownerFixes } from './lockout.ts';
import { CLOUD_SETUP_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
import { workflow } from './onboard.ts';
import { AGENT, AGENT_ID, CLASSIC, FakeSys, HOME, KEY, NOW, ROOT, TOKEN, capture } from './fake.test.ts';
import { packageVersion } from './version.ts';

const SESSION = `${HOME}/.config/process-rules/examplebot/session.sh`;
const LAUNCHER = launcherPath(HOME);

function healthy(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
  return sys;
}

async function check(sys: FakeSys, named?: string): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await doctor(sys, io, named), out, err };
}

/** The lines of one check: what doctor printed that starts with `mark`. */
function marked(out: string[], mark: string): string[] {
  return out.filter((line) => line.startsWith(`${mark}  `));
}

describe('doctor', () => {
  it('refuses a platform with no token store, naming macOS', async () => {
    assert.deepEqual(await check(Object.assign(healthy(), { platform: 'win32' })), {
      code: 1,
      out: [],
      err: ["doctor: process-rules supports macOS only, where the keychain holds the agent's token; this machine runs win32"],
    });
  });

  it('refuses Linux that is not a Claude cloud session', async () => {
    for (const remote of [undefined, 'false', '1']) {
      const sys = Object.assign(healthy(), { platform: 'linux' });
      sys.env = { ...sys.env, CLAUDE_CODE_REMOTE: remote };
      assert.deepEqual(await check(sys), {
        code: 1,
        out: [],
        err: ["doctor: process-rules supports macOS only, where the keychain holds the agent's token; this machine runs linux"],
      });
    }
  });

  it('passes when the machine is set up, its checks grouped', async () => {
    assert.deepEqual(await check(healthy()), {
      code: 0,
      out: [
        '◆  process-rules doctor   ExampleBot',
        '│',
        '◇  This Mac',
        '✓  signing key ~/.ssh/examplebot_signing',
        '✓  session file',
        '✓  launcher',
        '│',
        '◇  GitHub — as ExampleBot',
        '✓  token, ends in 90 days',
        '✓  signing key registered',
        '│',
        '└  All good',
      ],
      err: [],
    });
  });

  it('works with no terminal, uncoloured', async () => {
    const sys = healthy();
    sys.tty = false;
    sys.env = { ...sys.env, TERM: 'xterm-256color' };
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.ok(!out.some((line) => line.includes('\u001b[')));
    sys.tty = true;
    assert.ok((await check(sys)).out.some((line) => line.includes('\u001b[')), 'coloured on a terminal');
  });

  it('groups client hooks that reach GitHub outside as-agent under This repo, and still passes', async () => {
    const sys = healthy();
    sys.files.set('/repo/.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gh pr view' }] }] } }));
    const { code, out, err } = await check(sys);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.deepEqual(out.slice(-5), [
      '│',
      '◇  This repo',
      '▲  .claude/settings.json Stop hook "gh pr view" reaches GitHub outside as-agent, so gets 401 → run its gh or git via process-rules as-agent --session <session_id> -- (exit 77 when not the agent)',
      '│',
      '└  1 to fix',
    ]);
  });

  it('gives the owner steps while the desktop app started before gh moved to the agent, and still passes', async () => {
    const sys = healthy();
    sys.files.set(movedPath(HOME, AGENT), JSON.stringify({ at: NOW.toISOString(), logins: ['example-owner'] }));
    sys.appStarted = new Date(NOW.getTime() - 3_600_000);
    const stale = await check(sys);
    assert.equal(stale.code, 0);
    assert.deepEqual(marked(stale.out, '▲'), ownerFixes(['example-owner']).map((fix) => `▲  ${fix.text} → ${fix.fix}`));
    assert.equal(stale.out.at(-1), '└  2 to fix');
    sys.appStarted = new Date(NOW.getTime() + 60_000);
    assert.deepEqual(marked((await check(sys)).out, '▲'), [], 'restarted since');
  });

  it("says nothing about a CODEOWNERS naming the owner: the owner keeps reviewing agent pull requests", async () => {
    const sys = healthy();
    sys.files.set('/repo/.github/CODEOWNERS', '* @example-owner\n');
    const { code, out } = await check(sys);
    assert.deepEqual({ code, last: out.at(-1) }, { code: 0, last: '└  All good' });
  });

  it('refuses a machine never set up, each problem with its fix', async () => {
    const { code, out, err } = await check(new FakeSys());
    assert.deepEqual({ code, err }, { code: 1, err: [] });
    assert.deepEqual(out, [
      '◆  process-rules doctor   ExampleBot',
      '│',
      '◇  This Mac',
      '✗  ~/.ssh/examplebot_signing is missing → process-rules machine',
      '✗  session file missing → process-rules machine',
      '✗  launcher missing, so hooks need node on PATH → process-rules machine',
      '│',
      '◇  GitHub — as ExampleBot',
      "✗  no token in this Mac's keychain → process-rules machine",
      '✗  signing key not registered → process-rules machine',
      '│',
      '└  5 to fix',
    ]);
  });

  it('refuses a token GitHub rejects', async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'revoked');
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(marked(out, '✗'), ['✗  token: GitHub refuses the token (expired or revoked?) → process-rules machine']);
  });

  it("refuses a token that is someone else's", async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'ghp_owners');
    sys.acceptToken('ghp_owners', 'example-owner');
    assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  token: the token acts as example-owner, not ExampleBot → process-rules machine']);
  });

  it('refuses a fine-grained token', async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'github_pat_x');
    sys.acceptToken('github_pat_x', AGENT, {});
    assert.deepEqual(marked((await check(sys)).out, '✗'), [
      '✗  token: it is not a classic token, which process-rules needs (see its docs/decisions.md) → process-rules machine',
    ]);
  });

  it('warns about a token near its end, and still passes', async () => {
    const sys = healthy();
    sys.acceptToken(TOKEN, AGENT, { ...CLASSIC, 'github-authentication-token-expiration': '2026-11-10 12:00:00 UTC' });
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(marked(out, '▲'), ['▲  token ends in 11 days → process-rules machine']);
    assert.equal(out.at(-1), '└  1 to fix');
  });

  it('warns at 14 days, not at 15', async () => {
    for (const [ends, mark] of [['2026-11-13 12:00:00 UTC', '▲'], ['2026-11-14 12:00:00 UTC', '✓']] as const) {
      const sys = healthy();
      sys.acceptToken(TOKEN, AGENT, { ...CLASSIC, 'github-authentication-token-expiration': ends });
      assert.ok((await check(sys)).out.some((line) => line.startsWith(`${mark}  token`)), ends);
    }
  });

  it("uses GitHub's spelling of a login typed in another case", async () => {
    for (const typed of ['examplebot', 'EXAMPLEBOT']) assert.equal((await check(healthy(), typed)).code, 0, typed);
  });

  it("warns about the owner's credentials an agent session could reach, and still passes", async () => {
    const sys = healthy();
    sys.ghAccounts = ['example-owner'];
    sys.gitPassword = true;
    sys.files.set(`${HOME}/.ssh/id_ed25519`, 'open:key');
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(marked(out, '▲'), [
      '▲  gh is signed in as example-owner → process-rules machine',
      '▲  a saved git password for github.com → process-rules machine',
      '▲  ~/.ssh/id_ed25519 has no passphrase → ssh-keygen -p -f ~/.ssh/id_ed25519',
    ]);
    assert.equal(out.at(-1), '└  3 to fix');
  });

  it('reports a declined lockout as chosen, and warns about an account signed in since', async () => {
    const sys = healthy();
    sys.ghAccounts = ['example-owner', 'new-owner'];
    sys.gitPassword = true;
    sys.files.set(declinedPath(HOME, AGENT), JSON.stringify({ ghLogins: ['example-owner'], gitPassword: true }));
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.ok(out.includes('✓  gh stays signed in as example-owner, as you chose'));
    assert.ok(out.includes('✓  the saved git password for github.com stays, as you chose'));
    assert.deepEqual(marked(out, '▲'), ['▲  gh is signed in as new-owner → process-rules machine']);
  });

  it('checks a named agent outside any repository', async () => {
    const sys = healthy();
    sys.inRepo = false;
    sys.files.delete('/repo/.github/process-rules.json');
    assert.equal((await check(sys, AGENT)).code, 0);
  });

  it('refuses a key GitHub does not list', async () => {
    const sys = healthy();
    sys.route('GET', '/users/ExampleBot/ssh_signing_keys', { status: 200, json: [{ key: 'ssh-ed25519 other' }] });
    const { code, out } = await check(sys);
    assert.deepEqual({ code, broken: marked(out, '✗') }, { code: 1, broken: ['✗  signing key not registered → process-rules machine'] });
  });

  it('refuses a key pair whose halves do not match, to be moved aside', async () => {
    const sys = healthy();
    sys.files.set(`${KEY}.pub`, 'ssh-ed25519 other');
    assert.deepEqual(marked((await check(sys)).out, '✗'), [
      '✗  ~/.ssh/examplebot_signing.pub does not match ~/.ssh/examplebot_signing → move it aside, then process-rules machine',
      '✗  signing key not registered → process-rules machine',
    ]);
  });

  it('names a launcher whose node is gone', async () => {
    const sys = healthy();
    sys.execOverride = (call) => (call.command === LAUNCHER ? { code: 127, stdout: '', stderr: '/gone/bin/node: not found\n' } : undefined);
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(marked(out, '✗'), ['✗  launcher does not run (/gone/bin/node: not found); its node removed? → process-rules machine']);
    assert.equal(sys.calls.find((c) => c.command === LAUNCHER)?.env?.PATH, '/usr/bin:/bin', 'runs it without the PATH of this shell');
  });

  it('names a launcher that fails without saying why', async () => {
    const sys = healthy();
    sys.execOverride = (call) => (call.command === LAUNCHER ? { code: 3, stdout: '', stderr: '' } : undefined);
    assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  launcher does not run (exit 3); its node removed? → process-rules machine']);
  });

  it('accepts a token whose login differs only in case', async () => {
    const sys = healthy();
    sys.acceptToken(TOKEN, 'examplebot');
    assert.equal((await check(sys)).code, 0);
  });

  it('names each check GitHub could not answer, and still runs the rest', async () => {
    const sys = healthy();
    sys.http = () => Promise.reject(new Error('rate limited'));
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(marked(out, '✓'), ['✓  signing key ~/.ssh/examplebot_signing', '✓  launcher']);
    assert.deepEqual(marked(out, '✗'), [
      '✗  session file: cannot ask GitHub (rate limited) → process-rules doctor again',
      '✗  token: cannot ask GitHub (rate limited) → process-rules doctor again',
      '✗  signing key: cannot ask GitHub (rate limited) → process-rules doctor again',
    ]);
  });

  it('reports a thrown non-error from GitHub', async () => {
    const sys = healthy();
    sys.http = () => Promise.reject('down');
    assert.ok((await check(sys)).out.includes('✗  token: cannot ask GitHub (down) → process-rules doctor again'));
  });

  it('refuses a stale session file', async () => {
    const sys = healthy();
    sys.files.set(SESSION, 'old');
    assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  session file out of date → process-rules machine']);
  });
});

describe('doctor in a Claude cloud session', () => {
  const v = packageVersion();
  const WORKFLOW = `${ROOT}/${WORKFLOW_PATH}`;
  const CLOUD_FILE = `${ROOT}/${CLOUD_SETUP_PATH}`;
  const PASTE = "paste what process-rules cloud-setup prints into the cloud environment's Setup script, once";

  /**
   * A cloud session session-start gave the agent's identity, in a clone whose
   * workflow pins this CLI and whose cloud setup file installs it, set up by
   * the Setup snippet: no keychain, GitHub reached through the proxy as `login`.
   */
  function cloud(login: string | null = AGENT): FakeSys {
    const sys = new FakeSys();
    sys.platform = 'linux';
    sys.env = { CLAUDE_CODE_REMOTE: 'true', GH_TOKEN: PROXY_TOKEN, PROCESS_RULES_AGENT: AGENT };
    sys.files.set(WORKFLOW, workflow('main', v, false));
    sys.files.set(CLOUD_FILE, cloudRepoScript(v, 'ab'.repeat(32)));
    sys.files.set(FROM_SETUP, '');
    if (login) sys.acceptToken(PROXY_TOKEN, login);
    return sys;
  }

  it('passes when the environment is set up, its checks grouped as on a Mac', async () => {
    const sys = cloud();
    assert.deepEqual(await check(sys), {
      code: 0,
      out: [
        '◆  process-rules doctor   ExampleBot',
        '│',
        '◇  This cloud session',
        `✓  ${CLOUD_SETUP_PATH} installs ${v}, as ${WORKFLOW_PATH} pins`,
        `✓  process-rules ${v} runs here`,
        `✓  the Setup script runs ${CLOUD_SETUP_PATH}`,
        '│',
        '◇  GitHub — as ExampleBot',
        "✓  the proxy acts as ExampleBot, an agent the repo's settings name",
        "✓  session-start gave this session ExampleBot's identity",
        '│',
        '└  All good',
      ],
      err: [],
    });
    assert.equal(sys.requests.at(-1)?.token, PROXY_TOKEN, 'asks through the proxy');
    assert.ok(!sys.calls.some((call) => call.command.endsWith('security')), 'no keychain');
  });

  it('says to run onboard again when the cloud setup file and the pin disagree', async () => {
    const sys = cloud();
    sys.files.set(WORKFLOW, workflow('main', '0.0.1', false));
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(marked(out, '✗'), [`✗  ${CLOUD_SETUP_PATH} installs ${v}, but ${WORKFLOW_PATH} pins v0.0.1 → process-rules onboard again`]);
  });

  it('says to run onboard again when the repo has no cloud setup file, or one onboard did not write', async () => {
    for (const file of [undefined, '#!/bin/bash\necho mine\n']) {
      const sys = cloud();
      if (file === undefined) sys.files.delete(CLOUD_FILE);
      else sys.files.set(CLOUD_FILE, file);
      const { code, out } = await check(sys);
      assert.equal(code, 1);
      assert.deepEqual(marked(out, '✗'), [
        `✗  ${CLOUD_SETUP_PATH} missing, or not the file onboard writes, so the Setup script installs no process-rules → process-rules onboard again`,
      ]);
      assert.ok(out.includes(`✓  process-rules ${v} runs here`), 'still checked against the pin');
    }
  });

  it('warns when the workflow pins no one version, and still passes', async () => {
    for (const pins of [undefined, workflow('main', v, false).replace(`process-rules-ref: v${v}`, 'process-rules-ref: v0.0.2')]) {
      const sys = cloud();
      if (pins === undefined) sys.files.delete(WORKFLOW);
      else sys.files.set(WORKFLOW, pins);
      const { code, out } = await check(sys);
      assert.equal(code, 0);
      assert.deepEqual(marked(out, '▲'), [
        `▲  ${WORKFLOW_PATH} is missing or pins no one version, so ${CLOUD_SETUP_PATH} is not checked against it → process-rules onboard again`,
      ]);
    }
  });

  it('warns when this session runs another release than the repo installs, and still passes', async () => {
    const sys = cloud();
    sys.files.set(WORKFLOW, workflow('main', '0.0.1', false));
    sys.files.set(CLOUD_FILE, cloudRepoScript('0.0.1', 'ab'.repeat(32)));
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(marked(out, '▲'), [`▲  this session runs process-rules ${v}, not the 0.0.1 ${CLOUD_SETUP_PATH} installs → bash ${CLOUD_SETUP_PATH}, or a new session`]);
    assert.ok(!sys.calls.some((call) => call.command === 'bash'), 'only reads: installs nothing');
  });

  it('warns about a release the workflow pins that no cloud setup file installs', async () => {
    const sys = cloud();
    sys.files.delete(CLOUD_FILE);
    sys.files.set(WORKFLOW, workflow('main', '0.0.1', false));
    assert.deepEqual(marked((await check(sys)).out, '▲'), [
      `▲  this session runs process-rules ${v}, not the v0.0.1 ${WORKFLOW_PATH} pins → process-rules onboard again, then a new session`,
    ]);
  });

  it('asks for the one paste when the Setup script did not run the repo file, and still passes', async () => {
    const sys = cloud();
    sys.files.delete(FROM_SETUP);
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(marked(out, '▲'), [`▲  ${FROM_SETUP} missing, so the cloud environment's Setup script does not run ${CLOUD_SETUP_PATH} → ${PASTE}`]);
    assert.equal((await check(sys)).out.at(-1), '└  1 to fix');
  });

  it('refuses a proxy that acts as an account not among the agents', async () => {
    const sys = cloud('example-owner');
    sys.env.PROCESS_RULES_AGENT = undefined;
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.equal(out[0], '◆  process-rules doctor   example-owner');
    assert.ok(out.includes('◇  GitHub — as example-owner'));
    assert.deepEqual(marked(out, '✗'), [
      "✗  the proxy acts as example-owner, not ExampleBot → connect claude.ai's GitHub as ExampleBot",
      '✗  session-start did not give this session the agent identity, so gh and git stay locked out → a new session; its first process-rules line says why',
    ]);
  });

  it('accepts a login that differs only in case, and the agent named', async () => {
    const sys = cloud('examplebot');
    assert.equal((await check(sys)).code, 0);
    assert.equal((await check(cloud(), 'OtherBot')).code, 1, 'checked against the agent named');
  });

  it('names a proxy GitHub could not answer, and still runs the rest', async () => {
    const down = cloud(null);
    const { code, out } = await check(down);
    assert.equal(code, 1);
    assert.equal(out[0], '◆  process-rules doctor   ExampleBot');
    assert.deepEqual(marked(out, '✗'), ['✗  GitHub answered HTTP 401 when asked who this session is → process-rules doctor again']);
    const thrown = cloud();
    thrown.http = () => Promise.reject(new Error('ECONNRESET'));
    assert.deepEqual(marked((await check(thrown)).out, '✗'), ['✗  GitHub could not be asked who this session is (ECONNRESET) → process-rules doctor again']);
  });

  it('refuses a session session-start left locked out, or gave an account the settings do not name', async () => {
    const locked = cloud();
    locked.env = { CLAUDE_CODE_REMOTE: 'true', GH_TOKEN: NO_TOKEN };
    locked.acceptToken(PROXY_TOKEN, AGENT);
    const { code, out } = await check(locked);
    assert.equal(code, 1);
    assert.ok(out.includes("✓  the proxy acts as ExampleBot, an agent the repo's settings name"), 'asks with the proxy placeholder, never the lock');
    assert.deepEqual(marked(out, '✗'), [
      '✗  session-start did not give this session the agent identity, so gh and git stay locked out → a new session; its first process-rules line says why',
    ]);
    const other = cloud();
    other.env.PROCESS_RULES_AGENT = 'OtherBot';
    assert.deepEqual(marked((await check(other)).out, '✗'), [
      '✗  session-start did not give this session the agent identity, so gh and git stay locked out → a new session; its first process-rules line says why',
    ]);
  });

  it('refuses an identity session-start gave that is not the account the proxy acts as now', async () => {
    const sys = cloud('SecondBot');
    sys.files.set(`${ROOT}/.github/process-rules.json`, JSON.stringify({ owner: 'example-owner', agent: [AGENT, 'SecondBot'] }));
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.ok(out.includes("✓  the proxy acts as SecondBot, an agent the repo's settings name"));
    assert.deepEqual(marked(out, '✗'), [
      '✗  session-start did not give this session the agent identity, so gh and git stay locked out → a new session; its first process-rules line says why',
    ]);
  });

  it("refuses outside the repo's clone, and still checks the Setup script", async () => {
    const sys = cloud();
    sys.inRepo = false;
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(marked(out, '✗'), [`✗  ${ROOT} is not inside a git repository → process-rules doctor in the repo's clone`]);
    assert.ok(out.includes(`✓  the Setup script runs ${CLOUD_SETUP_PATH}`));
    assert.ok(!out.some((line) => line.includes('proxy acts as')), 'no agents to check the account against');
  });

  it('reads a cloud setup file it cannot read as missing', async () => {
    const sys = cloud();
    const read = sys.read.bind(sys);
    sys.read = (path) => {
      if (path === CLOUD_FILE) throw new Error('EACCES');
      return read(path);
    };
    assert.ok((await check(sys)).out.some((line) => line.startsWith(`✗  ${CLOUD_SETUP_PATH} missing`)));
  });

  it('names the session when neither GitHub nor the settings name an account', async () => {
    const sys = cloud(null);
    sys.inRepo = false;
    const { out } = await check(sys);
    assert.equal(out[0], '◆  process-rules doctor   this cloud session');
    assert.ok(out.includes('◇  GitHub — as this cloud session'));
  });

  it("refuses a clone with no settings", async () => {
    const sys = cloud();
    sys.files.delete(`${ROOT}/.github/process-rules.json`);
    assert.deepEqual(marked((await check(sys)).out, '✗'), [
      `✗  .github/process-rules.json not found in ${ROOT}, so the agents are not known → process-rules onboard again`,
    ]);
  });

  it('groups client hooks that reach GitHub outside as-agent under This repo, as on a Mac', async () => {
    const sys = cloud();
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gh pr view' }] }] } }));
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(out.slice(-5), [
      '│',
      '◇  This repo',
      '▲  .claude/settings.json Stop hook "gh pr view" reaches GitHub outside as-agent, so gets 401 → run its gh or git via process-rules as-agent --session <session_id> -- (exit 77 when not the agent)',
      '│',
      '└  1 to fix',
    ]);
  });
});
