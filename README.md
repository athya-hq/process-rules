# process-rules

Work rules for a repository that tracks its work in GitHub Issues and a GitHub
Project, with an owner account that approves and an agent account that builds.

Any repository can adopt it. No server, database or dashboard: a CLI, git
hooks and a shared GitHub Actions workflow.

## Status

Early. The CLI runs `machine`, `doctor`, `session-start`, `guard`, `onboard` and `propose`. What comes next, and in what
order: the Slice issues under
[process-rules roadmap v1](https://github.com/athya-hq/process-rules/issues/22),
on the Project [process-rules work](https://github.com/orgs/athya-hq/projects/2);
[docs/roadmap.md](docs/roadmap.md) keeps version v1 as approved. Decisions:
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
missing scopes or no expiry. It then registers the key as the agent's signing key, writes
`~/.config/process-rules/<agent, lowercased>/session.sh`, and writes the
launcher `~/.config/process-rules/bin/process-rules`, which the Claude Code
hooks and the pre-push git hook run. The
launcher names the node that ran `machine` by its real path (not a version
manager's per-shell one, which the Claude app's hooks may not have), so the
hooks need no node on their `PATH`. Each change waits for a yes. Why a classic token: [docs/decisions.md](docs/decisions.md).

A client's `.claude/settings.json` locks GitHub out of every session before
any hook runs: its `env` holds the lock's variables (a `GH_TOKEN` GitHub
refuses, no credential helper, GitHub's SSH remotes on HTTPS and every other
SSH remote refused), so a session whose hook never ran or failed reaches
GitHub as nobody, never as the owner. In a Claude cloud session the
SessionStart hook lifts it only once GitHub says the session is the agent
(see Claude cloud sessions below).

In Claude Code, the client's SessionStart hook runs `process-rules
session-start`. It appends a lock to `CLAUDE_ENV_FILE`: a token GitHub refuses,
no credential helper, nothing inherited that could bring one back (`git -c`
injection, `GIT_CONFIG`, askpass), GitHub's SSH remotes on HTTPS and every
other SSH remote refused. Then, when this Mac has the session file `machine`
wrote for the agent the repo's settings name, exactly as `machine` writes it,
it appends that file, which replaces the lock with the agent's identity. Any
other outcome leaves GitHub locked out and says why, so a session never falls
back to the owner's login. When the CLI is missing or fails, the hook still
tells the session to stop, with what the CLI printed.

Before each Bash command, the client's PreToolUse hook runs `process-rules
guard`: a command running `gh` or a git command that reaches a remote (push,
fetch, pull, clone, ls-remote, remote, submodule) is refused, with the reason,
unless session-start gave this session the agent identity. Hooks cannot see
the variables session-start gives the session's shells, so session-start
records how it left each session in
`~/.config/process-rules/sessions/<session id>.json` and the guard reads that.
A command not naming `gh` or `git` as a word goes ahead without starting the CLI;
when the CLI cannot run, every command naming either is refused.

The session file holds no secret: `GH_TOKEN` is read from the keychain on each
use, and is a value GitHub refuses when the keychain has none. Git gets a
credential helper that drops every earlier one and hands the agent's token to
github.com only, commits as the agent's no-reply address and signs with its
key.

The lock lives in the session's environment, which a session that ignores it
could change, so `machine` ends by offering to lock the owner away: to sign
`gh` out of every account other than the agent's, active or not, and to remove a git password for
github.com saved in the macOS keychain. It warns about SSH keys in `~/.ssh`
with no passphrase, and names the account SSH reaches GitHub as without
asking (a key in the SSH agent or the keychain). Declining leaves them, and
`doctor` keeps naming them. The owner's SSH access is left alone, since it is
the owner's own way to GitHub (docs/decisions.md); agent sessions send GitHub
over HTTPS and refuse SSH, and the pre-push hook refuses their pushes over
SSH.

`process-rules doctor` re-checks the key, the token and its scopes, the key's
registration, the session file and that the launcher runs, names the step to re-run, and warns 14
days before the token ends. Run in an adopting repo, it also warns when the
repo's CODEOWNERS names the owner.

## Adopting

1. On each Mac that runs agent sessions: `process-rules machine <agent>`.
2. In the client repository, as its owner: `process-rules onboard`. It
   suggests the owner from your `gh` login and the agent from the accounts
   `machine` set up on this Mac, for you to confirm (or name them:
   `process-rules onboard <owner> <agent>`). It writes `.github/process-rules.json`, adds to `.claude/settings.json`
   the lock in `env`, a SessionStart hook running `process-rules
   session-start` and a PreToolUse hook running `process-rules guard`, and
   writes `.github/workflows/process-rules.yml`, which calls this repository's
   shared checks (`.github/workflows/checks.yml`) from two jobs: `process-rules`
   on pull requests and pushes, read-only, and `process-rules-weekly` on the
   weekly run, the only one that writes to issues. It checks the agent can
   push. With no access, or read access only (a public repo, or an
   organisation's base permission), `onboard` offers to give it write access
   through your `gh` and to accept the invitation as the agent; and it names
   an organisation that
   requires SAML authorisation or blocks classic tokens. Through your `gh`
   login as the owner (which needs the `project` scope, and `admin:org` in an
   organisation), it sets up the work board: the organisation's issue types
   (Work item, Slice, State, Decision, Brief), the repo's labels (`approved`,
   `needs-owner`, `mechanical`, `veto`, `expiring`, `cannot-run-here`), and a
   Project "<repo> work" linked to the repo. It makes that Project by copying
   the product's public [process-rules template](https://github.com/orgs/athya-hq/projects/4),
   which holds the fields Step, Decision and Review date and the views Needs
   you (`label:needs-owner is:open`), Board (showing linked pull requests),
   Work items (`type:"Work item"`, grouped by Step), Decisions
   (`type:Decision`, grouped by Decision) and Reviews due (`"Review
   date":<=@today`), with its workflows; so the board needs nothing done by
   hand. If a copy's workflows arrive off, `onboard` names the ones to turn on. A Project of that title made before the template is offered a move
   to a copy: its open items move with their Status, Step, Decision and Review
   date, and the old one is closed as "<title> (old)". When GitHub refuses the
   copy, or the owner keeps the old Project, `onboard` adds the fields and
   makes or updates the views itself, and prints the two things GitHub's API
   cannot set: the grouping and the auto-archive workflow. Last, it pushes
   one signed test commit as the agent to a throwaway branch, checks GitHub
   shows it Verified by the agent (asking again when the network or GitHub
   fails for a moment), and deletes the branch. Each change waits
   for a yes; commit the files afterwards. When a rule in the repo's
   CODEOWNERS (the file GitHub uses: `.github/CODEOWNERS`, else `CODEOWNERS`,
   else `docs/CODEOWNERS`) names the owner, GitHub will ask the owner to
   review every agent pull request that changes a file those rules match,
   since the agent authors them and GitHub never asks a pull request's
   author. Once the test commit is Verified, `onboard` says so and offers to
   remove the owner's handle from those rules, dropping a rule left with no
   owners (its paths then fall to the rules before it). Teams, other owners
   and comments stay, and without a yes the file stays as it is. An existing `.claude/settings.json`
   keeps its layout: `onboard` adds only its entries, and replaces the hook
   entries an older release wrote where they stand. The repository needs at
   least one commit. The pull request checks read the settings from the base
   branch, so a pull request cannot rename the agent it is checked against.
   The pull request that first commits them passes PR identity, Work rules
   and Design frames, saying the repo is not adopted on its base yet, as for
   a feature that is off; they apply from the next pull request.

The shared checks run five jobs. **Settings** validates
`.github/process-rules.json`. **PR identity** runs on pull requests: every
commit that claims the agent (its login or its no-reply address) must be
Verified as the agent, and agent commits must be pushed by the agent, so agent
work pushed with the owner's login fails. **Work rules** runs on the agent's
pull requests: each names exactly one slice, as a line `Slice: #N`, and that
slice may be built:

- it is a Slice issue under a Work item the owner labeled `approved`;
- if it was added to the work item after the approval, the owner approved
  it: a 👍 on the agent's proposal for it, made after it was added, or a
  comment starting `Decision:` naming it;
- each of its State sub-issues closed as not planned after the approval
  carries the owner's approval: a 👍 on the agent's proposal for it, or a
  `Decision:` comment;
- no other open pull request names it.

**Approving with one tap.** In an agent session, `process-rules propose
<issue>` asks the owner for what a slice owes: given the slice, it comments
on it as the agent, one `Proposal:` comment for its addition after the
approval and one for each State dropped after it (given a State, for that
state alone), mentioning the owner, and labels the slice `needs-owner`, so it
shows in the owner's Needs you view and their GitHub notifications. The owner
approves a proposal by reacting 👍 to it, from the phone or the web; a typed
`Decision:` comment still works. A 👍 counts only from the owner, only on the
agent's comment starting `Proposal:` whose first `#N` is the slice or state
it approves, and only when made after the proposal's last edit (and, for a
slice, after it was last added). Run again, `propose` posts nothing twice, and
once the owner has approved everything it takes `needs-owner` off. A
reaction does not re-run a pull request's checks: the agent proposes before
it starts, and pre-push or a re-run of Work rules sees the 👍.

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
two minutes and five more seconds to end it (a check that runs out of time is
not counted as tripped), and
when it fails the decision gets a comment and one undo issue labeled
`needs-owner`. Runs do not overlap, and after 45 minutes of checks the rest
wait for next week. An Override whose expiry is within 30 days is labeled
`expiring`; one whose expiry has passed is named in the run's log. A check runs
only when the owner or the agent wrote the issue and was the last to edit it.

