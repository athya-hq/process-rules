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
const CALLER = 'example-org/example-app/.github/workflows/process-rules.yml@refs/heads/main';

describe('checks.yml', () => {
  it("runs every job's CLI from the workflow's own commit, the ref only where GitHub has no job.workflow_sha", () => {
    const checkouts = Object.entries(jobs).flatMap(([name, job]) => job.steps.filter((step) => step.with?.path === '.process-rules').map((step) => [name, step] as const));
    assert.ok(checkouts.length >= 7, 'each job that runs the CLI, and Settings, checks it out');
    for (const [name, step] of checkouts) {
      assert.equal(step.with?.repository, "${{ job.workflow_repository || 'veda-hq/niyam' }}", name);
      assert.equal(step.with?.ref, '${{ job.workflow_sha || inputs.process-rules-ref }}', name);
    }
    assert.doesNotMatch(CHECKS, /ref: \$\{\{ inputs\.process-rules-ref \}\}/);
  });

  describe("Settings' process-rules-ref check", () => {
    const script = jobs.settings?.steps.find((step) => step.name === 'Check process-rules-ref names the release that runs')?.run ?? '';
    const dir = mkdtempSync(join(tmpdir(), 'process-rules-checks-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const cli = join(dir, '.process-rules');
    mkdirSync(cli);
    writeFileSync(join(cli, 'package.json'), '{"version": "0.5.33"}\n');
    const git = (...args: string[]) => spawnSync('git', ['-C', cli, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'release');
    const sha = git('rev-parse', 'HEAD').stdout.trim();
    const run = (ref: string, own = sha, server = 'https://github.com') =>
      spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, REF: ref, CALLER, OWN_SHA: own, SERVER: server } });

    it('passes a ref that names the release that runs, by version or by commit', () => {
      for (const ref of ['v0.5.33', sha]) {
        const result = run(ref);
        assert.equal(result.status, 0, `${ref}: ${result.stdout}${result.stderr}`);
        assert.equal(result.stdout.trim(), `niyam: process-rules-ref ${ref} is the release that runs, v0.5.33 (${sha}).`);
      }
    });

    it('fails a ref Dependabot left behind, naming the caller file and both fixes', () => {
      for (const ref of ['v0.5.19', 'f'.repeat(40)]) {
        const result = run(ref);
        assert.equal(result.status, 1, ref);
        assert.equal(
          result.stdout.trim(),
          `::error file=.github/workflows/process-rules.yml::process-rules-ref is ${ref}, but this workflow runs the shared checks at v0.5.33. Dependabot and Renovate move only a job's uses: line. Run niyam onboard with v0.5.33, which moves every pin, or set process-rules-ref: v0.5.33 on every job.`,
        );
      }
    });

    it('warns on github.com when GitHub gives no job.workflow_sha, as the CLI then came from the ref itself', () => {
      const result = run('v0.5.33', '');
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^::warning::GitHub gave no job\.workflow_sha, so the checks run the CLI at process-rules-ref v0\.5\.33, which may not be their own release\.\n/);
      assert.doesNotMatch(run('v0.5.33', '', 'https://ghe.example.com').stdout, /::warning::/);
      assert.doesNotMatch(run('v0.5.33').stdout, /::warning::/);
    });

    it('lets a branch through, saying which release runs, though it looks like a version or a commit', () => {
      for (const ref of ['main', 'v2-preview', 'v0.5.33-rc', 'deadbeef', sha.slice(0, 12)]) {
        const result = run(ref);
        assert.equal(result.status, 0, ref);
        assert.equal(result.stdout.trim(), `niyam: process-rules-ref is the branch ${ref}; these checks run v0.5.33 (${sha}).`);
      }
    });
  });
});
