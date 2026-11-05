import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { launcherPath, pathsFor, sessionScript } from './agent.ts';
import { doctor } from './doctor.ts';
import { declinedPath, movedPath, ownerFixes } from './lockout.ts';
import { AGENT, AGENT_ID, CLASSIC, FakeSys, HOME, KEY, NOW, TOKEN, capture } from './fake.test.ts';

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
