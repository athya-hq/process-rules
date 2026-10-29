# process-rules

Work rules for a repository that tracks its work in GitHub Issues and a GitHub
Project, with an owner account that approves and an agent account that builds.

Built for [Athya](https://github.com/athya-hq); written so any repository can
adopt it. No server, database or dashboard: a CLI, git hooks and a shared
GitHub Actions workflow.

## Status

Skeleton. The CLI runs `help` and `version`; nothing else yet. Planned, in
order:

| Feature                                  | What it does                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `process-rules machine`                  | Sets up a Mac or cloud session so agents act as the agent account        |
| `process-rules doctor`                   | At session start, refuses to work under the wrong identity               |
| `process-rules setup`                    | Creates the Project, issue types, labels and fields in an adopting repo  |
| Pre-push identity guard                  | Refuses agent commits pushed from the owner account                      |
| Work rules check                         | At pre-push, then on the PR: no unapproved start, one slice per PR       |
| PR identity check                        | A required check that the PR's commits come from the right account      |
| Weekly decisions job                     | Runs each Decision issue's check; opens an undo issue when one trips     |
| Review routine                           | Settles due reversible decisions with reasoning; holds the rest          |

## Adopting

Not yet. Adoption will be one workflow file calling this repository's shared
workflow at a pinned version, plus `process-rules setup` once per repository
and `process-rules machine` once per machine.

## Developing

Node 24 (`.nvmrc`) and pnpm.

```bash
pnpm install
pnpm check
```

`pnpm check` typechecks, runs the tests with a coverage floor (95% lines and
functions, 90% branches), builds `dist/` and runs it. `pnpm scan:secrets` runs
Gitleaks and TruffleHog over the working tree; CI runs both over the whole
history.

## License

MIT
