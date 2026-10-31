import { launcherPath, launcherScript } from './agent.ts';
import type { ExecResult, HttpResult, Sys } from './types.ts';

export const HOME = '/home/u';
export const ROOT = '/repo';
export const AGENT = 'ExampleBot';
export const AGENT_ID = 42;
export const KEY = `${HOME}/.ssh/examplebot_signing`;
export const PUBLIC_KEY = 'ssh-ed25519 AAAAkey ExampleBot signing';
/** The fake's private key file: `ssh-keygen -y` derives the public half from it. */
export const PRIVATE_KEY = 'private:ssh-ed25519 AAAAkey';
export const TOKEN = 'ghp_good';
/** What GitHub answers about a classic token with every needed scope. */
export const CLASSIC = {
  'x-oauth-scopes': 'repo, workflow, read:org, project, write:ssh_signing_key',
  'github-authentication-token-expiration': '2027-01-28 12:00:00 UTC',
};
/** The fake's clock: 2026-10-30, 90 days before CLASSIC's token ends. */
export const NOW = new Date('2026-10-30T12:00:00Z');
/** The node and CLI script the fake runs with. */
export const NODE = '/opt/node/bin/node';
export const CLI = '/opt/process-rules/dist/cli.js';
export const SETTINGS = JSON.stringify({ owner: 'example-owner', agent: AGENT });

export interface Call {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
  interactive?: boolean;
}

/** A Sys whose world is plain data; each test changes what it needs. */
export class FakeSys implements Sys {
  env: Record<string, string | undefined> = {};
  home = HOME;
  cwd = ROOT;
  runtime = { node: NODE, cli: CLI };
  files = new Map<string, string>([[`${ROOT}/.github/process-rules.json`, SETTINGS]]);
  /** Keychain items by "service/account". */
  keychain = new Map<string, string>();
  modes = new Map<string, number>();
  inRepo = true;
  origin = 'https://github.com/example-org/example-app.git';
  /** What `git ls-remote <url> HEAD` prints: an empty repository prints nothing. */
  remoteHead = 'f00d\tHEAD\n';
  /** The accounts `gh auth status` lists on github.com. */
  ghAccounts: string[] = [];
  /** Whether the macOS keychain holds a git password for github.com. */
  gitPassword = false;
  /** The token the owner's browser approval gives `gh auth login`; undefined when the owner turns it down. */
  ghToken: string | undefined;
  /** The temporary folders made, and those removed. */
  temps: string[] = [];
  removed: string[] = [];
  /** Overrides for exec, by "command firstArg"; return undefined to fall through. */
  execOverride: (call: Call) => ExecResult | undefined = () => undefined;
  routes = new Map<string, HttpResult | (() => HttpResult)>();
  answers: string[] = [];
  secrets: string[] = [];
  calls: Call[] = [];
  requests: { url: string; method: string; token?: string; body?: unknown; headers?: Record<string, string> }[] = [];
  opened: string[] = [];
  asked: string[] = [];

  constructor() {
    this.route('GET', '/users/ExampleBot', { status: 200, json: { id: AGENT_ID, login: AGENT } });
    this.route('GET', '/user', { status: 401, json: null });
    this.route('GET', '/users/ExampleBot/ssh_signing_keys', { status: 200, json: [] });
    this.route('GET', '/user/ssh_signing_keys', { status: 200, json: [] });
  }

