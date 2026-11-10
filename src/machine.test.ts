import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { launcherPath, launcherScript, pathsFor, sessionScript } from './agent.ts';
import { AGENT, AGENT_ID, CLASSIC, CLI, FakeSys, HOME, NODE, KEY, PRIVATE_KEY, PUBLIC_KEY, TOKEN, capture } from './fake.test.ts';
import { declinedPath, movedPath, ownerFixes, readMoved } from './lockout.ts';
import { TOKEN_PAGE, machine, machineArgs, tokenInstructions } from './machine.ts';
import { KEYCHAIN } from './token-store.ts';

const SESSION = `${HOME}/.config/process-rules/examplebot/session.sh`;
const LAUNCHER = launcherPath(HOME);
const INSTALLED = '/home/u/Library/pnpm/global/5/node_modules/@athya-hq/process-rules/dist/cli.js';

/** A machine with nothing set up, answering yes to the plan. */
function fresh(): FakeSys {
  const sys = new FakeSys();
  sys.answers = ['y'];
  sys.secrets = [TOKEN];
  sys.acceptToken(TOKEN, AGENT);
  let registered = false;
  sys.route('POST', '/user/ssh_signing_keys', () => {
    registered = true;
    return { status: 201, json: {} };
  });
  sys.route('GET', '/user/ssh_signing_keys', () => ({
    status: 200,
    json: registered ? [{ key: 'ssh-ed25519 AAAAkey' }] : [],
  }));
  return sys;
}

/** A machine set up for the agent, the session file included. */
function done(): FakeSys {
  const sys = new FakeSys().ready();
  sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
  return sys;
}

async function setUp(sys: FakeSys, ...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const { io, out, err } = capture();
  return { code: await machine(sys, io, args), out, err };
}

/** The plan fresh() shows: everything new. */
const FRESH_PLAN = [
  '◆  niyam machine   ExampleBot',
  '│',
  '◇  This Mac',
  '│    signing key   ~/.ssh/examplebot_signing (new)',
  '│    token         classic, in the keychain (new)',
  '│    session file  new',
  '│    launcher      ~/.config/process-rules/bin/process-rules',
  '│',
  '◇  GitHub — as ExampleBot',
  '│    signing key  register',
  '│',
];

