# process-rules

Work rules for a repository that tracks its work in GitHub Issues and a GitHub
Project, with an owner account that approves and an agent account that builds.

Any repository can adopt it. No server, database or dashboard: a CLI, git
hooks and a shared GitHub Actions workflow.

## Status

Skeleton. The CLI runs `help` and `version`; nothing else yet. What comes
next, and in what order: [docs/roadmap.md](docs/roadmap.md). Decisions:
[docs/decisions.md](docs/decisions.md).

## Adopting

Not yet. Adoption will be one workflow file calling this repository's shared
workflow at a pinned version, plus `process-rules onboard` once per repository
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
