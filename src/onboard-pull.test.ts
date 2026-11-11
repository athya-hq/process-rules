import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeSys, TOKEN } from './fake.test.ts';
import { mergeQueue, pullTitle } from './onboard-pull.ts';

describe('pullTitle', () => {
  const plain = 'chore(niyam): onboard at v1.2.3';

  it('is plain Conventional Commits when the history gives no emoji style, or none', () => {
    assert.equal(pullTitle('1.2.3'), plain);
    assert.equal(pullTitle('1.2.3', []), plain);
    assert.equal(pullTitle('1.2.3', ['feat: a thing', 'fix(api): b', '✨ feat: c']), plain, 'most subjects lead with no emoji');
    assert.equal(pullTitle('1.2.3', ['✨ feat: a', 'fix: b']), plain, 'half is not most');
  });

  it("leads with an emoji when most of the default branch's recent subjects do", () => {
    assert.equal(pullTitle('1.2.3', ['✨ feat(ui): a', '🐛 fix: b', 'docs: c']), `🔧 ${plain}`, 'no chore to copy: the gitmoji for configuration');
    assert.equal(pullTitle('1.2.3', ['✨ feat: a', 'Merge pull request #4 from x/y', 'Merge branch main']), `🔧 ${plain}`, "merge commits are git's, not the repo's style");
  });

  it("copies the emoji the repo used for onboard before, else the one it uses most for chores", () => {
    assert.equal(pullTitle('1.2.3', ['🔥 chore(tooling): a', '♻️ refactor: b', '🔥 chore: c', '🧹 chore(x): d']), `🔥 ${plain}`);
    assert.equal(pullTitle('1.2.3', ['🔥 chore(tooling): a', '🔥 chore: c', '📦 chore(process-rules): onboard at v1.2.2']), `🔥 ${plain}`, 'not an onboard before niyam (P-57)');
    assert.equal(pullTitle('1.2.3', ['♻️ refactor: a', '⬆️ chore(deps): b', '👨‍💻 feat: c']), `⬆️ ${plain}`, 'emoji of more than one code point');
    assert.equal(pullTitle('1.2.3', ['🇮🇳 chore(i18n): a', '👍🏽 feat: b', '🧑🏿‍💻 fix: c']), `🇮🇳 ${plain}`, 'flags, skin tones and joined emoji');
  });

  it('writes a gitmoji shortcode when the repo does', () => {
    assert.equal(pullTitle('1.2.3', [':sparkles: feat: a', ':bug: fix: b']), `:wrench: ${plain}`);
    assert.equal(pullTitle('1.2.3', [':sparkles: feat: a', ':fire: chore: b']), `:fire: ${plain}`);
  });
});

describe('mergeQueue', () => {
  const REPO = 'https://api.github.com/repos/example-org/example-app';
  /** GitHub holding these files on main, and answering `failing` for any path it names. */
  const on = (files: Record<string, string>, failing: Record<string, number> = {}): FakeSys => {
    const sys = new FakeSys();
    for (const path of ['.mergify.yml', '.mergify/config.yml', '.github/mergify.yml']) {
      const text = files[path];
      const status = failing[path] ?? (text === undefined ? 404 : 200);
      sys.route('GET', `${REPO}/contents/${path}?ref=main`, { status, json: status === 200 ? { content: Buffer.from(text ?? '').toString('base64'), encoding: 'base64' } : { message: 'Not Found' } });
    }
    return sys;
  };
  const find = (sys: FakeSys) => mergeQueue(sys, 'example-org/example-app', 'main', TOKEN);
  const queueRule = 'queue_rules:\n  # the one queue\n  - name: default\n    merge_method: squash\n';
  const autoQueue = 'pull_request_rules:\n  - name: queue when green\n    conditions:\n      - base=main\n      - check-success=CI\n    actions:\n      queue:\n';

  it('finds a queue that takes pull requests by itself, in the first config Mergify reads, as the agent', async () => {
    for (const path of ['.mergify.yml', '.mergify/config.yml', '.github/mergify.yml']) assert.equal(await find(on({ [path]: queueRule + autoQueue })), path);
    const sys = on({ '.mergify.yml': `queue_rules: [\n  { name: default,\n    merge_method: squash },\n]\nmerge_protections_settings:\n  auto_merge_conditions: true\n` });
    assert.equal(await find(sys), '.mergify.yml', "flow style over several lines, and merge protections' auto-merge");
    assert.equal(await find(on({ '.mergify.yml': `${queueRule}merge_protection_settings:\n  auto_merge_conditions:\n    - base=main\n` })), '.mergify.yml', 'auto-merge for some pull requests, the other spelling');
    assert.ok(sys.requests.every((r) => r.token === TOKEN));
  });

  it('finds none without a config, a queue rule, or a rule that queues without a label', async () => {
    assert.equal(await find(on({})), undefined);
    assert.equal(await find(on({ '.mergify.yml': autoQueue })), undefined, 'no queue rule');
    assert.equal(await find(on({ '.mergify.yml': queueRule })), undefined, 'queued by command only');
    assert.equal(await find(on({ '.mergify.yml': 'queue_rules: []\n' + autoQueue })), undefined, 'an empty list');
    assert.equal(await find(on({ '.mergify.yml': `${queueRule}pull_request_rules:\n  - conditions: [label=queue]\n    actions: { queue: {} }\n` })), undefined, 'queued once labelled');
    assert.equal(await find(on({ '.mergify.yml': `# ${queueRule}` })), undefined, 'commented out');
    assert.equal(await find(on({ '.mergify.yml': 'queue_rules:\n  - name: default\n    autoqueue: true\n' })), undefined, "autoqueue, which Mergify replaced");
    assert.equal(await find(on({ '.mergify.yml': `${queueRule}merge_protections_settings:\n  auto_merge_conditions: [label=automerge]\n` })), undefined, 'auto-merge once labelled');
    assert.equal(await find(on({ '.mergify.yml': `${queueRule}merge_protections_settings:\n  auto_merge_conditions: null\n` })), undefined, 'auto-merge off');
    assert.equal(await find(on({ '.mergify.yml': 'pull_request_rules: []\n', '.github/mergify.yml': queueRule + autoQueue })), undefined, 'Mergify reads the first config only');
  });

  it('finds none when GitHub does not say, or the config is not YAML', async () => {
    assert.equal(await find(on({ '.github/mergify.yml': queueRule + autoQueue }, { '.mergify.yml': 500 })), undefined);
    assert.equal(await find(on({ '.mergify.yml': 'queue_rules: [\n' })), undefined);
    const down = on({});
    down.http = () => Promise.reject(new Error('ECONNRESET'));
    assert.equal(await find(down), undefined);
  });
});