The **review routine** is a weekly scheduled agent session in the client
repository, working as the agent; its prompt is
[routines/review.md](routines/review.md). It runs `process-rules reviews-due`
for the open decisions whose `Review:` date has come, then for each one either
keeps it (comment `Kept:` with reasoning and a new review date) or settles it
(comment `Settled:` with reasoning, and closes it), labeling both `veto` so
the owner has a week to reverse it. A decision touching secrets, money or
production is held for the owner with a suggestion and `needs-owner`. The
weekly job removes `veto` once the week has passed.

`onboard` also writes a pre-push git hook running `process-rules pre-push`,
for every adopter. In a local agent session (one session-start set up, or
any shell Claude Code runs on the Mac, which sets `CLAUDECODE`, so it holds
where the Claude Code hooks never ran) it is the pre-push identity guard: a
push over SSH is refused, whatever the host, since it would use this Mac's
SSH keys, the owner's; over HTTPS to GitHub, git is asked for the
credentials it would push with (one in the URL included) and GitHub for
whose they are, and only the agent's push goes ahead; in a Claude cloud
session, GitHub is asked through its proxy whose account the session is. The
owner's pushes from their own terminal are not checked. With `work-rules` on, it then applies the same rules before an
agent session pushes: all the commits
one push brings, on one branch, name one slice between them as a
`Slice: #N` trailer. Commits a remote already has, such as the default
branch's, are not the push's own; a push of only a merge, such as of the
default branch, is judged by the branch's own commits. In an agent session, a push is refused when the CLI is
missing, or, with `work-rules` on, the session has no token. When the repository already has its own
pre-push hook, or git runs hooks from a folder outside the repository (a
global `core.hooksPath`), `onboard` leaves it alone and names the line to add:
`process-rules pre-push "$@"`. The client workflow re-runs the checks when a
pull request's description is edited. After upgrading process-rules, run
`onboard` again: it upgrades the hook entries in `.claude/settings.json` and
the workflow. An older release's workflow, one job that let every run write
to issues, is replaced; a workflow already split into `process-rules` and
`process-rules-weekly` keeps everything but its version pins, which move to the
new release, and the one branch pushes run on, which follows a changed default
branch; any other workflow is offered a replacement. Make the checks of the
features a client has turned on required on its default branch, such as
`process-rules / PR identity` with `pr-identity` and `process-rules / Work
rules` with `work-rules`; a check of a feature that is off still runs and
passes, but with identity alone there is no workflow at all, so require none.