describe('machine', () => {
  it('refuses a platform with no token store, naming macOS, before changing anything', async () => {
    const sys = Object.assign(fresh(), { platform: 'linux' });
    assert.deepEqual(await setUp(sys), {
      code: 1,
      out: [],
      err: ["machine: niyam supports macOS only, where the keychain holds the agent's token; this machine runs linux"],
    });
    assert.deepEqual([sys.calls, sys.requests, sys.asked], [[], [], []]);
  });

  it('shows one plan, asks once, then sets up a fresh machine one line per step', async () => {
    const sys = fresh();
    const { code, out, err } = await setUp(sys);
    assert.deepEqual(err, []);
    assert.equal(code, 0);
    assert.deepEqual(sys.chosen, ['Go ahead?']);
    assert.deepEqual(sys.asked, ['│  paste the token (hidden): ']);
    assert.deepEqual(out, [
      ...FRESH_PLAN,
      '◇  signing key',
      '◇  token page opened, for ExampleBot',
      ...tokenInstructions(AGENT).slice(1).map((line) => `│  ${line}`),
      '◇  token in the keychain',
      '◇  signing key registered',
      '◇  session file',
      '◇  launcher',
      '│',
      '└  ExampleBot is ready on this Mac',
    ]);
    assert.equal(sys.token(AGENT), TOKEN);
    assert.equal(sys.files.get(SESSION), sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    assert.deepEqual(sys.opened, [TOKEN_PAGE]);
    assert.ok(!out.join('\n').includes(TOKEN), 'the token is never printed');
    assert.equal(sys.spinning, 0, 'every spinner stopped');

    const register = sys.requests.find((r) => r.method === 'POST');
    assert.deepEqual(register, {
      url: 'https://api.github.com/user/ssh_signing_keys',
      method: 'POST',
      token: TOKEN,
      body: { title: 'process-rules signing', key: PUBLIC_KEY },
    });
    const lists = sys.requests.filter((r) => r.url.endsWith('/ssh_signing_keys') && r.method === 'GET');
    assert.deepEqual(
      lists.map((r) => [r.url, r.token]),
      [['https://api.github.com/user/ssh_signing_keys', TOKEN], ['https://api.github.com/user/ssh_signing_keys', TOKEN]],
      'reads the fresh list with the token, not the cached public one',
    );
    assert.equal(sys.modes.get(SESSION), 0o600);
    assert.ok(sys.dirs.includes(`${HOME}/.ssh`));
    assert.ok(sys.dirs.includes(`${HOME}/.config/process-rules/examplebot/gh`));
    const keygen = sys.calls.find((c) => c.command === 'ssh-keygen');
    assert.deepEqual(keygen?.args, ['-q', '-t', 'ed25519', '-C', 'ExampleBot signing', '-N', '', '-f', KEY]);
    assert.ok(!sys.calls.some((c) => c.command === 'git' && c.args[0] !== 'rev-parse'), 'touches no repository');
  });

  it('keeps plan lines within 60 columns', async () => {
    const { out } = await setUp(fresh(), '--dry-run');
    for (const line of out) assert.ok(line.length <= 60, `${line.length} columns: ${line}`);
  });

  it('changes nothing on a no', async () => {
    const sys = fresh();
    sys.answers = ['n'];
    const before = new Map(sys.files);
    const { code, out, err } = await setUp(sys);
    assert.deepEqual({ code, out, err }, { code: 1, out: [...FRESH_PLAN, '└  Nothing changed.'], err: [] });
    assert.deepEqual([sys.files, sys.keychain.size, sys.opened, sys.asked], [before, 0, [], []]);
    assert.ok(!sys.requests.some((r) => r.method === 'POST'));
    assert.ok(!sys.calls.some((c) => c.command === 'ssh-keygen'));
  });

  it('only shows the plan with --dry-run', async () => {
    const sys = fresh();
    sys.tty = false;
    const before = new Map(sys.files);
    const { code, out } = await setUp(sys, '--dry-run');
    assert.deepEqual({ code, out }, { code: 0, out: [...FRESH_PLAN, '└  Dry run: nothing changed.'] });
    assert.deepEqual([sys.chosen, sys.files, sys.keychain.size, sys.opened], [[], before, 0, []]);
  });

  it('goes ahead without asking with --yes, with no terminal too', async () => {
    const sys = fresh();
    sys.tty = false;
    sys.answers = [];
    const { code, out } = await setUp(sys, '--yes');
    assert.equal(code, 0);
    assert.deepEqual(sys.chosen, []);
    assert.equal(out[FRESH_PLAN.length], '◇  Go ahead? Yes (--yes)');
    assert.equal(sys.token(AGENT), TOKEN);
  });

  it('refuses with no terminal and no --yes when there is something to ask, changing nothing', async () => {
    const sys = fresh();
    sys.tty = false;
    const before = new Map(sys.files);
    assert.deepEqual(await setUp(sys), {
      code: 1,
      out: [],
      err: ['machine: no terminal to ask in; pass --yes to go ahead without asking, or --dry-run to see the plan'],
    });
    assert.deepEqual([sys.files, sys.keychain.size, sys.chosen], [before, 0, []]);
    assert.ok(!sys.requests.some((r) => r.method === 'POST'));
  });

  it('needs no terminal when nothing changes', async () => {
    const sys = done();
    sys.tty = false;
    const { code, out } = await setUp(sys);
    assert.deepEqual({ code, last: out.at(-1) }, { code: 0, last: '└  ExampleBot is ready on this Mac' });
  });

  it('says in one line that nothing changes, asking nothing', async () => {
    const sys = done();
    const { code, out } = await setUp(sys);
    assert.deepEqual({ code, out }, {
      code: 0,
      out: ['◆  niyam machine   ExampleBot', '│', '◇  This Mac is set up for ExampleBot', '│', '└  ExampleBot is ready on this Mac'],
    });
    assert.deepEqual([sys.chosen, sys.asked], [[], []]);
    assert.ok(!sys.calls.some((c) => c.command === 'ssh-keygen' && c.args[0] !== '-y'));
  });

  describe('a Mac set up before niyam (P-50)', () => {
    const OLD_READ = `/usr/bin/security find-generic-password -s process-rules -a ${AGENT} -w 2>/dev/null`;
    /** done(), with the token under the old keychain service alone and the session file an older release wrote. */
    const before = (): FakeSys => {
      const sys = done();
      const token = sys.keychain.get(`niyam/${AGENT}`) as string;
      sys.keychain.delete(`niyam/${AGENT}`);
      sys.keychain.set(`process-rules/${AGENT}`, token);
      sys.files.set(SESSION, sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT), KEYCHAIN, OLD_READ));
      return sys;
    };

    it('copies the token to the niyam service, keeping the old entry, and rewrites the session file', async () => {
      const sys = before();
      const token = sys.keychain.get(`process-rules/${AGENT}`);
      const { code, out } = await setUp(sys, '--yes');
      assert.equal(code, 0);
      assert.ok(out.some((line) => new RegExp(`token\\s+copied to service niyam, account ${AGENT}`).test(line)), out.join('\n'));
      assert.ok(out.some((line) => /session file\s+updated/.test(line)), out.join('\n'));
      assert.equal(sys.keychain.get(`niyam/${AGENT}`), token);
      assert.equal(sys.keychain.get(`process-rules/${AGENT}`), token, 'older CLIs still read the old entry');
      assert.equal(sys.files.get(SESSION), sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    });

    it('stops, saying the old entry still works, when the keychain does not take the copy', async () => {
      const sys = before();
      sys.execOverride = (call) => (call.args[0] === '-i' ? { code: 1, stdout: '', stderr: '' } : undefined);
      const { code, err } = await setUp(sys, '--yes');
      assert.deepEqual({ code, err }, { code: 1, err: [`machine: this Mac's keychain did not take the token under service niyam, account ${AGENT}; the old entry still works`] });
    });
  });

  it("plans locking the owner's credentials away, and leaves keys with their fix", async () => {
    const sys = done();
    sys.ghAccounts = ['example-owner'];
    sys.gitPassword = true;
    sys.files.set(`${HOME}/.ssh/id_ed25519`, 'open:key');
    sys.files.set(declinedPath(HOME, AGENT), JSON.stringify({ ghLogins: ['example-owner'], gitPassword: true }));
    sys.answers = ['y'];
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.deepEqual(sys.chosen, ['Go ahead?']);
    assert.deepEqual(out, [
      '◆  niyam machine   ExampleBot',
      '│',
      '◇  This Mac',
      '│    gh            sign out example-owner',
      '│    git password  remove from the keychain',
      '│',
      '◇  gh signed out of example-owner',
      '◇  git password removed',
      '│',
      '◇  Worth fixing',
      `▲  ~/.ssh/id_ed25519 has no passphrase → ssh-keygen -p -f ~/.ssh/id_ed25519`,
      ...ownerFixes(['example-owner']).map((fix) => `▲  ${fix.text} → ${fix.fix}`),
      '│',
      '└  ExampleBot is ready on this Mac',
    ]);
    assert.deepEqual(sys.ghAccounts, []);
    assert.equal(sys.gitPassword, false);
    assert.equal(sys.exists(declinedPath(HOME, AGENT)), false, 'what was declined before is said yes to now');
    assert.deepEqual(readMoved(sys, AGENT)?.logins, ['example-owner']);
  });

  it('goes on when the lockout fails, with it worth fixing', async () => {
    const sys = done();
    sys.ghAccounts = ['example-owner'];
    sys.gitPassword = true;
    sys.answers = ['y'];
    sys.execOverride = (call) => {
      if (call.command === 'gh' && call.args[1] === 'logout') return { code: 1, stdout: '', stderr: 'no such account\n' };
      if (call.command === 'git' && call.args[0] === 'credential-osxkeychain') return { code: 0, stdout: '', stderr: '' };
      return undefined;
    };
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.deepEqual(out.slice(-8), [
      '■  gh signed out of example-owner',
      '■  git password removed',
      '│',
      '◇  Worth fixing',
      '▲  gh is still signed in as example-owner: no such account → niyam machine',
      '▲  the saved git password for github.com is still in the keychain → niyam machine',
      '│',
      '└  ExampleBot is ready on this Mac',
    ]);
    assert.equal(sys.exists(movedPath(HOME, AGENT)), false, 'nothing moved');
  });

  it('shows what is worth fixing when nothing changes', async () => {
    const sys = done();
    sys.files.set(`${HOME}/.ssh/id_ed25519`, 'open:key');
    assert.deepEqual((await setUp(sys)).out.slice(2), [
      '◇  This Mac is set up for ExampleBot',
      '│',
      '◇  Worth fixing',
      '▲  ~/.ssh/id_ed25519 has no passphrase → ssh-keygen -p -f ~/.ssh/id_ed25519',
      '│',
      '└  ExampleBot is ready on this Mac',
    ]);
  });

  it('needs no repository when the agent is named', async () => {
    const sys = fresh();
    sys.inRepo = false;
    sys.files.clear();
    assert.equal((await setUp(sys, AGENT)).code, 0);
    assert.ok(!sys.calls.some((c) => c.command === 'git'));
  });

  it('registers an existing key GitHub does not list, asking with the stored token', async () => {
    const sys = done();
    sys.route('GET', '/user/ssh_signing_keys', { status: 200, json: [] });
    sys.route('POST', '/user/ssh_signing_keys', () => {
      sys.route('GET', '/user/ssh_signing_keys', { status: 200, json: [{ key: 'ssh-ed25519 AAAAkey' }] });
      return { status: 201, json: {} };
    });
    sys.answers = ['y'];
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.deepEqual(out.slice(2, 5), ['◇  GitHub — as ExampleBot', '│    signing key  register', '│']);
    assert.ok(out.includes('◇  signing key registered'));
    assert.ok(sys.requests.filter((r) => r.method === 'GET' && r.url.endsWith('/user/ssh_signing_keys')).every((r) => r.token === TOKEN));
  });

  it('plans registering an existing key when there is no token and GitHub cannot list keys', async () => {
    const sys = done();
    sys.keychain.clear();
    sys.route('GET', '/users/ExampleBot/ssh_signing_keys', { status: 500, json: {} });
    const { code, out } = await setUp(sys, '--dry-run');
    assert.equal(code, 0);
    assert.ok(out.includes('│    signing key  register'));
  });

  it('falls back to the browser when the API cannot add the key', async () => {
    const sys = fresh();
    let added = false;
    sys.route('POST', '/user/ssh_signing_keys', { status: 403, json: {} });
    sys.route('GET', '/user/ssh_signing_keys', () => ({
      status: 200,
      json: added ? [{ key: 'ssh-ed25519 AAAAkey' }] : [],
    }));
    const ask = sys.ask.bind(sys);
    sys.ask = (question) => {
      if (question.includes('press Enter')) added = true;
      return ask(question);
    };
    sys.answers = ['y', ''];
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.ok(out.includes('◇  signing key: add it in the browser, as ExampleBot'));
    assert.ok(out.includes("│  GitHub's API refused (HTTP 403); on the page this opened:"));
    assert.ok(out.includes('│  ssh-ed25519 AAAAkey ExampleBot signing'));
    assert.ok(out.includes('◇  signing key registered'));
    assert.deepEqual(sys.opened.at(-1), 'https://github.com/settings/ssh/new');
  });

  it('fails when the key is still not listed', async () => {
    const sys = fresh();
    sys.route('POST', '/user/ssh_signing_keys', { status: 403, json: {} });
    sys.answers = ['y', ''];
    const { code, out, err } = await setUp(sys);
    assert.equal(code, 1);
    assert.equal(out.at(-1), '■  signing key registered');
    assert.deepEqual(err, ["machine: GitHub still does not list the key as ExampleBot's signing key"]);
    assert.equal(sys.files.has(SESSION), false, 'nothing after it');
  });

  it('writes a missing public half from the private key', async () => {
    const sys = fresh();
    sys.files.set(KEY, PRIVATE_KEY);
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.equal(out[3], '│    signing key   ~/.ssh/examplebot_signing.pub (from the key)');
    assert.equal(sys.files.get(`${KEY}.pub`), 'ssh-ed25519 AAAAkey ExampleBot signing\n');
  });

  for (const [name, files, problem] of [
    ['unusable', { [KEY]: 'garbage' }, `${KEY} is not a usable private key`],
    ['mismatched', { [KEY]: PRIVATE_KEY, [`${KEY}.pub`]: 'ssh-ed25519 other' }, `${KEY}.pub does not match ${KEY}`],
  ] as const) {
    it(`refuses an ${name} key pair without touching it`, async () => {
      const sys = fresh();
      for (const [path, data] of Object.entries(files)) sys.files.set(path, data);
      const { code, err } = await setUp(sys);
      assert.deepEqual({ code, err }, { code: 1, err: [`machine: ${problem}; move it aside and run machine again to make a new key`] });
      assert.ok(!sys.calls.some((c) => c.command === 'ssh-keygen' && c.args[0] !== '-y'));
      assert.deepEqual(sys.chosen, []);
    });
  }

  it('accepts logins that differ only in case', async () => {
    const sys = fresh();
    sys.acceptToken(TOKEN, 'examplebot');
    assert.equal((await setUp(sys)).code, 0);
  });

  it('replaces a stored token that cannot stay, saying why', async () => {
    const sys = fresh();
    sys.setToken(AGENT, 'stale');
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.equal(out[1], '│  ! the stored token cannot stay: GitHub refuses the token (expired or revoked?)');
    assert.ok(out.includes('│    token         classic, in the keychain (replaced)'));
    assert.equal(sys.token(AGENT), TOKEN);
  });

  it('plans replacing a stored token near its end', async () => {
    const sys = done();
    const old = 'ghp_old';
    sys.setToken(AGENT, old);
    sys.acceptToken(old, AGENT, { ...CLASSIC, 'github-authentication-token-expiration': '2026-11-05 12:00:00 UTC' });
    sys.secrets = [TOKEN];
    sys.answers = ['y'];
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.deepEqual(out.slice(2, 4), ['◇  This Mac', '│    token  ends in 6 days; a new one replaces it']);
    assert.equal(sys.token(AGENT), TOKEN);
  });

  for (const typed of ['examplebot', 'EXAMPLEBOT', 'exampleBOT']) {
    it(`uses GitHub's spelling of the login typed as ${typed}`, async () => {
      const sys = fresh();
      assert.equal((await setUp(sys, typed)).code, 0);
      assert.deepEqual([...sys.keychain.keys()], [`niyam/${AGENT}`]);
      assert.equal(sys.files.get(SESSION), sessionScript(AGENT, AGENT_ID, pathsFor(HOME, AGENT)));
    });
  }

  for (const [name, secret, login, headers, message] of [
    ['an empty paste', '', undefined, CLASSIC, 'machine: GitHub refuses the token (expired or revoked?)'],
    ['a refused token', 'ghp_bad', undefined, CLASSIC, 'machine: GitHub refuses the token (expired or revoked?)'],
    ["the owner's token", 'ghp_owner', 'example-owner', CLASSIC, 'machine: the token acts as example-owner, not ExampleBot'],
    ['a fine-grained token', 'github_pat_x', AGENT, {}, 'machine: it is not a classic token, which niyam needs (see its docs/decisions.md)'],
    ['a token short of scopes', 'ghp_thin', AGENT, { 'x-oauth-scopes': 'repo' }, 'machine: the token lacks the scopes workflow, read:org, project, write:ssh_signing_key'],
    ['a token that never expires', 'ghp_forever', AGENT, { 'x-oauth-scopes': CLASSIC['x-oauth-scopes'] }, 'machine: the token never expires; create one with an expiry (90 days recommended)'],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const sys = fresh();
      sys.secrets = [secret];
      if (login) sys.acceptToken(secret, login, headers);
      const { code, out, err } = await setUp(sys);
      assert.deepEqual({ code, err, last: out.at(-1) }, { code: 1, err: [message], last: '■  token in the keychain' });
      assert.equal(sys.keychain.size, 0);
      assert.equal(sys.files.has(SESSION), false);
    });
  }

  it('says so when the keychain does not take the token', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.args[0] === '-i' ? { code: 1, stdout: '', stderr: '' } : undefined);
    const { code, err } = await setUp(sys);
    assert.deepEqual({ code, err }, { code: 1, err: ["machine: this Mac's keychain did not take the token"] });
  });

  it('reports a failed ssh-keygen', async () => {
    const sys = fresh();
    sys.execOverride = (call) => (call.command === 'ssh-keygen' ? { code: 1, stdout: '', stderr: 'no space\n' } : undefined);
    const { code, out, err } = await setUp(sys);
    assert.deepEqual({ code, err, last: out.at(-1) }, { code: 1, err: ['machine: ssh-keygen failed: no space'], last: '■  signing key' });
    assert.deepEqual(sys.opened, [], 'nothing after it');
  });

  it('writes the launcher, which runs the package manager\'s niyam command for an installed CLI with this node', async () => {
    const sys = fresh();
    sys.runtime = { node: NODE, cli: INSTALLED };
    sys.execOverride = (call) =>
      call.command === '/bin/sh' && call.args.join(' ') === '-c command -v niyam' ? { code: 0, stdout: '/home/u/Library/pnpm/bin/niyam\n', stderr: '' } : undefined;
    assert.equal((await setUp(sys)).code, 0);
    assert.equal(sys.files.get(LAUNCHER), launcherScript(NODE, INSTALLED, '/home/u/Library/pnpm/bin/niyam'));
    assert.equal(sys.modes.get(LAUNCHER), 0o755);
    assert.match(sys.files.get(LAUNCHER) ?? '', /^PATH='\/opt\/node\/bin':"\$PATH"$/m);
    assert.ok(sys.dirs.includes(`${HOME}/.config/process-rules/bin`));
  });

  it("runs the CLI's own script from a checkout, whatever is on PATH, or when nothing is", async () => {
    const sys = fresh();
    sys.execOverride = (call) =>
      call.command === '/bin/sh' ? { code: 0, stdout: '/home/u/Library/pnpm/bin/process-rules\n', stderr: '' } : undefined;
    assert.equal((await setUp(sys)).code, 0);
    assert.ok(!sys.calls.some((c) => c.command === '/bin/sh'), 'an installed CLI on PATH may be another version');
    const bare = fresh();
    bare.runtime = { node: NODE, cli: INSTALLED };
    assert.equal((await setUp(bare)).code, 0);
    assert.equal(bare.files.get(LAUNCHER), launcherScript(NODE, INSTALLED));
    assert.match(sys.files.get(LAUNCHER) ?? '', /^exec '\/opt\/node\/bin\/node' '\/opt\/process-rules\/dist\/cli\.js' "\$@"$/m);
  });

  it('replaces a launcher that names another node', async () => {
    const sys = done();
    sys.files.set(LAUNCHER, launcherScript('/gone/bin/node', CLI));
    sys.answers = ['y'];
    const { code, out } = await setUp(sys);
    assert.equal(code, 0);
    assert.deepEqual(out.slice(2, 4), ['◇  This Mac', '│    launcher  ~/.config/process-rules/bin/process-rules']);
    assert.equal(sys.files.get(LAUNCHER), launcherScript(NODE, CLI));
  });

  it('colours only on a terminal with colours, and never with NO_COLOR', async () => {
    const sys = done();
    sys.env = { ...sys.env, TERM: 'xterm-256color' };
    assert.ok((await setUp(sys)).out.some((line) => line.includes('\u001b[')));
    for (const env of [{ TERM: 'xterm-256color', NO_COLOR: '1' }, { TERM: 'dumb' }]) {
      const plain = done();
      plain.env = { ...plain.env, ...env };
      assert.ok(!(await setUp(plain)).out.some((line) => line.includes('\u001b[')), JSON.stringify(env));
    }
  });
});

