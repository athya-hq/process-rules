import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNKNOWN, commands } from './shell.ts';

const FILES = new Map([['body.md', 'from a file\n']]);
const read = (path: string): string | undefined => FILES.get(path);

/** Each command's words as text, unknown parts shown as ?. */
function words(line: string): string[][] {
  return commands(line, read).map((simple) => simple.words.map((word) => word.text.replaceAll(UNKNOWN, '?')));
}

const stdin = (line: string, at = 0) => commands(line, read)[at]?.stdin;

describe('commands', () => {
  it('splits words and commands as a shell does', () => {
    assert.deepEqual(words('gh pr list; git push && echo "a b" || x | y & z'), [['gh', 'pr', 'list'], ['git', 'push'], ['echo', 'a b'], ['x'], ['y'], ['z']]);
    assert.deepEqual(words('(cd x) # a comment\nnext   one\t two'), [['cd', 'x'], ['next', 'one', 'two']]);
    assert.deepEqual(words('a#b'), [['a#b']]);
  });

  it('works out quotes and escapes', () => {
    assert.deepEqual(words(`say 'it''s' "a \\"q\\" \\$x \\\\ \\z" b\\ c d\\\ne`), [['say', 'its', 'a "q" $x \\ \\z', 'b c', 'de']]);
    assert.deepEqual(words(`x $'a\\nb\\tc\\'d' $'e'`), [['x', 'a\nb\tc\'d', 'e']]);
    assert.deepEqual(words(`x "" ''`), [['x', '', '']]);
    assert.deepEqual(words(`x 'open`), [['x', 'open']]);
    assert.deepEqual(words('x a\\'), [['x', 'a']]);
    assert.deepEqual(words(`x $'tail\\`), [['x', 'tail\\']]);
  });

  it('marks what only the running shell knows', () => {
    assert.deepEqual(words('echo $HOME ${X:-y} $1 $? $((1+2)) `date` "$(date)" "`id`" $ a$'), [['echo', '?', '?', '?', '?', '?', '?', '?', '?', '$', 'a$'], ['date'], ['date'], ['id']]);
    const [simple] = commands('echo "$X tail" "head $Y"', read);
    assert.deepEqual(
      simple?.words.map(({ known, opensUnknown }) => ({ known, opensUnknown })),
      [
        { known: true, opensUnknown: false },
        { known: false, opensUnknown: true },
        { known: false, opensUnknown: false },
      ],
    );
    assert.deepEqual(words('echo ${a{b}c} `a\\`b` ${open'), [['echo', '?', '?', '?'], ['a?'], ['b']], 'an escaped backquote nests a substitution, as in bash');
  });

  it("reads cat's heredoc or file in a command substitution", () => {
    assert.deepEqual(words("gh x --body \"$(cat <<'EOF'\nline one\n  line (two)\nEOF\n)\" --after"), [['gh', 'x', '--body', 'line one\n  line (two)', '--after'], ['cat']]);
    assert.deepEqual(words('x "$(cat body.md)" $(cat missing) $(cat a b) $(ls) $(cat "$F") $(a; b)')[0], ['x', 'from a file', '?', '?', '?', '?', '?']);
    assert.deepEqual(words('echo $(gh issue comment 1 -b hi) `gh pr comment 2 -b yo`').slice(1), [['gh', 'issue', 'comment', '1', '-b', 'hi'], ['gh', 'pr', 'comment', '2', '-b', 'yo']], 'the commands a substitution runs are read too');
    assert.deepEqual(words('x $(cat)'), [['x', '?'], ['cat']]);
  });

  it('feeds heredocs, here-strings and < files to their command', () => {
    assert.deepEqual(stdin("cmd <<'EOF'\nbody $X\nEOF\nafter"), { text: 'body $X\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<EOF\nplain\nEOF'), { text: 'plain\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<EOF\n$X then\nEOF'), { text: '$X then\n', known: false, opensUnknown: true });
    assert.deepEqual(stdin('cmd <<"EOF"\n`x`\nEOF'), { text: '`x`\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<-\\EOF\n\tindented\n\tEOF'), { text: 'indented\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd <<EOF\nunterminated'), { text: 'unterminated\n', known: true, opensUnknown: false });
    // The shell takes a delimiter as written, quotes off, never expanded.
    assert.deepEqual(words('cmd <<$D\nbody\n$D\ngh after'), [['cmd'], ['gh', 'after']]);
    assert.equal(stdin("cmd <<'$D'\nbody\n$D")?.text, 'body\n');
    assert.deepEqual(stdin('cmd <<< "a string"'), { text: 'a string\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd < body.md'), { text: 'from a file\n', known: true, opensUnknown: false });
    assert.deepEqual(stdin('cmd < missing'), { text: '', known: false, opensUnknown: true });
    assert.deepEqual(stdin('cmd < "$F"'), { text: '', known: false, opensUnknown: true });
    assert.deepEqual(words("a <<'X' && b <<'Y'\none\nX\ntwo\nY\nc"), [['a'], ['b'], ['c']]);
    assert.equal(stdin("a <<'X' && b <<'Y'\none\nX\ntwo\nY", 1)?.text, 'two\n');
  });

  it('skips output redirections and their file descriptors', () => {
    assert.deepEqual(words('cmd arg 2>&1 >out.txt >> "log" 3<&0 x2>y'), [['cmd', 'arg', 'x2']]);
    assert.equal(stdin('cmd 2>&1'), undefined);
  });

  it('reads the script of sh -c, bash -c and the like', () => {
    assert.deepEqual(words(`bash -c 'gh pr comment 1 --body "hi"'`), [['bash', '-c', 'gh pr comment 1 --body "hi"'], ['gh', 'pr', 'comment', '1', '--body', 'hi']]);
    assert.deepEqual(words('/bin/sh -lc x'), [['/bin/sh', '-lc', 'x'], ['x']]);
    assert.deepEqual(words('bash --rcfile x'), [['bash', '--rcfile', 'x']]);
    assert.deepEqual(words('zsh -c "$X"'), [['zsh', '-c', '?']]);
    assert.deepEqual(words('sh -c'), [['sh', '-c']]);
  });
});