### One feature at a time

A client can turn features on one at a time. `identity` is always on: the
settings, the session-start hook, the agent's access and its Verified commit.
The others are `pr-identity`, `board`, `work-rules`, `design`, `decisions` and
`review`. The settings list the ones a client has turned on:

```json
{ "owner": "example-owner", "agent": "ExampleBot", "features": ["identity"], "project": "Example work" }
```

`process-rules onboard <owner> <agent> --features identity` sets up identity
alone; later, `process-rules onboard --add board` turns one more on and sets
it up. Settings with no `features` key keep every feature on, as before;
`"features": []` means identity alone. The shared checks,
the weekly job, `reviews-due` and the pre-push hook each pass, saying so, when
their feature is off; `onboard` writes the workflow only once a check needs it. `project` names the board's
Project (by default `<repo> work`).

### Claude cloud sessions

A Claude cloud session has no keychain and no session file: it reaches
GitHub through Claude's GitHub proxy, as the account connected to claude.ai.
So for agent sessions there, that connection is the agent account. Its
`session-start` asks GitHub, through the proxy, which account the session
is. When it is the agent, it writes the pre-push git hook (a fresh clone
has none), lifts the lock and records the session for the guard; `gh` gets
the proxy's placeholder token (`proxy-injected`), which the proxy swaps for
the connected account's. As anyone else, GitHub stays locked out and the
session is told to stop. The pre-push hook asks GitHub the same through
the proxy before each push.