describe('machineArgs', () => {
  it('reads the agent and the flags, in any order', () => {
    assert.deepEqual(machineArgs(['--yes', AGENT, '--dry-run']), { named: AGENT, yes: true, dryRun: true });
    assert.deepEqual(machineArgs([]), {});
  });

  it('refuses an unknown option and a second agent', () => {
    assert.throws(() => machineArgs(['--force']), /unknown option --force/);
    assert.throws(() => machineArgs(['a', 'b']), /unexpected argument "b"/);
  });
});

describe('tokenInstructions', () => {
  it('names the account and the expiry, in short lines', () => {
    const lines = tokenInstructions(AGENT);
    const text = lines.join('\n');
    assert.match(text, /sign in as ExampleBot, in a private window/);
    assert.match(text, /note and scopes are filled in; tick nothing else/);
    assert.match(text, /Expiration: 90 days \(doctor warns 14 days before\)/);
    assert.match(text, /Configure SSO → Authorize/);
    for (const line of lines) assert.ok(line.length <= 55, line);
  });

  it('opens a page with the scopes filled in', () => {
    assert.equal(
      TOKEN_PAGE,
      'https://github.com/settings/tokens/new?description=process-rules%20agent&scopes=repo,workflow,read:org,project,write:ssh_signing_key',
    );
  });
});
