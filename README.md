# process-rules

Work rules for a repository that tracks its work in GitHub Issues and a GitHub
Project, with an owner account that approves and an agent account that builds.

Any repository can adopt it. No server, database or dashboard: a CLI, git
hooks and a shared GitHub Actions workflow.

## Status

Early. The CLI runs `machine`, `doctor`, `session-start` and `onboard`. What comes next, and in what
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

In Claude Code, the client's SessionStart hook runs `process-rules
session-start`. It appends a lock to `CLAUDE_ENV_FILE`: a token GitHub refuses,
no credential helper, nothing inherited that could bring one back (`git -c`
injection, `GIT_CONFIG`, askpass), GitHub's SSH remotes on HTTPS and every
other SSH remote refused. Then, when this Mac has the session file `machine`
wrote for the agent the repo's settings name, exactly as `machine` writes it,
it appends that file, which replaces the lock with the agent's identity. Any
other outcome leaves GitHub locked out and says why, so a session never falls
back to the owner's login. Cloud sessions are left alone.

The session file holds no secret: `GH_TOKEN` is read from the keychain on each
use, and is a value GitHub refuses when the keychain has none. Git gets a
credential helper that drops every earlier one and hands the agent's token to
github.com only, commits as the agent's no-reply address and signs with its
key.

The lock lives in the session's environment, which a session that ignores it
could change, so `machine` ends by offering to lock the owner away: to sign
`gh` out of every account other than the agent's, active or not, and to remove a git password for
github.com saved in the macOS keychain. It warns about SSH keys in `~/.ssh`
with no passphrase. Declining leaves them, and `doctor` keeps naming them.

`process-rules doctor` re-checks the key, the token and its scopes, the key's
registration and the session file, names the step to re-run, and warns 14
days before the token ends.

## Adopting

1. On each Mac that runs agent sessions: `process-rules machine <agent>`.
2. In the client repository, as its owner: `process-rules onboard <owner>
   <agent>`. It writes `.github/process-rules.json`, adds a SessionStart hook
   running `process-rules session-start` to `.claude/settings.json`, and
   writes `.github/workflows/process-rules.yml`, which calls this repository's
   shared checks (`.github/workflows/checks.yml`). It checks the agent can
   push. With no access, `onboard` offers to give it write access through your
   `gh` and to accept the invitation as the agent; with read access only, it
   asks you to give it the Write role; and it names an organisation that
   requires SAML authorisation or blocks classic tokens. Through your `gh`
   login as the owner (which needs the `project` scope, and `admin:org` in an
   organisation), it sets up the work board: the organisation's issue types
   (Work item, Slice, State, Decision, Brief), the repo's labels (`approved`,
   `needs-owner`, `mechanical`, `veto`, `expiring`, `cannot-run-here`), and a
   Project "<repo> work" linked to the repo with the fields Step, Decision and
   Review date. It prints the views to make by hand, since GitHub's API cannot
   make them. Last, it pushes
   one signed test commit as the agent to a throwaway branch, checks GitHub
   shows it Verified by the agent, and deletes the branch. Each change waits
   for a yes; commit the three files afterwards. The repository needs at
   least one commit.

The shared checks run five jobs. **Settings** validates
`.github/process-rules.json`. **PR identity** runs on pull requests: every
commit that claims the agent (its login or its no-reply address) must be
Verified as the agent, and agent commits must be pushed by the agent, so agent
work pushed with the owner's login fails. **Work rules** runs on the agent's
pull requests: each names exactly one slice, as a line `Slice: #N`, and that
slice may be built:

- it is a Slice issue under a Work item the owner labeled `approved`;
- if it was added to the work item after the approval, the owner left a
  comment starting `Decision:` naming it;
- each of its State sub-issues closed as not planned after the approval
  carries the owner's `Decision:` comment;
- no other open pull request names it.

**Design frames** is optional: with `"figma": { "library": "<file key>" }` in
the settings and a `FIGMA_TOKEN` Actions secret, each State of the slice an
agent pull request builds, other than one closed as not planned, must link a
Figma frame (`figma.com/design/...?node-id=...`) that holds at least one
component published by that library and is not a captured image (an image
covering half the frame or more). Without either, the job says the check is
off and passes.

**Decisions, weekly** runs on Mondays (and by hand). A Decision issue carries
its fields one per line: `Kind:` (Override, Risk or Bet), `Review:`,
`Expires:`, `Check:` (a command in backticks; exit 0 means the decision still
holds) and `Undo:`. For each open Decision issue, a check that reads laptop
files (`~/`, `$HOME`, `/Users/`, `/home/`) is labeled `cannot-run-here`; any
other check runs in the checkout with only `PATH` and `HOME` set, for at most
two minutes (a check that runs out of time is not counted as tripped), and
when it fails the decision gets a comment and one undo issue labeled
`needs-owner`. Runs do not overlap, and after 45 minutes of checks the rest
wait for next week. An Override whose expiry is within 30 days is labeled
`expiring`; one whose expiry has passed is named in the run's log. A check runs
only when the owner or the agent wrote the issue and was the last to edit it.

`onboard` also writes a pre-push git hook running `process-rules pre-push`,
which applies the same rules before an agent session pushes: all the commits
one push brings, on one branch, name one slice between them as a
`Slice: #N` trailer. In an agent session, a push is refused when the CLI is
missing or the session has no token. When the repository already has its own
pre-push hook, or git runs hooks from a folder outside the repository (a
global `core.hooksPath`), `onboard` leaves it alone and names the line to add:
`process-rules pre-push "$@"`. The client workflow re-runs the checks when a
pull request's description is edited. After upgrading process-rules, run
`onboard` again: it replaces the workflow when a release needs more
permissions. Make `process-rules / PR
identity` and `process-rules / Work rules` required checks on the default
branch.

Until releases (P-11), the client's workflow follows this repository's `main`,
and the hook needs `process-rules` on the machine's `PATH`; without it the
hook tells the session to stop.

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