The proxy refuses GitHub's GraphQL API, so the work rules read only its
REST API, here and everywhere else. The cloud environment's Setup script,
which runs as root before each session, installs the CLI:
`process-rules cloud-setup` prints one for the installed release. It
unpacks Node, once it matches the sha256 the release pins, and the CLI
under `/opt/process-rules` and puts
`process-rules` on `PATH`, leaving the image's own Node alone. The
environment needs the network to reach nodejs.org and GitHub's release
downloads.

claude.ai has one GitHub connection per account, so it is the agent's for
every cloud session that account starts.

### Releases and upgrading

Each release is a tag `vX.Y.Z` on `main`, matching `package.json`; the
Release workflow checks both, runs `pnpm check` and publishes the GitHub
release, attaching the CLI package it built and tested. Install that package on
each machine with pnpm; nothing is built on install:

```bash
pnpm add -g https://github.com/athya-hq/process-rules/releases/download/v0.5.4/athya-hq-process-rules-0.5.4.tgz
```

`onboard` pins the client's workflow to one version, the release of the CLI
that ran it. Each job writes the pin twice, `checks.yml@vX.Y.Z` and, two lines
below it under `with:`, `process-rules-ref: vX.Y.Z`, because a called
workflow cannot read its own ref from GitHub's contexts. Upgrading is one
step: install the new CLI and run `onboard` again, which moves all four pins
together. Editing the version by hand means changing all four lines, two per
job. A split workflow needs v0.5.4 or later: GitHub refuses a whole run, before
any job's `if:`, when the called workflow asks for more than the calling job
grants, and before v0.5.4 `checks.yml` asked for `issues: write` itself. The hooks run the
launcher `machine` writes, else `process-rules` from the `PATH`; without
either the session-start hook tells the session to stop, and the guard refuses
`gh` and `git`. Run `machine` again after removing the node it names.

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
