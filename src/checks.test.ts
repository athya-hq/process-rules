import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

const CHECKS = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
const jobs = (parse(CHECKS) as { jobs: Record<string, { steps: Step[] }> }).jobs;
const CALLER = 'example-org/example-app/.github/workflows/niyam.yml@refs/heads/main';
/** The release each job runs, as checks.yml spells it: niyam-ref, else its name before P-56, else main. */
const REF = "inputs.niyam-ref || inputs.process-rules-ref || 'main'";

describe('checks.yml', () => {
  it("runs every job's CLI from the workflow's own commit, the ref only where GitHub has no job.workflow_sha", () => {
    const checkouts = Object.entries(jobs).flatMap(([name, job]) => job.steps.filter((step) => step.with?.path === '.niyam').map((step) => [name, step] as const));
    assert.ok(checkouts.length >= 7, 'each job that runs the CLI, and Settings, checks it out');
    for (const [name, step] of checkouts) {
      assert.equal(step.with?.repository, "${{ job.workflow_repository || 'veda-hq/niyam' }}", name);
      assert.equal(step.with?.ref, `\${{ job.workflow_sha || ${REF} }}`, name);
    }
    assert.doesNotMatch(CHECKS, /path: \.process-rules|\.process-rules\//, 'checked out under .niyam since P-56');
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps.filter((one) => one.run?.includes('src/cli.ts'))) assert.match(step.run ?? '', /^node \.niyam\/src\/cli\.ts /, name);
    }
  });

  it('takes niyam-ref, and process-rules-ref from a caller onboarded before P-56, declaring both so neither caller is invalid', () => {
    const inputs = (parse(CHECKS) as { on: { workflow_call: { inputs: Record<string, { type: string; default: string }> } } }).on.workflow_call.inputs;
    assert.deepEqual(Object.keys(inputs), ['niyam-ref', 'process-rules-ref']);
    for (const input of Object.values(inputs)) assert.deepEqual([input.type, input.default], ['string', ''], 'unset is empty, so the other one or main is taken');
    const env = jobs.settings?.steps.find((step) => step.name === 'Check niyam-ref names the release that runs') as Step & { env?: Record<string, string> };
    assert.equal(env.env?.REF, `\${{ ${REF} }}`);
    assert.equal(env.env?.INPUT, "${{ inputs.niyam-ref == '' && inputs.process-rules-ref != '' && 'process-rules-ref' || 'niyam-ref' }}");
    // The decisions job's key stays the old one, which runs at older releases share, so they never run at once.
    assert.match(CHECKS, /^ {6}group: process-rules-decisions-\$\{\{ github\.repository \}\}$/m);
  });

  // actionlint resolves a local reusable workflow's inputs, so callers passing each input lint clean and one
  // passing an input checks.yml does not declare is refused, as GitHub refuses the run. CI lints checks.yml itself.
  const actionlint = spawnSync('actionlint', ['-version'], { encoding: 'utf8' }).status === 0;
  it('lints clean for a caller passing either input, and refuses one passing another, with actionlint', { skip: !actionlint && 'actionlint is not installed' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'niyam-lint-'));
    try {
      spawnSync('git', ['init', '-q', dir]);
      mkdirSync(join(dir, '.github/workflows'), { recursive: true });
      writeFileSync(join(dir, '.github/workflows/checks.yml'), CHECKS);
      writeFileSync(join(dir, '.github/actionlint.yaml'), readFileSync(new URL('../.github/actionlint.yaml', import.meta.url), 'utf8'));
      for (const input of ['niyam-ref', 'process-rules-ref', 'other-ref']) {
        writeFileSync(join(dir, `.github/workflows/${input}.yml`), `name: niyam\non: pull_request\njobs:\n  niyam:\n    name: niyam\n    uses: ./.github/workflows/checks.yml\n    with:\n      ${input}: v1.2.3\n`);
      }
      const result = spawnSync('actionlint', ['-format', '{{json .}}'], { cwd: dir, encoding: 'utf8' });
      const errors = (JSON.parse(result.stdout || '[]') as { filepath: string; message: string }[]).map((error) => `${error.filepath.replace(/^.*\.github\/workflows\//, '')}: ${error.message}`);
      assert.equal(errors.length, 1, errors.join('\n'));
      assert.match(errors[0] ?? '', /^other-ref\.yml: input "other-ref" is not defined/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("Settings' file check, which reads .github/niyam.json, else the file before niyam (P-50)", () => {
    const script = jobs.settings?.steps.find((step) => step.name === 'Check .github/niyam.json')?.run ?? '';
    const repoWith = (files: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), 'niyam-settings-'));
      mkdirSync(join(dir, '.github'));
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, '.github', name), text);
      const result = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
      rmSync(dir, { recursive: true, force: true });
      return result;
    };

    it('reads the new file, the old one where the new one is missing, and the new one when both are there', () => {
      const pair = (owner: string) => `{"owner": "${owner}", "agent": "ExampleBot"}`;
      for (const [files, owner] of [
        [{ 'niyam.json': pair('new-owner') }, 'new-owner'],
        [{ 'process-rules.json': pair('old-owner') }, 'old-owner'],
        [{ 'niyam.json': pair('new-owner'), 'process-rules.json': pair('old-owner') }, 'new-owner'],
      ] as const) {
        const result = repoWith(files);
        assert.equal(result.status, 0, result.stdout);
        assert.equal(result.stdout.trim(), `niyam: owner ${owner} approves; agent ExampleBot builds.`);
      }
    });

    it('names the new file when neither is there, and the file it read when that is wrong', () => {
      const missing = repoWith({});
      assert.equal(missing.status, 1);
      assert.equal(missing.stdout.trim(), '::error file=.github/niyam.json::.github/niyam.json is missing; run niyam onboard');
      const wrong = repoWith({ 'process-rules.json': '[]' });
      assert.equal(wrong.status, 1);
      assert.match(wrong.stdout, /^::error file=\.github\/process-rules\.json::/);
    });
  });

  describe("Settings' niyam-ref check, under either input's name", () => {
    const script = jobs.settings?.steps.find((step) => step.name === 'Check niyam-ref names the release that runs')?.run ?? '';
    const dir = mkdtempSync(join(tmpdir(), 'niyam-checks-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const cli = join(dir, '.niyam');
    mkdirSync(cli);
    writeFileSync(join(cli, 'package.json'), '{"version": "0.5.33"}\n');
    const git = (...args: string[]) => spawnSync('git', ['-C', cli, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'release');
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    const run = (ref: string, own = sha, server = 'https://github.com', input = 'niyam-ref', caller = CALLER) =>
      spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, REF: ref, INPUT: input, CALLER: caller, OWN_SHA: own, SERVER: server } });
    /** A caller onboarded before P-56: its workflow and input under their old names. */
    const OLD_CALLER = 'example-org/example-app/.github/workflows/process-rules.yml@refs/heads/main';

    it('passes a ref that names the release that runs, by version or by commit, naming the input it came in', () => {
      for (const ref of ['v0.5.33', sha]) {
        const result = run(ref);
        assert.equal(result.status, 0, `${ref}: ${result.stdout}${result.stderr}`);
        assert.equal(result.stdout.trim(), `niyam: niyam-ref ${ref} is the release that runs, v0.5.33 (${sha}).`);
        const old = run(ref, sha, 'https://github.com', 'process-rules-ref', OLD_CALLER);
        assert.equal(old.status, 0);
        assert.equal(old.stdout.trim(), `niyam: process-rules-ref ${ref} is the release that runs, v0.5.33 (${sha}).`);
      }
    });

    it('fails a ref Dependabot left behind, naming the caller file and both fixes, under the input it came in', () => {
      for (const ref of ['v0.5.19', 'f'.repeat(40)]) {
        const result = run(ref);
        assert.equal(result.status, 1, ref);
        assert.equal(
          result.stdout.trim(),
          `::error file=.github/workflows/niyam.yml::niyam-ref is ${ref}, but this workflow runs the shared checks at v0.5.33. Dependabot and Renovate move only a job's uses: line. Run niyam onboard with v0.5.33, which moves every pin, or set niyam-ref: v0.5.33 on every job.`,
        );
        const old = run(ref, sha, 'https://github.com', 'process-rules-ref', OLD_CALLER);
        assert.equal(old.status, 1, ref);
        assert.equal(
          old.stdout.trim(),
          `::error file=.github/workflows/process-rules.yml::process-rules-ref is ${ref}, but this workflow runs the shared checks at v0.5.33. Dependabot and Renovate move only a job's uses: line. Run niyam onboard with v0.5.33, which moves every pin, or set process-rules-ref: v0.5.33 on every job.`,
        );
      }
    });

    it('warns on github.com when GitHub gives no job.workflow_sha, as the CLI then came from the ref itself', () => {
      const result = run('v0.5.33', '');
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^::warning::GitHub gave no job\.workflow_sha, so the checks run the CLI at niyam-ref v0\.5\.33, which may not be their own release\.\n/);
      assert.doesNotMatch(run('v0.5.33', '', 'https://ghe.example.com').stdout, /::warning::/);
      assert.doesNotMatch(run('v0.5.33').stdout, /::warning::/);
    });

    it('lets a branch through, saying which release runs, though it looks like a version or a commit', () => {
      for (const ref of ['main', 'v2-preview', 'v0.5.33-rc', 'deadbeef', sha.slice(0, 12)]) {
        const result = run(ref);
        assert.equal(result.status, 0, ref);
        assert.equal(result.stdout.trim(), `niyam: niyam-ref is the branch ${ref}; these checks run v0.5.33 (${sha}).`);
      }
    });
  });
});
