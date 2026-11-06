import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeQueue, pullTitle } from './onboard-pull.ts';

describe('pullTitle', () => {
  const plain = 'chore(process-rules): onboard at v1.2.3';

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
    assert.equal(pullTitle('1.2.3', ['🔥 chore(tooling): a', '🔥 chore: c', '📦 chore(process-rules): onboard at v1.2.2']), `📦 ${plain}`);
    assert.equal(pullTitle('1.2.3', ['♻️ refactor: a', '⬆️ chore(deps): b', '👨‍💻 feat: c']), `⬆️ ${plain}`, 'emoji of more than one code point');
  });

  it('writes a gitmoji shortcode when the repo does', () => {
    assert.equal(pullTitle('1.2.3', [':sparkles: feat: a', ':bug: fix: b']), `:wrench: ${plain}`);
    assert.equal(pullTitle('1.2.3', [':sparkles: feat: a', ':fire: chore: b']), `:fire: ${plain}`);
  });
});

describe('mergeQueue', () => {
  const at = (files: Record<string, string>) => (path: string) => files[path];
  const queued = 'queue_rules:\n  # the one queue\n  - name: default\n    merge_method: squash\n';

  it('finds a Mergify config with a queue rule, wherever Mergify reads it from', () => {
    for (const path of ['.mergify.yml', '.mergify/config.yml', '.github/mergify.yml']) assert.equal(mergeQueue(at({ [path]: queued })), path);
    assert.equal(mergeQueue(at({ '.mergify.yml': `# Mergify\nmerge_queue:\n  max_parallel_checks: 2\n\n${queued}` })), '.mergify.yml');
    assert.equal(mergeQueue(at({ '.mergify.yml': 'queue_rules: [{ name: default }]\n' })), '.mergify.yml', 'flow style');
  });

  it('finds none without a config, or with one that has no queue rule', () => {
    assert.equal(mergeQueue(at({})), undefined);
    assert.equal(mergeQueue(at({ '.mergify.yml': 'pull_request_rules:\n  - name: label\n    actions:\n      label:\n        add: [x]\n' })), undefined);
    assert.equal(mergeQueue(at({ '.mergify.yml': 'queue_rules: []\n' })), undefined, 'an empty list');
    assert.equal(mergeQueue(at({ '.mergify.yml': 'queue_rules:\n\npull_request_rules: []\n' })), undefined, 'an empty key');
    assert.equal(mergeQueue(at({ '.mergify.yml': '# queue_rules:\n#   - name: default\n' })), undefined, 'commented out');
  });
});
