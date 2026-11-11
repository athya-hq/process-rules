import { SETTINGS_PATH, sameLogin } from './agent.ts';
import { type Feature, featuresIn } from './features.ts';
import { GITHUB_HOST, GITHUB_WEB } from './host.ts';
import { ISSUE_TYPES } from './issue-types.ts';
import type { Finding } from './layout.ts';
import { CLI } from './names.ts';
import { WORKFLOW_PATH } from './onboard-pull.ts';
import { signInLines } from './owner-login.ts';
import { agentSession } from './push-identity.ts';
import type { Output, Sys } from './types.ts';

/** Where the owner revokes the GitHub CLI token a run leaves on GitHub: `gh auth logout` cannot. */
export const REVOKE = `${GITHUB_WEB}/settings/applications`;
/** The start of each owner-step folder's name, so doctor can find one left behind. */
export const FOLDER_PREFIX = 'niyam-owner-step-';
/** The labels the auto-mode classifier keeps agents from changing, so the owner changes them. */
export const OWNER_LABELS = ['approved', 'do-not-merge'] as const;
/** The start of each check FEATURE_CHECKS names: the client workflow's job, by the `name: niyam` onboard gives it. */
const CHECK_PREFIX = `${CLI} / `;
/** The checks of each feature, as the client's workflow names them (its read-only job, then the shared checks' job). */
export const FEATURE_CHECKS: Partial<Record<Feature, string>> = {
  'pr-identity': `${CHECK_PREFIX}PR identity`,
  'work-rules': `${CHECK_PREFIX}Work rules`,
  figma: `${CHECK_PREFIX}Design frames`,
};
/** GitHub Actions' app, which reports the workflow's checks. */
const ACTIONS_APP = 15368;
/** How long one gh call gets. */
const GH_MS = 60_000;
/** How long the event loop gets between gh calls, for a Ctrl-C's handler. */
const SETTLE_MS = 20;

/** One owner step, as its arguments name it. */
export type Step =
  | { step: 'issue-types'; org: string }
  | { step: 'label'; repo: string; number: number; action: 'add' | 'remove'; label: string }
  | { step: 'required-checks'; repo: string; ruleset: string };

export const STEP_USAGE = [
  'issue-types <org>',
  `label <owner/repo> <number> <add|remove> <${OWNER_LABELS.join('|')}>`,
  'required-checks <owner/repo> <ruleset id or name>',
];