  route(method: string, path: string, result: HttpResult | (() => HttpResult)): this {
    this.routes.set(`${method} ${path.startsWith('https://') ? path : `https://api.github.com${path}`}`, result);
    return this;
  }

  /** The machine as `machine` leaves it: key, token, registered key. */
  ready(): this {
    this.files.set(KEY, PRIVATE_KEY);
    this.files.set(`${KEY}.pub`, `${PUBLIC_KEY}\n`);
    this.setToken(AGENT, TOKEN);
    this.acceptToken(TOKEN, AGENT);
    this.files.set(launcherPath(HOME), launcherScript(NODE, CLI));
    for (const path of ['/users/ExampleBot/ssh_signing_keys', '/user/ssh_signing_keys']) {
      this.route('GET', path, { status: 200, json: [{ key: 'ssh-ed25519 AAAAkey' }] });
    }
    return this;
  }

  /** The agent token as `machine` stores it: service process-rules. */
  setToken(account: string, token: string): this {
    this.keychain.set(`process-rules/${account}`, token);
    return this;
  }

  token(account: string): string | undefined {
    return this.keychain.get(`process-rules/${account}`);
  }

  acceptToken(token: string, login: string, headers: Record<string, string> = CLASSIC): this {
    const previous = this.routes.get('GET https://api.github.com/user');
    this.routes.set('GET https://api.github.com/user', () => {
      const last = this.requests.at(-1);
      if (last?.token === token) return { status: 200, json: { login }, headers };
      return typeof previous === 'function' ? previous() : previous ?? { status: 401, json: null };
    });
    return this;
  }

  exec(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeoutMs?: number; interactive?: boolean } = {},
  ): ExecResult {
    const call: Call = { command, args, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}), ...(options.input ? { input: options.input } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.interactive ? { interactive: true } : {}) };
    this.calls.push(call);
    const override = this.execOverride(call);
    if (override) return override;
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    const fail = (stderr = 'failed'): ExecResult => ({ code: 1, stdout: '', stderr });
    if (command === launcherPath(HOME)) return this.files.has(command) ? ok('0.0.0\n') : fail('not found');
    if (command === 'git' && args[1] === '--git-path') return this.inRepo ? ok(`.git/${args[2]}\n`) : fail('not a git repository');
    if (command === 'git' && args.includes('--git-common-dir')) return this.inRepo ? ok(`${ROOT}/.git\n`) : fail('not a git repository');
    if (command === 'git' && args[0] === 'rev-parse') return this.inRepo ? ok(`${ROOT}\n`) : fail();
    if (command === 'gh' && args.slice(0, 2).join(' ') === 'auth logout') {
      const login = args[args.indexOf('-u') + 1];
      this.ghAccounts = this.ghAccounts.filter((account) => account !== login);
      return ok();
    }
    if (command === 'gh' && args.slice(0, 2).join(' ') === 'auth status') {
      // gh writes the accounts to stderr when one of them fails, as old versions always did.
      const lines = this.ghAccounts.map((account, i) =>
        i === 1 ? `  X Failed to log in to github.com account ${account} (keyring)` : `  ✓ Logged in to github.com account ${account} (keyring)`,
      );
      return { code: 0, stdout: lines.slice(0, 1).join('\n'), stderr: lines.slice(1).join('\n') };
    }
    // gh keeps its login in GH_CONFIG_DIR; the owner's own folder, ~/.config/gh, holds none.
    const ghHosts = `${options.env?.GH_CONFIG_DIR ?? `${HOME}/.config/gh`}/hosts.yml`;
    if (command === 'gh' && args.slice(0, 2).join(' ') === 'auth login') {
      if (!this.ghToken) return fail('authentication cancelled');
      this.files.set(ghHosts, `github.com:\n    oauth_token: ${this.ghToken}\n`);
      return ok();
    }
    if (command === 'gh' && args.slice(0, 2).join(' ') === 'auth token') {
      const token = /oauth_token: (\S+)/.exec(this.files.get(ghHosts) ?? '')?.[1];
      return token ? ok(`${token}\n`) : fail('no oauth token found for github.com');
    }
    if (command === '/usr/bin/security' && args[0] === 'find-internet-password') return this.gitPassword ? ok() : fail('not found');
    if (command === 'git' && args[0] === 'credential-osxkeychain') {
      if (options.input?.includes('host=github.com')) this.gitPassword = false;
      return ok();
    }
    // An SSH key with no passphrase: its file starts "open:".
    if (command === 'ssh-keygen' && args[1] === '-P') return this.files.get(args[4] ?? '')?.startsWith('open:') ? ok() : fail('incorrect passphrase');
    if (command === 'git' && args[0] === 'remote') return ok(`${this.origin}\n`);
    // As the agent session's credential helper does: the token in GH_TOKEN, else nothing.
    if (command === 'git' && args.join(' ') === 'credential fill') {
      const token = options.env?.GH_TOKEN;
      return token ? ok(`protocol=https\nhost=github.com\nusername=x\npassword=${token}\n`) : fail('terminal prompts disabled');
    }
    if (command === 'git' && args[0] === 'commit-tree') return ok('abc123\n');
    if (command === 'git' && args[0] === 'ls-remote') return ok(this.remoteHead);
    // The test commit's other git steps; anything else fails, so an unexpected call shows.
    if (command === 'git' && args.join(' ') === 'init -q') return ok();
    if (command === 'git' && args.slice(0, 2).join(' ') === 'fetch -q') return ok();
    if (command === 'git' && args.slice(0, 2).join(' ') === 'push -q') return ok();
    if (command === 'mktemp') return ok('/tmp/verify\n');
    if (command === 'rm') return ok();
    if (command === 'ssh-keygen' && args[0] === '-y') {
      const body = /^private:(.*)$/.exec(this.files.get(args[2] ?? '') ?? '')?.[1];
      return body ? ok(`${body}\n`) : fail('invalid format');
    }
    if (command === 'ssh-keygen') {
      const path = args[args.indexOf('-f') + 1] ?? '';
      this.files.set(path, PRIVATE_KEY);
      this.files.set(`${path}.pub`, `${PUBLIC_KEY}\n`);
      return ok();
    }
    if (command === '/usr/bin/security' && args[0] === 'find-generic-password') {
      const token = this.keychain.get(`${args[args.indexOf('-s') + 1] ?? ''}/${args[args.indexOf('-a') + 1] ?? ''}`);
      return token ? ok(`${token}\n`) : fail('not found');
    }
    if (command === '/usr/bin/security' && args[0] === '-i') {
      const match = /-s (\S+) -a (\S+) -w (\S+)/.exec(options.input ?? '');
      if (match?.[1] && match[2] && match[3]) this.keychain.set(`${match[1]}/${match[2]}`, match[3]);
      return ok();
    }
    return fail(`unexpected ${command}`);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  read(path: string): string {
    const data = this.files.get(path);
    if (data === undefined) throw new Error(`ENOENT ${path}`);
    return data;
  }

  write(path: string, data: string, mode?: number): void {
    this.files.set(path, data);
    if (mode !== undefined) this.modes.set(path, mode);
  }

  append(path: string, data: string): void {
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }

  dirs: string[] = [];
  list(path: string): string[] {
    const prefix = `${path}/`;
    // Files directly in the folder, and folders named by the files below it.
    const names = [...this.files.keys(), ...this.dirs]
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length).split('/')[0] as string);
    return [...new Set(names)];
  }

  mkdir(path: string): void {
    this.dirs.push(path);
  }

  tempDir(): string {
    const dir = `/tmp/process-rules-${this.temps.length + 1}`;
    this.temps.push(dir);
    this.dirs.push(dir);
    return dir;
  }

  remove(path: string): void {
    this.removed.push(path);
    for (const name of this.files.keys()) {
      if (name === path || name.startsWith(`${path}/`)) {
        this.files.delete(name);
        this.modes.delete(name);
      }
    }
    this.dirs = this.dirs.filter((dir) => dir !== path && !dir.startsWith(`${path}/`));
  }

  http(url: string, options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpResult> {
    const method = options.method ?? 'GET';
    this.requests.push({
      url,
      method,
      ...(options.token ? { token: options.token } : {}),
      ...(options.body ? { body: options.body } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    // GitHub finds a login in /users/ paths in any case, and answers with its own spelling.
    const wanted = `${method} ${url}`;
    const route =
      this.routes.get(wanted) ??
      (url.includes('/users/')
        ? [...this.routes].find(([key]) => key.toLowerCase() === wanted.toLowerCase())?.[1]
        : undefined);
    const result = typeof route === 'function' ? route() : route ?? { status: 404, json: { message: 'Not Found' } };
    return Promise.resolve(result);
  }

  stdin = '';
  readStdin(): string {
    return this.stdin;
  }

  ask(question: string): Promise<string> {
    this.asked.push(question);
    return Promise.resolve(this.answers.shift() ?? '');
  }

  askSecret(question: string): Promise<string> {
    this.asked.push(question);
    return Promise.resolve(this.secrets.shift() ?? '');
  }

  open(url: string): void {
    this.opened.push(url);
  }

  now(): Date {
    return NOW;
  }

  slept: number[] = [];
  sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    return Promise.resolve();
  }
}

export function capture(): { out: string[]; err: string[]; io: { out(line: string): void; err(line: string): void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}
