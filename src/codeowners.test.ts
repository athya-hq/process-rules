import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ownerRules, ownerRulesHere, ownerRulesProblem, withoutOwner } from './codeowners.ts';
import { AGENT, FakeSys, ROOT } from './fake.test.ts';

const SETTINGS = `${ROOT}/.github/process-rules.json`;

describe('withoutOwner', () => {
  it('drops a rule naming the owner alone', () => {
    assert.deepEqual(withoutOwner('# Owners\n* @Example-Owner\n/a/ @b\n', 'example-owner'), { lines: [2], dropped: 1, text: '# Owners\n/a/ @b\n' });
  });

  it('removes the owner from a rule with several owners, keeping the others in place', () => {
    const text = '*.ts @a   @example-owner @b\n/docs/ @example-owner\t@c\n/x @b @example-owner\n';
    assert.deepEqual(withoutOwner(text, 'example-owner'), {
      lines: [1, 2, 3],
      dropped: 0,
      text: '*.ts @a @b\n/docs/\t@c\n/x @b\n',
    });
  });

  it('keeps team handles, emails and logins that only contain the owner', () => {
    const text = '* @example-org/example-owner @example-owner-2 example-owner@example.com\n';
    assert.deepEqual(withoutOwner(text, 'example-owner'), { lines: [], dropped: 0, text });
  });

  it('removes the owner beside a team handle', () => {
    assert.equal(withoutOwner('* @example-org/core @example-owner\n', 'example-owner').text, '* @example-org/core\n');
  });

  it('keeps comments: whole lines, after the owners, and escaped patterns', () => {
    const text = [
      '# * @example-owner',
      '  # @example-owner',
      '*.js @a @example-owner # @example-owner reviews too',
      '/api/ @example-owner # only the owner',
      '\\#notes @example-owner @a',
      '* @a #@example-owner',
      '',
    ].join('\n');
    assert.deepEqual(withoutOwner(text, 'example-owner'), {
      lines: [3, 4, 5],
      dropped: 1,
      text: ['# * @example-owner', '  # @example-owner', '*.js @a # @example-owner reviews too', '\\#notes @a', '* @a #@example-owner', ''].join('\n'),
    });
  });

  it('keeps Windows line endings and rules with no owners', () => {
    assert.deepEqual(withoutOwner('/vendor/\r\n* @a @example-owner\r\n', 'example-owner'), {
      lines: [2],
      dropped: 0,
      text: '/vendor/\r\n* @a\r\n',
    });
  });
});

describe('ownerRules', () => {
  it('reads the file GitHub uses: .github/, then the root, then docs/', () => {
    const sys = new FakeSys();
    assert.equal(ownerRules(sys, ROOT, 'example-owner'), undefined);
    sys.files.set(`${ROOT}/docs/CODEOWNERS`, '* @example-owner\n');
    assert.equal(ownerRules(sys, ROOT, 'example-owner')?.path, 'docs/CODEOWNERS');
    sys.files.set(`${ROOT}/CODEOWNERS`, '* @example-owner\n');
    assert.equal(ownerRules(sys, ROOT, 'example-owner')?.path, 'CODEOWNERS');
    sys.files.set(`${ROOT}/.github/CODEOWNERS`, '* @a\n');
    assert.equal(ownerRules(sys, ROOT, 'example-owner'), undefined, 'GitHub ignores the others');
  });

  it('says what the rules do, for one rule and for several', () => {
    const one = { path: 'CODEOWNERS', lines: [1], dropped: 1, text: '' };
    assert.equal(
      ownerRulesProblem(one, 'example-owner', AGENT),
      'CODEOWNERS names example-owner in a rule (line 1): GitHub will ask example-owner to review every pull request ExampleBot opens, ' +
        "because ExampleBot authors them and GitHub never asks a pull request's author",
    );
    assert.match(ownerRulesProblem({ ...one, lines: [1, 4] }, 'example-owner', AGENT), /in 2 rules \(lines 1, 4\)/);
  });
});

describe('ownerRulesHere', () => {
  it("names the rules in the adopting repo whose settings name the agent", () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/.github/CODEOWNERS`, '* @example-owner\n');
    assert.match(ownerRulesHere(sys, AGENT) ?? '', /^\.github\/CODEOWNERS names example-owner in a rule \(line 1\).*; run process-rules onboard to remove example-owner from them$/);
  });

  it('says nothing outside a repo, without settings, with broken settings, or for another agent', () => {
    const sys = new FakeSys();
    sys.files.set(`${ROOT}/.github/CODEOWNERS`, '* @example-owner\n');
    assert.equal(ownerRulesHere(sys, 'OtherBot'), undefined);
    sys.files.set(SETTINGS, '{ "owner": "x" }');
    assert.equal(ownerRulesHere(sys, AGENT), undefined);
    sys.files.delete(SETTINGS);
    assert.equal(ownerRulesHere(sys, AGENT), undefined);
    sys.inRepo = false;
    assert.equal(ownerRulesHere(sys, AGENT), undefined);
  });
});
