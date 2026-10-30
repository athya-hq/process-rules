# process-rules

Work rules for a repository that tracks its work in GitHub Issues and a GitHub
Project, with an owner account that approves and an agent account that builds.

Any repository can adopt it. No server, database or dashboard: a CLI, git
hooks and a shared GitHub Actions workflow.

## Status

Early. The CLI runs `machine` and `doctor`. What comes next, and in what
order: [docs/roadmap.md](docs/roadmap.md). Decisions:
[docs/decisions.md](docs/decisions.md).

## Agent identity on a Mac

The adopting repo names its accounts in `.github/process-rules.json`:

```json
{ "owner": "example-owner", "agent": "ExampleBot" }
```

`process-rules machine ExampleBot`, run once per Mac and agent account (inside
an adopting repo the name can be left out), needs no client repo. It makes the
agent's signing key (`~/.ssh/<agent, lowercased>_signing`), opens GitHub's
classic-token page with the scopes filled in (`repo`, `workflow`, `read:org`,
`project`, `write:ssh_signing_key`) and reads the token through a hidden prompt
into the keychain (service `process-rules`), refusing a fine-grained token,
missing scopes or no expiry. It then registers the key as the agent's signing key and writes
`~/.config/process-rules/<agent, lowercased>/session.sh`. Each change waits
for a yes. Why a classic token: [docs/decisions.md](docs/decisions.md).

An agent session sources `session.sh` at start (in Claude Code, a SessionStart
hook appends it to `CLAUDE_ENV_FILE`). It holds no secret: `GH_TOKEN` is read
from the keychain on each use, and is a value GitHub refuses when the keychain
has none. Git gets a credential helper that drops every earlier one and hands the
agent's token to github.com only, commits as the agent's no-reply address and
signs with its key. GitHub's SSH remotes go over HTTPS and any other SSH
remote fails, so nothing falls back to the owner's login or keys.

`process-rules doctor` re-checks the key, the token and its scopes, the key's
registration and the session file, names the step to re-run, and warns 14
days before the token ends.

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
