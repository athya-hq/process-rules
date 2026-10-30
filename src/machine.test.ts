import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathsFor, sessionScript } from './agent.ts';
import { AGENT, AGENT_ID, FakeSys, HOME, KEY, TOKEN, capture } from './fake.test.ts';
import { machine, tokenInstructions } from './machine.ts';

const SESSION = `${HOME}/.config/process-rules/session.sh`;
const VERIFIED = {
  status: 200,
  json: { committer: { login: AGENT }, commit: { verification: { verified: true, reason: 'valid' } } },
};

/** A machine with nothing set up, answering yes to everything. */
function fresh(): FakeSys {
  const sys = new FakeSys();
  sys.answers = ['y', 'y', 'y', 'y', 'y'];
  sys.secrets = [TOKEN];
  sys.acceptToken(TOKEN, AGENT);
  let registered = false;
  sys.route('POST', '/user/ssh_signing_keys', () => {
    registered = true;
    return { status: 201, json: {} };
  });
  sys.route('GET', '/users/AthyaBot/ssh_signing_keys', () => ({
    status: 200,
    json: registered ? [{ key: 'ssh-ed25519 AAAAkey' }] : [],
  }));
  sys.route('GET', '/repos/athya-hq/athya_mono/commits/abc123', VERIFIED);
  return sys;
}

async function setUp(sys: FakeSys): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await machine(sys, io), out, err };
}

