# Agents in niyam (formerly process-rules)

## Merging

Right after `gh pr create`, turn on auto-merge: `gh pr merge --auto --squash`
(in the Claude app, the pull request tools' auto-merge does the same). The
`main` ruleset holds the merge until every required check passes, Cubic's
review, PR identity and Work rules included, and every review thread is
resolved. Nobody waits for a person.

Leave auto-merge off only to hold a pull request on purpose (say why in it),
or for a change that needs the owner's yes first, such as a major release. A
merge publishes nothing: only a `v*` tag releases.