const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/** The step and its arguments; throws on anything else, naming what is wrong. */
export function ownerStepArgs(args: readonly string[]): Step {
  const [step, ...rest] = args;
  const usage = `owner-step takes one of: ${STEP_USAGE.join('; ')}`;
  const count = (n: number): void => {
    if (rest.length !== n) throw new Error(`owner-step ${step} takes ${n === 1 ? 'one argument' : `${n} arguments`}: ${STEP_USAGE.find((line) => line.startsWith(`${step} `))}`);
  };
  const repo = (value: string): string => {
    if (!REPO.test(value)) throw new Error(`owner-step ${step} needs a repository as owner/name, not "${value}"`);
    return value;
  };
  switch (step) {
    case 'issue-types': {
      count(1);
      const org = rest[0] as string;
      if (!ACCOUNT.test(org)) throw new Error(`owner-step issue-types needs an organisation's login, not "${org}"`);
      return { step, org };
    }
    case 'label': {
      count(4);
      const [where, number, action, label] = rest as [string, string, string, string];
      if (!/^#?[1-9]\d*$/.test(number)) throw new Error(`owner-step label needs an issue or pull request number, not "${number}"`);
      if (action !== 'add' && action !== 'remove') throw new Error(`owner-step label needs add or remove, not "${action}"`);
      if (!(OWNER_LABELS as readonly string[]).includes(label)) {
        throw new Error(`owner-step label changes ${OWNER_LABELS.join(' and ')} alone, which agents cannot; an agent changes "${label}" itself`);
      }
      return { step, repo: repo(where), number: Number(number.replace('#', '')), action, label };
    }
    case 'required-checks': {
      count(2);
      const [where, ruleset] = rest as [string, string];
      if (!ruleset.trim()) throw new Error('owner-step required-checks needs a ruleset id or name');
      return { step, repo: repo(where), ruleset };
    }
    default:
      throw new Error(step === undefined ? usage : `owner-step has no step "${step}"; ${usage}`);
  }
}

/** The scopes beyond gh's own (repo, read:org, gist) a step needs: issue types are an organisation setting. */
export function stepScopes(step: Step): string[] {
  return step.step === 'issue-types' ? ['admin:org'] : ['repo'];
}

/**
 * The folder owner-step's folders go in: macOS's temporary folder for this
 * user, which is the same whatever TMPDIR a shell sets, so doctor finds one
 * from an agent session too; elsewhere TMPDIR, or /tmp.
 */
export function folderRoot(sys: Sys): string {
  const asked = sys.platform === 'darwin' ? sys.exec('getconf', ['DARWIN_USER_TEMP_DIR'], { timeoutMs: 5_000 }) : undefined;
  const root = asked?.code === 0 ? asked.stdout.trim() : (sys.env.TMPDIR ?? '/tmp');
  return (root || '/tmp').replace(/\/+$/, '');
}

/** gh's answer to one API call: its JSON, or why it failed. */
interface Answer {
  ok: boolean;
  json: unknown;
  /** Response headers, names lowercased, when asked for. */
  headers: Record<string, string>;
  problem: string;
}

/** gh, signed in to the throwaway folder alone. */
interface Gh {
  api(path: string, options?: { method?: string; body?: unknown; include?: boolean }): Answer;
}

/**
 * gh's environment for one run: the throwaway folder as its config, no token
 * from the environment, no pager, no host but GitHub, and git's global
 * config inside the folder, should gh write any.
 */
function throwawayEnv(sys: Sys, dir: string): Record<string, string | undefined> {
  return {
    ...sys.env,
    GH_CONFIG_DIR: dir,
    GH_PAGER: 'cat',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    GH_HOST: undefined,
    GIT_CONFIG_GLOBAL: `${dir}/gitconfig`,
  };
}

function ghIn(sys: Sys, env: Record<string, string | undefined>): Gh {
  return {
    api(path, { method, body, include } = {}) {
      const args = ['api', path, '-H', 'X-GitHub-Api-Version: 2022-11-28', ...(method ? ['--method', method] : []), ...(body === undefined ? [] : ['--input', '-']), ...(include ? ['--include'] : [])];
      const run = sys.exec('gh', args, { env, timeoutMs: GH_MS, ...(body === undefined ? {} : { input: JSON.stringify(body) }) });
      let text = run.stdout;
      const headers: Record<string, string> = {};
      if (include) {
        const split = /\r?\n\r?\n/.exec(text);
        const head = split ? text.slice(0, split.index) : text;
        text = split ? text.slice(split.index + split[0].length) : '';
        for (const line of head.split(/\r?\n/).slice(1)) {
          const colon = line.indexOf(':');
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
      }
      let json: unknown = null;
      try {
        json = text.trim() ? JSON.parse(text) : null;
      } catch {
        // Not JSON: the problem below says what gh said.
      }
      const said = run.stderr.trim().split('\n')[0] || (json as { message?: unknown } | null)?.message;
      return { ok: run.code === 0, json, headers, problem: typeof said === 'string' && said ? said : `gh exit ${run.code}` };
    },
  };
}

/** Whether the throwaway folder holds a sign-in's token: gh's config there names one. */
function holdsToken(sys: Sys, dir: string): boolean {
  const hosts = `${dir}/hosts.yml`;
  return sys.exists(hosts) && /oauth_token:\s*\S/.test(sys.read(hosts));
}

/** One change a step makes, said before the yes, done after it. */
interface Change {
  /** What it will do, as the plan says it. */
  plan: string;
  /**
   * Does it and checks the result: what is now so, or throws why not.
   * `checkpoint` stops it, before a write, when a Ctrl-C came during a read.
   */
  apply(checkpoint: () => Promise<void>): string | Promise<string>;
}

/** What a step found on GitHub: the changes to make, and lines shown before them, such as a before and after. */
interface Found {
  changes: Change[];
  notes: string[];
  /** Said when there is nothing to change. */
  already: string;
  /** What it will not change, and why: each a ✗. */
  skipped: Finding[];
}

/** Throws unless gh's answer is fine, naming what was asked. */
function must(answer: Answer, what: string): unknown {
  if (!answer.ok) throw new Error(`${what}: ${answer.problem}`);
  return answer.json;
}

/** Whether `login` is an owner of the organisation `org`: an active admin. */
function ownsOrg(gh: Gh, org: string): boolean {
  const membership = gh.api(`user/memberships/orgs/${org}`);
  const json = membership.json as { role?: unknown; state?: unknown } | null;
  return membership.ok && json?.role === 'admin' && json.state === 'active';
}

/** Why `login` may not change `repo` as its owner, or undefined when it may: the user who owns it, or an owner of its organisation. */
function notRepoOwner(gh: Gh, login: string, repo: string): string | undefined {
  const json = must(gh.api(`repos/${repo}`), `reading ${repo}`) as { owner?: { login?: unknown; type?: unknown } } | null;
  const owner = json?.owner;
  if (typeof owner?.login !== 'string') return `GitHub did not say who owns ${repo}`;
  if (owner.type === 'Organization') return ownsOrg(gh, owner.login) ? undefined : `${login} is not an owner of the organisation ${owner.login}, which owns ${repo}`;
  return sameLogin(login, owner.login) ? undefined : `${repo} is ${owner.login}'s, not ${login}'s`;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The work model's issue types `org` lacks, added, and those it has disabled, enabled. */
function issueTypes(gh: Gh, org: string): Found {
  const read = (): { id: number; name: string; description: string | null; color: string | null; is_enabled: boolean }[] =>
    must(gh.api(`orgs/${org}/issue-types`), `reading ${org}'s issue types`) as never;
  const types = read();
  const check = (name: string): string => {
    const now = read().find((type) => same(type.name, name));
    if (!now?.is_enabled) throw new Error(`GitHub does not show ${name} enabled in ${org} afterwards`);
    return `${org} has the issue type ${name}, enabled`;
  };
  const changes: Change[] = [];
  for (const model of ISSUE_TYPES) {
    const there = types.find((type) => same(type.name, model.name));
    if (!there) {
      changes.push({
        plan: `add the issue type ${model.name} (${model.color}) to ${org}: ${model.description}`,
        apply: () => {
          must(gh.api(`orgs/${org}/issue-types`, { method: 'POST', body: { ...model, is_enabled: true } }), `adding ${model.name}`);
          return check(model.name);
        },
      });
    } else if (!there.is_enabled) {
      changes.push({
        plan: `enable the issue type ${there.name} in ${org}, now disabled`,
        apply: () => {
          must(
            gh.api(`orgs/${org}/issue-types/${there.id}`, { method: 'PUT', body: { name: there.name, description: there.description, color: there.color, is_enabled: true } }),
            `enabling ${there.name}`,
          );
          return check(there.name);
        },
      });
    }
  }
  return { changes, notes: [], skipped: [], already: `${org} has every work model issue type, enabled: ${ISSUE_TYPES.map((type) => type.name).join(', ')}` };
}

/** The label added to or taken off one issue or pull request. */
function label(gh: Gh, { repo, number, action, label: name }: Extract<Step, { step: 'label' }>): Found {
  const where = `${repo}#${number}`;
  const exists = gh.api(`repos/${repo}/labels/${encodeURIComponent(name)}`);
  if (!exists.ok && /404|not found/i.test(exists.problem)) throw new Error(`${repo} has no label ${name}, and owner-step makes none; ${CLI} onboard does`);
  must(exists, `reading ${repo}'s label ${name}`);
  const issue = (): { title: string; labels: string[] } => {
    const json = must(gh.api(`repos/${repo}/issues/${number}`), `reading ${where}`) as { title?: unknown; labels?: { name?: unknown }[] } | null;
    const labels = (json?.labels ?? []).map((one) => one.name).filter((one): one is string => typeof one === 'string');
    return { title: typeof json?.title === 'string' ? json.title : '', labels };
  };
  const labelsOn = (): string[] => issue().labels;
  const first = issue();
  const title = first.title ? ` "${first.title}"` : '';
  const has = first.labels.some((one) => same(one, name));
  if (has === (action === 'add')) return { changes: [], notes: [], skipped: [], already: `${where} ${has ? 'has' : 'does not have'} the label ${name}` };
  return {
    changes: [
      {
        plan: action === 'add' ? `add the label ${name} to ${where}${title}` : `take the label ${name} off ${where}${title}`,
        apply: () => {
          must(
            action === 'add'
              ? gh.api(`repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels: [name] } })
              : gh.api(`repos/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' }),
            `${action === 'add' ? 'adding' : 'removing'} ${name}`,
          );
          const now = labelsOn().some((one) => same(one, name));
          if (now !== (action === 'add')) throw new Error(`GitHub shows ${where} ${now ? 'with' : 'without'} ${name} afterwards`);
          return action === 'add' ? `${where} has the label ${name}` : `${where} no longer has the label ${name}`;
        },
      },
    ],
    notes: [],
    skipped: [],
    already: '',
  };
}

interface Rule {
  type: string;
  parameters?: { required_status_checks?: { context: string; integration_id?: number }[]; [key: string]: unknown };
}

/** A file of `repo` on its default branch, or undefined when GitHub has none; throws when GitHub will not say. */
function fileIn(gh: Gh, repo: string, path: string): string | undefined {
  const answer = gh.api(`repos/${repo}/contents/${path}`);
  if (!answer.ok && /404|not found/i.test(answer.problem)) return undefined;
  const content = (must(answer, `reading ${repo}'s ${path}`) as { content?: unknown } | null)?.content;
  if (typeof content !== 'string') throw new Error(`GitHub did not give ${repo}'s ${path}`);
  return Buffer.from(content, 'base64').toString('utf8');
}

/** The checks the repository's settings, the file loadSettings reads on its default branch, turn on. */
function wantedChecks(gh: Gh, repo: string): { file: string; checks: string[] } {
  const file = SETTINGS_PATH;
  const text = fileIn(gh, repo, file);
  if (text === undefined) throw new Error(`${repo} has no ${SETTINGS_PATH} on its default branch, so its checks are not known; run ${CLI} onboard there first`);
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new Error(`${repo}'s ${file} is not JSON`);
  }
  return { file, checks: featuresIn(settings).flatMap((feature) => FEATURE_CHECKS[feature] ?? []) };
}

/** The repository's workflow on its default branch, and its path. */
function workflowIn(gh: Gh, repo: string): { path: string; text?: string } {
  const text = fileIn(gh, repo, WORKFLOW_PATH);
  // Line endings as LF, which the job patterns read, whatever the client's checkout committed.
  return text === undefined ? { path: WORKFLOW_PATH } : { path: WORKFLOW_PATH, text: text.replaceAll('\r\n', '\n') };
}

/** The workflow's read-only job, by its id, `niyam`. */
const READ_ONLY_JOB = String.raw`^ {2}${CLI}:[ 	]*
?
`;

/** The shared checks workflow a client's read-only job calls: `owner/repo/.github/workflows/checks.yml@ref`, or `./` for the repository's own. */
const CALLS_CHECKS = /^\s+uses:\s*['"]?(?:([\w.-]+\/[\w.-]+)\/|\.\/)\.github\/workflows\/checks\.yml(?:@([^\s'"#]+))?/m;

/**
 * The names of the jobs the repository's workflow runs as `niyam`,
 * on its default branch: those of the shared checks workflow its
 * read-only job calls, at the version it pins; or why none can be
 * known. A check whose job is not there would never report, and a ruleset
 * requiring it would hold every pull request.
 */
function workflowJobs(gh: Gh, repo: string): Set<string> | { problem: string } {
  const { path, text: workflow } = workflowIn(gh, repo);
  if (workflow === undefined) return { problem: `${repo} has no ${WORKFLOW_PATH} on its default branch` };
  const job = new RegExp(String.raw`${READ_ONLY_JOB}((?:(?: {3,}|[ 	]*#|[ 	]*
?$).*
?
?)*)`, 'm').exec(workflow)?.[1];
  const calls = job === undefined ? null : CALLS_CHECKS.exec(job);
  if (!calls) return { problem: `${path} has no ${CLI} job calling the shared checks` };
  const [, from = repo, ref] = calls;
  const answer = gh.api(`repos/${from}/contents/.github/workflows/checks.yml${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
  const content = (answer.json as { content?: unknown } | null)?.content;
  if (!answer.ok || typeof content !== 'string') return { problem: `GitHub did not give the shared checks ${from}${ref ? `@${ref}` : ''} that ${path} calls (${answer.problem})` };
  const text = Buffer.from(content, 'base64').toString('utf8');
  return new Set([...text.matchAll(/^ {4}name:\s*['"]?([^'"#\r\n]*?)['"]?\s*$/gm)].map((match) => match[1] as string));
}

/**
 * The ruleset's required checks, with the checks of the features the
 * repository's settings turn on added; every other check and rule stays as
 * it is, and none is taken away.
 */
function requiredChecks(gh: Gh, { repo, ruleset }: Extract<Step, { step: 'required-checks' }>): Found {
  const listed = must(gh.api(`repos/${repo}/rulesets?includes_parents=false&per_page=100`), `listing ${repo}'s rulesets`) as { id?: unknown; name?: unknown }[] | null;
  const matches = (listed ?? []).filter((one) => String(one.id) === ruleset || (typeof one.name === 'string' && same(one.name, ruleset)));
  if (matches.length !== 1) {
    const names = (listed ?? []).map((one) => `${String(one.name)} (${String(one.id)})`).join(', ') || 'none';
    throw new Error(`${matches.length === 0 ? 'no' : 'more than one'} ruleset of ${repo} is "${ruleset}"; its rulesets: ${names}`);
  }
  const id = String(matches[0]?.id);
  const read = (): { name: string; rules: Rule[] } => {
    const json = must(gh.api(`repos/${repo}/rulesets/${id}`), `reading the ruleset ${ruleset}`) as { name?: unknown; rules?: unknown } | null;
    if (!Array.isArray(json?.rules)) throw new Error(`GitHub did not give the ruleset ${ruleset}'s rules`);
    return { name: String(json.name), rules: json.rules as Rule[] };
  };
  const contexts = (rules: Rule[]): string[] => rules.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks?.map((check) => check.context) ?? [];
  const others = (rules: Rule[]): string => JSON.stringify(rules.filter((rule) => rule.type !== 'required_status_checks'));
  const before = read();
  const { file, checks: turnedOn } = wantedChecks(gh, repo);
  const required = contexts(before.rules);
  const had = [...new Set(required)];
  const jobs = turnedOn.some((check) => !had.includes(check)) ? workflowJobs(gh, repo) : new Set<string>();
  const runs = (check: string): boolean => had.includes(check) || (jobs instanceof Set && jobs.has(check.slice(CHECK_PREFIX.length)));
  const checks = turnedOn.filter(runs);
  const why = (check: string): string => ('problem' in jobs ? jobs.problem : `the shared checks ${WORKFLOW_PATH} calls run no ${check.slice(CHECK_PREFIX.length)} job`);
  const skipped = turnedOn
    .filter((check) => !runs(check))
    .map((check): Finding => ({
      mark: '✗',
      text: `not adding ${check}: ${why(check)}, so it would never report and would hold every pull request`,
      fix: `${CLI} onboard there, then run this again`,
    }));
  const missing = checks.filter((check) => !had.includes(check));
  const after = [...had, ...missing];
  const list = (names: string[]): string => (names.length === 0 ? 'none' : names.join(', '));
  const notes = [`${file} turns on the checks ${list(turnedOn)}`, `before: ${list(required)}`, `after:  ${list(after)}`];
  if (missing.length === 0) return { changes: [], notes, skipped, already: `the ruleset ${before.name} requires every check ${file} turns on` };
  // Built on the ruleset as it is just before the write, so an edit made while the owner read the plan is kept.
  const withChecks = (current: Rule[]): Rule[] => {
    const kept = (current.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks ?? []).map((check) => check.context);
    const added = checks.filter((check) => !kept.includes(check)).map((context) => ({ context, integration_id: ACTIONS_APP }));
    return current.some((rule) => rule.type === 'required_status_checks')
      ? current.map((rule) =>
          rule.type === 'required_status_checks'
            ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [...(rule.parameters?.required_status_checks ?? []), ...added] } }
            : rule,
        )
      : [...current, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: added } }];
  };
  return {
    changes: [
      {
        plan: `make the ruleset ${before.name} of ${repo} also require ${missing.join(', ')}`,
        apply: async (checkpoint) => {
          const current = read();
          await checkpoint();
          must(gh.api(`repos/${repo}/rulesets/${id}`, { method: 'PUT', body: { rules: withChecks(current.rules) } }), `updating the ruleset ${before.name}`);
          const now = read();
          const lacking = checks.filter((check) => !contexts(now.rules).includes(check));
          if (lacking.length > 0) throw new Error(`GitHub shows the ruleset without ${lacking.join(', ')} afterwards`);
          if (others(now.rules) !== others(current.rules)) throw new Error(`GitHub shows the ruleset's other rules changed afterwards; check it at ${GITHUB_WEB}/${repo}/rules/${id}`);
          return `the ruleset ${now.name} requires ${list(contexts(now.rules))}`;
        },
      },
    ],
    notes,
    skipped,
    already: '',
  };
}

/** What a step is about, for its first line. */
function about(step: Step): string {
  if (step.step === 'issue-types') return `the work model's issue types in ${step.org}`;
  if (step.step === 'label') return `${step.action} the label ${step.label} ${step.action === 'add' ? 'to' : 'off'} ${step.repo}#${step.number}`;
  return `the required checks of ${step.repo}'s ruleset ${step.ruleset}`;
}

/**
 * Does one GitHub step only the owner's account can do, in the owner's own
 * terminal: never in an agent session, never without a terminal to ask in.
 * It signs the owner in to a throwaway gh, one browser approval of gh's
 * device code with only that step's scopes, its token kept in a new folder
 * of its own (`GH_CONFIG_DIR`, `--insecure-storage`), never the keychain,
 * the owner's gh config, git's or SSH's; the pager is off. It checks the
 * login owns the repository or organisation, reads what is there, prints
 * exactly what it will change and asks for a yes; then it makes each
 * change, checks it and marks it ✓ or ✗. Whatever happens, a Ctrl-C
 * included, it deletes the folder, the token's only copy; it never runs
 * `gh auth logout`, which deletes gh's keychain entries for the host
 * whatever GH_CONFIG_DIR says. It ends with the link to revoke the token,
 * which stays valid on GitHub until revoked. Exit 0 when every change is made, or
 * none is needed or wanted; 1 otherwise; 130 after a Ctrl-C.
 */
export async function ownerStep(sys: Sys, io: Output, args: readonly string[]): Promise<number> {
  const step = ownerStepArgs(args);
  if (agentSession(sys)) {
    io.err('owner-step: run it in your own terminal, not in an agent session; it signs in as you');
    return 1;
  }
  if (!sys.tty) {
    io.err('owner-step: no terminal to ask in; run it in your own terminal');
    return 1;
  }
  const scopes = stepScopes(step);
  io.out(`owner-step ${step.step}: ${about(step)}`);
  io.out(`  One browser sign-in to a throwaway gh (scopes ${scopes.join(', ')}, beside gh's own), its folder deleted afterwards.`);
  io.out('  Nothing changes until you say yes.');

  const dir = sys.tempDir(`${folderRoot(sys)}/${FOLDER_PREFIX}`);
  const env = throwawayEnv(sys, dir);
  let cleaned: Finding | undefined;
  let interrupted = false;
  // Synchronous, and once: a Ctrl-C's handler and the finally below both call it.
  // Not `gh auth logout`: it deletes gh's keychain entries for the host, whatever GH_CONFIG_DIR says (gh 2.103.3).
  const cleanUp = (): Finding => {
    if (cleaned) return cleaned;
    const token = holdsToken(sys, dir);
    let left = true;
    try {
      sys.remove(dir);
      left = sys.exists(dir);
    } catch {
      // Said below: the folder is still there.
    }
    cleaned = left
      ? { mark: '✗', text: `could not delete the throwaway gh folder ${dir}${token ? ', which holds the token' : ''}`, fix: `rm -rf ${dir}` }
      : { mark: '✓', text: token ? 'deleted the throwaway gh folder and the token in it' : 'deleted the throwaway gh folder' };
    return cleaned;
  };
  const off = sys.onInterrupt(() => {
    interrupted = true;
    cleanUp();
  });
  const results: Finding[] = [];
  let code = 1;
  try {
    code = await signedIn(sys, io, step, scopes, dir, env, results, () => interrupted);
  } catch (error) {
    // A Ctrl-C that killed a gh call is handled once the event loop runs again.
    await settle(sys);
    code = error instanceof Interrupted || interrupted ? 130 : 1;
    results.push({ mark: '✗', text: code === 130 ? 'stopped by Ctrl-C; nothing changed' : message(error) });
  } finally {
    await settle(sys);
    off();
    for (const result of [...results, cleanUp()]) io.out(`${result.mark} ${result.text}${result.fix ? ` → ${result.fix}` : ''}`);
    io.out(`The GitHub CLI token stays valid on GitHub until you revoke it: ${REVOKE}`);
  }
  // A folder left behind fails the run, whatever else did.
  return cleanUp().mark === '✗' && code === 0 ? 1 : code;
}

/** The step from the sign-in on, each result in `results`; throws when it stops before any change. */
async function signedIn(
  sys: Sys,
  io: Output,
  step: Step,
  scopes: string[],
  dir: string,
  env: Record<string, string | undefined>,
  results: Finding[],
  interrupted: () => boolean,
): Promise<number> {
  const signIn = await sys.converse(
    'gh',
    ['auth', 'login', '-h', GITHUB_HOST, '-p', 'https', '--skip-ssh-key', '-w', '-s', scopes.join(','), '--insecure-storage'],
    { env },
    signInLines(sys, (line) => io.out(`  ${line}`)),
  );
  if (interrupted()) throw new Interrupted();
  // Only a token in the throwaway folder counts: gh would otherwise read one from the keychain.
  if (signIn !== 0 || !holdsToken(sys, dir)) throw new Error('the GitHub sign-in in the browser did not finish, so nothing changed');
  const gh = ghIn(sys, env);
  const me = gh.api('user', { include: true });
  const login = (me.json as { login?: unknown } | null)?.login;
  if (!me.ok || typeof login !== 'string') throw new Error(`GitHub did not accept the sign-in (${me.problem}), so nothing changed`);
  const granted = (me.headers['x-oauth-scopes'] ?? '').split(',').map((scope) => scope.trim());
  const lacking = scopes.filter((scope) => !granted.includes(scope));
  if (lacking.length > 0) throw new Error(`the sign-in did not grant ${lacking.join(', ')}, so nothing changed`);
  io.out(`  signed in as ${login}`);
  const notOwner = step.step === 'issue-types' ? (ownsOrg(gh, step.org) ? undefined : `${login} is not an owner of the organisation ${step.org}`) : notRepoOwner(gh, login, step.repo);
  if (notOwner) throw new Error(`${notOwner}; sign in to ${GITHUB_HOST} in the browser as the owner and run it again. Nothing changed`);

  const found = step.step === 'issue-types' ? issueTypes(gh, step.org) : step.step === 'label' ? label(gh, step) : requiredChecks(gh, step);
  for (const note of found.notes) io.out(`  ${note}`);
  results.push(...found.skipped);
  const skipped = found.skipped.length > 0 ? 1 : 0;
  if (found.changes.length === 0) {
    if (!skipped) results.push({ mark: '✓', text: `nothing to change: ${found.already}` });
    return skipped;
  }
  io.out(`  owner-step will ${found.changes.length === 1 ? 'make this change' : `make these ${found.changes.length} changes`}:`);
  for (const change of found.changes) io.out(`    ${change.plan}`);
  const yes = await sys.choose(found.changes.length === 1 ? 'Make this change?' : 'Make these changes?');
  if (interrupted()) throw new Interrupted();
  if (!yes) {
    results.push({ mark: '✓', text: 'nothing changed: you said no' });
    return skipped;
  }
  let code = skipped;
  const checkpoint = async (): Promise<void> => {
    await settle(sys);
    if (interrupted()) throw new Interrupted();
  };
  for (const change of found.changes) {
    // Each gh call runs to its end before a Ctrl-C's handler can: the event loop runs it here.
    await settle(sys);
    if (interrupted()) {
      results.push({ mark: '✗', text: `${change.plan}: not done, stopped by Ctrl-C` });
      code = 130;
      continue;
    }
    try {
      results.push({ mark: '✓', text: await change.apply(checkpoint) });
    } catch (error) {
      if (error instanceof Interrupted) {
        results.push({ mark: '✗', text: `${change.plan}: not done, stopped by Ctrl-C` });
        continue;
      }
      await settle(sys);
      results.push({ mark: '✗', text: `${change.plan}: ${interrupted() ? 'stopped by Ctrl-C; check it on GitHub' : message(error)}` });
      code = 1;
    }
  }
  await settle(sys);
  return interrupted() ? 130 : code;
}

/** Lets the event loop run, so a Ctrl-C that came during a gh call reaches its handler. */
function settle(sys: Sys): Promise<void> {
  return sys.sleep(SETTLE_MS);
}

class Interrupted extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * doctor's findings on owner-step folders left behind, which a run killed
 * outright or a delete that failed leaves; a run going on now has one too,
 * so each finding says to delete it only when none is running: ▲ for each, with the fix, and whether gh's token
 * is still in it. It reads nothing more of them than that.
 */
export function leftBehind(sys: Sys): Finding[] {
  const root = folderRoot(sys);
  return sys
    .list(root)
    .filter((name) => name.startsWith(FOLDER_PREFIX))
    .map((name): Finding => {
      const dir = `${root}/${name}`;
      const token = holdsToken(sys, dir);
      return token
        ? { mark: '▲', text: `an owner-step folder left behind holds a GitHub token: ${dir}`, fix: `with no owner-step running, rm -rf ${dir}, then revoke the GitHub CLI token at ${REVOKE}` }
        : { mark: '▲', text: `an owner-step folder left behind: ${dir}`, fix: `with no owner-step running, rm -rf ${dir}` };
    });
}