describe('machine', () => {
  it('sets up a fresh machine and proves a Verified commit', async () => {
    const sys = fresh();
    const { code, out, err } = await setUp(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.equal(sys.keychain.get(AGENT), TOKEN);
    assert.equal(sys.files.get(SESSION), sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    assert.deepEqual(sys.opened, ['https://github.com/settings/personal-access-tokens/new']);
    assert.ok(out.includes('✓ GitHub shows the test commit Verified by AthyaBot; branch process-rules/verify-athyabot-1000 deleted'));
    assert.ok(!out.join('\n').includes(TOKEN), 'the token is never printed');

    const register = sys.requests.find((r) => r.method === 'POST');
    assert.equal(register?.token, TOKEN);
    const keygen = sys.calls.find((c) => c.command === 'ssh-keygen');
    assert.deepEqual(keygen?.args, ['-q', '-t', 'ed25519', '-C', 'AthyaBot signing', '-N', '', '-f', KEY]);

    const git = sys.calls.filter((c) => c.command === 'git' && c.env);
    assert.deepEqual(
      git.map((c) => c.args.slice(0, 2).join(' ')),
      ['init -q', 'fetch -q', 'commit-tree -S', 'push -q', 'push -q'],
    );
    assert.equal(git[0]?.env?.GH_TOKEN, TOKEN);
    assert.equal(git[0]?.env?.GIT_COMMITTER_EMAIL, '42+AthyaBot@users.noreply.github.com');
    assert.equal(git.at(-1)?.args[3], ':refs/heads/process-rules/verify-athyabot-1000');
    assert.deepEqual(sys.calls.at(-1)?.args, ['-rf', '/tmp/verify']);
  });

  it('skips what is already done', async () => {
    const sys = new FakeSys().ready();
    sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    sys.route('GET', '/repos/athya-hq/athya_mono/commits/abc123', VERIFIED);
    sys.answers = ['y'];
    const { code } = await setUp(sys);
    assert.equal(code, 0);
    assert.equal(sys.asked.length, 1);
    assert.match(sys.asked[0] ?? '', /Push one signed test commit/);
    assert.ok(!sys.calls.some((c) => c.command === 'ssh-keygen'));
  });

  it('falls back to the browser when the API cannot add the key', async () => {
    const sys = fresh();
    let added = false;
    sys.route('POST', '/user/ssh_signing_keys', { status: 403, json: {} });
    sys.route('GET', '/users/AthyaBot/ssh_signing_keys', () => ({
      status: 200,
      json: added ? [{ key: 'ssh-ed25519 AAAAkey' }] : [],
    }));
    const ask = sys.ask.bind(sys);
    sys.ask = (question) => {
      if (question.startsWith('Press Enter')) added = true;
      return ask(question);
    };
    sys.answers = ['y', 'y', 'y', '', 'y', 'y'];
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.ok(out.includes("GitHub's API refused (HTTP 403). Add it in the browser, signed in as AthyaBot:"));
    assert.ok(out.includes('  ssh-ed25519 AAAAkey AthyaBot signing'));
    assert.deepEqual(sys.opened.at(-1), 'https://github.com/settings/ssh/new');
  });

  it('fails when the key is still not listed', async () => {
    const sys = fresh();
    sys.route('POST', '/user/ssh_signing_keys', { status: 403, json: {} });
    sys.answers = ['y', 'y', 'y', ''];
    const { code, err } = await setUp(sys);
    assert.equal(code, 1);
    assert.deepEqual(err, ["machine: GitHub still does not list the key as AthyaBot's signing key"]);
  });

  it('replaces a stored token GitHub refuses', async () => {
    const sys = fresh();
    sys.keychain.set(AGENT, 'stale');
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.ok(out.includes("The stored token is refused or is not AthyaBot's; replacing it."));
    assert.equal(sys.keychain.get(AGENT), TOKEN);
  });

  for (const [secret, login, message] of [
    ['', undefined, 'machine: GitHub refuses that token'],
    ['bad', undefined, 'machine: GitHub refuses that token'],
    ['owners', 'AlokBansal8', 'machine: that token acts as AlokBansal8; create it signed in as AthyaBot'],
  ] as const) {
    it(`refuses the pasted token "${secret}"`, async () => {
      const sys = fresh();
      sys.secrets = [secret];
      if (login) sys.acceptToken(secret, login);
      const { code, err } = await setUp(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
      assert.equal(sys.keychain.size, 0);
    });
  }

  it('says so when the keychain does not take the token', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.args[0] === '-i' ? { code: 1, stdout: '', stderr: '' } : undefined);
    const { code, err } = await setUp(sys);
    assert.deepEqual({ code, err }, { code: 1, err: ['machine: the keychain did not take the token'] });
  });

  it('reports a failed ssh-keygen', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.command === 'ssh-keygen' ? { code: 1, stdout: '', stderr: 'no space\n' } : undefined);
    const { code, err } = await setUp(sys);
    assert.deepEqual({ code, err }, { code: 1, err: ['machine: ssh-keygen failed: no space'] });
  });

  for (const [index, step] of ['signing key', 'token', 'register key', 'session file', 'test commit'].entries()) {
    it(`stops without changing anything more when "${step}" is declined`, async () => {
      const sys = fresh();
      sys.answers = [...Array<string>(index).fill('y'), 'n'];
      const { code, err } = await setUp(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [`machine: stopped at "${step}"; nothing after it was changed`] });
      assert.equal(sys.files.has(SESSION), index > 3);
    });
  }

  for (const [args, message] of [
    ['init', 'machine: git init failed: boom'],
    ['fetch', 'machine: git fetch failed: boom'],
    ['commit-tree', 'machine: signing the test commit failed: boom'],
    ['push', 'machine: pushing as AthyaBot failed: boom'],
  ] as const) {
    it(`reports a failed git ${args} and cleans up`, async () => {
      const sys = fresh();
      sys.execOverride = (call) =>
        call.command === 'git' && call.args[0] === args ? { code: 1, stdout: '', stderr: 'boom\n' } : undefined;
      const { code, err } = await setUp(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [message] });
      assert.equal(sys.calls.at(-1)?.command, 'rm');
    });
  }

  for (const [name, json, shown] of [
    ['unverified', { committer: { login: AGENT }, commit: { verification: { verified: false, reason: 'unknown_key' } } }, `committer: ${AGENT}; verified: false (unknown_key)`],
    ['committed by someone else', { committer: { login: 'AlokBansal8' }, commit: { verification: { verified: true, reason: 'valid' } } }, 'committer: AlokBansal8; verified: true (valid)'],
    ['unreadable', null, 'committer: none; verified: undefined (no reason)'],
  ] as const) {
    it(`fails a test commit that is ${name}`, async () => {
      const sys = fresh();
      sys.route('GET', '/repos/athya-hq/athya_mono/commits/abc123', { status: 200, json });
      const { code, out, err } = await setUp(sys);
      assert.equal(code, 1);
      assert.ok(out.includes(`  ${shown}`), out.join('\n'));
      assert.deepEqual(err, ['machine: GitHub does not show the commit Verified by AthyaBot']);
    });
  }
});

describe('tokenInstructions', () => {
  it('names the repo, owner and permissions', () => {
    const text = tokenInstructions(AGENT, 'athya-hq/athya_mono').join('\n');
    assert.match(text, /signed in as AthyaBot/);
    assert.match(text, /Name: athya_mono agent · Resource owner: athya-hq/);
    assert.match(text, /Only select repositories → athya-hq\/athya_mono/);
    assert.match(text, /Projects: Read and write/);
  });
});
