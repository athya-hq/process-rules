# niyam

niyam (नियम, rule) was named process-rules until 0.6.3. Its repository moved
from athya-hq/process-rules to veda-hq/niyam, and GitHub forwards the old
address. The old names still work for at least one release: see
[Renamed from process-rules](#renamed-from-process-rules).

Work rules for a repository that tracks its work in GitHub Issues and a GitHub
Project, with an owner account that approves and an agent account that builds.

Any repository can adopt it. No server, database or dashboard: a CLI, git
hooks and a shared GitHub Actions workflow.

## Status

Early. The CLI runs `machine`, `doctor`, `session-start`, `guard`, `onboard`, `propose`, `upgrade` and `owner-step`. What comes next, and in what
order: the Slice issues under
[niyam roadmap v1](https://github.com/athya-hq/process-rules/issues/22),
on the Project [process-rules work](https://github.com/orgs/athya-hq/projects/2);
[docs/roadmap.md](docs/roadmap.md) keeps version v1 as approved. Decisions:
[docs/decisions.md](docs/decisions.md).

GitHub means github.com: it is the only supported host. GitHub Enterprise
Server and GitHub Enterprise Cloud with data residency (GHE.com) are not
supported yet; every GitHub address in the CLI comes from one host constant,
so a host setting can be added later.

Claude Code is the only supported agent runner. The agent identity and the
GitHub lock reach a session through Claude Code's SessionStart hook and
`CLAUDE_ENV_FILE`, so an agent run from another tool (Codex, Cursor,
Copilot's agent, Aider, a plain script) gets neither, and only the pull
request's PR identity check catches its work, after the push. Other runners
wait for adoption outside Athya (#50).

## Agent identity on a Mac

macOS is the supported platform: the agent's token lives in the macOS
keychain. On any other platform `machine` and `doctor` refuse, and
`session-start` keeps GitHub locked out of the session; Claude cloud sessions
need no keychain and work as before, and `doctor` runs its cloud checks there
(see Claude cloud sessions below). The token is read and stored through
one token-store interface (`src/token-store.ts`), so a Linux or Windows store
can be added there when an adopter needs one.

The adopting repo names its accounts in `.github/niyam.json` (in a repo
onboarded before niyam, `.github/process-rules.json`, which is still read):

```json
{ "owner": "example-owner", "agent": "ExampleBot" }
```

Each of `"owner"` and `"agent"` is a login or a non-empty list of logins,
such as `"owner": ["example-owner", "second-owner"]`; no account may be both.
Every check accepts anyone in a list: an approval, a 👍 or a `Decision:`
comment from any owner counts, and proposals, commits, pushes and pull
requests from any agent count as agent work. A Mac's agent sessions work as
one agent: the only one listed, or else the one listed that `machine` set up
on that Mac; with none of them set up there, or more than one, session-start
keeps GitHub locked out rather than guess. Messages that send someone to fix
a setup name the first owner. `onboard` writes the one-login form, and on a
repo whose settings list several it works as the owner named, else the
one the run's browser sign-in is, which must be listed, and the agent named,
else the one set up on the Mac; it leaves the lists as they are.

`niyam machine ExampleBot`, run once per Mac and agent account (inside
an adopting repo the name can be left out), needs no client repo. It makes the
agent's signing key (`~/.ssh/<agent, lowercased>_signing`), opens GitHub's
classic-token page with the scopes filled in (`repo`, `workflow`, `read:org`,
`project`, `write:ssh_signing_key`) and reads the token through a hidden prompt
into the keychain (service `niyam`), refusing a fine-grained token,
missing scopes or no expiry. It then registers the key as the agent's signing key, writes
`~/.config/niyam/<agent, lowercased>/session.sh`, and writes the
launcher `~/.config/niyam/bin/niyam`, which the Claude Code
hooks and the pre-push git hook run. Releases before P-55 wrote both under
`~/.config/process-rules/`, which `machine` leaves in place and every reader
still takes where the new folder has none (see Renamed from process-rules). The
launcher names the node that ran `machine` by its real path (not a version
manager's per-shell one, which the Claude app's hooks may not have), so the
hooks need no node on their `PATH`. Why a classic token: [docs/decisions.md](docs/decisions.md).

`machine` first works out what it would change, changing nothing, and shows
one plan, in the same layout as `onboard`, listing only what changes. Then it
asks once:

```
◆  niyam machine   AGENT
│
◇  This Mac
│    signing key   ~/.ssh/agent_signing (new)
│    token         classic, in the keychain (new)
│    session file  new
│    launcher      ~/.config/niyam/bin/niyam
│
◇  GitHub — as AGENT
│    signing key  register
│
◆  Go ahead?   ● Yes  ○ No
```

No changes nothing. `--yes` goes ahead without asking, and `--dry-run` shows
the plan and stops. When nothing would change, it asks nothing and says
`◇  This Mac is set up for AGENT`, with or without a terminal. Otherwise,
with no terminal it refuses in one line unless given `--yes` or `--dry-run`.
A stored token GitHub refuses, or one that ends within 14 days, shows in the
plan as replaced. After the yes, each step shows as one `◇` line, or `■`
with why when it fails. The token's step opens GitHub's page, says in a few
short lines what to do there, and asks for the paste, hidden. A failed key,
token or key registration stops the run there, and nothing after it changes.
A failed lockout step stops nothing and goes under "Worth fixing". A run
that finishes ends with that group of `▲` lines, each with its one-line fix,
and `└  AGENT is ready on this Mac`. The SessionStart hook sources the
session file, so nothing is left to do by hand.

The trade-off, for adopters: the agent account holds one classic token, and
its `repo` scope reaches every repository the agent account can access, not
only the adopting one. Invite a dedicated agent account to the repositories
it works in and nothing else; the expiry bounds the rest. It is classic for
now because a fine-grained token waits on an organisation owner's approval
wherever the organisation requires it, reaches no repository where the agent
is only an outside collaborator, takes one token per organisation, and
cannot register the agent's signing key when an organisation owns it. An organisation or
enterprise that blocks classic tokens cannot adopt niyam yet:
`onboard` names the block and that an organisation owner can allow classic
tokens under Settings → Personal access tokens. A fine-grained token or a
GitHub App waits for adoption outside Athya.

A client's `.claude/settings.json` locks GitHub out of every session before
any hook runs: its `env` holds the lock's variables (a `GH_TOKEN` GitHub
refuses, no credential helper, GitHub's SSH remotes on HTTPS and every other
SSH remote refused), so a session whose hook never ran or failed reaches
GitHub as nobody, never as the owner. In a Claude cloud session the
SessionStart hook lifts it only once GitHub says the session is the agent
(see Claude cloud sessions below).

In Claude Code, the client's SessionStart hook runs `niyam
session-start`. It appends a lock to `CLAUDE_ENV_FILE`: a token GitHub refuses,
no credential helper, nothing inherited that could bring one back (`git -c`
injection, `GIT_CONFIG`, askpass), GitHub's SSH remotes on HTTPS and every
other SSH remote refused. Then, when this Mac has the session file `machine`
wrote for the agent the repo's settings name, exactly as `machine` writes it,
it appends that file, which replaces the lock with the agent's identity. Any
other outcome leaves GitHub locked out and says why, so a session never falls
back to the owner's login. When the CLI is missing or fails, the hook still
tells the session to stop, with what the CLI printed.

The line that tells a local session it works as the agent also tells it to
turn Auto-fix on for each pull request it opens. The Claude desktop app's
Auto-fix wakes a session on CI failures, merge conflicts and review comments,
and the app turns it on for a new pull request by itself only while that
session is open on screen, so a session started in the background (as a
coordinator starts its slice sessions) opens its pull request with Auto-fix
off. So after `gh pr create`, when the app's `ccd_pr` tools are there and
`get_status` shows `auto_fix` off, the session turns it on with
`set_monitor`. The app checks that the session opened the pull request and
that its `gh` login wrote it, which holds for the agent's own pull requests.
In auto mode the classifier refuses those calls unless the repo's
`.claude/settings.json` allows them, so `onboard` adds `mcp__ccd_pr__bind_pr`,
`mcp__ccd_pr__get_status` and `mcp__ccd_pr__set_monitor` to its
`permissions.allow`, and `doctor` warns under "This repo" (`▲`) about each
one an onboarded repo's file lacks. They reach the app only, not GitHub.

Before each Bash command, the client's PreToolUse hook runs `niyam
guard`: a command running `gh` or a git command that reaches a remote (push,
fetch, pull, clone, ls-remote, submodule, and `remote` update, prune, show (not `-n`),
`add -f`/`--fetch` (unless a later `--no-fetch`) and `set-head -a`/`--auto`;
not `remote get-url` and the other local `remote` subcommands) is refused,
with the reason,
unless session-start gave this session the agent identity. Hooks cannot see
the variables session-start gives the session's shells, so session-start
records how it left each session in
`~/.config/niyam/sessions/<session id>.json` and the guard reads that (for a
session started before P-55, the record in `~/.config/process-rules/sessions/`
where the new folder has none).
A command not naming `gh` or `git` as a word goes ahead without starting the CLI;
when the CLI cannot run, every command naming either is refused.

The guard also reads each comment an agent session posts or edits through
`gh`: `gh issue comment`, `gh pr comment`, and `gh api` on a comments
endpoint or in a GraphQL comment mutation, its body inline, in a heredoc, in
`$(cat file)`, or from `--body-file`, `-F body=@file` or `--input`. A
comment that asks the owner (it opens with `Needs you:` or `Proposal:`, past
any Markdown emphasis, or names an owner login, with or without `@`) must
link a published page (`https://claude.ai/artifact/…` or
`https://claude.ai/code/artifact/…`) and fit 500 characters; otherwise it is
refused, naming the rule and the fix: publish the page, then post the
question, the link and how to answer. A body the guard cannot read in full
(a variable, a command substitution other than `cat`) is judged by what it
spells out; where that asks the owner, or the body opens with the unknown
part, it is refused with how to write it so the guard can read it; so is a comment with no body in the command, which gh would take from an editor, a prompt or the browser. Commands inside `$(…)`, backquotes and `sh -c` are read too. `propose`
posts through GitHub's API, not through `gh`, so this check does not see
it; `propose` holds its own comments to the same rule before posting them.

The session file holds no secret: `GH_TOKEN` is read from the keychain on each
use, and is a value GitHub refuses when the keychain has none. Git gets a
credential helper that drops every earlier one and hands the agent's token to
github.com only, commits as the agent's no-reply address and signs with its
key.

The lock lives in the session's environment, which a session that ignores it
could change. So `machine` also locks the owner away, as optional hardening
for a machine that runs agents. Its plan lists signing `gh` out of every
account other than the agent's, active or not, and removing a git password
for github.com saved in the macOS keychain. The one yes covers them, and a no
leaves them in place with everything else. On a laptop you also use for your
own work, saying yes signs you out of your own GitHub tooling. The stronger
alternative is a separate macOS user that runs only the agent sessions: none
of your logins, keychain or SSH keys are in it, and nothing of yours is signed
out. A sign-out that fails stops nothing; it goes under "Worth fixing". So
does each SSH key in `~/.ssh` with no passphrase, with
`ssh-keygen -p -f <key>` to add one; agents' signing keys are left out,
since sessions sign with them and they have no passphrase on purpose. The owner's SSH access is left alone,
since it is the owner's own way to GitHub (docs/decisions.md). Agent sessions
send GitHub over HTTPS and refuse SSH, and the pre-push hook refuses their
pushes over SSH. `doctor` names the account SSH reaches GitHub as without
asking (a key in the SSH agent or the keychain), as fine.

Releases before 0.5.21 asked about each lockout step on its own, and recorded
what was declined in
`~/.config/process-rules/<agent, lowercased>/lockout-declined.json`, which is
still read (`~/.config/niyam/…` first).
`doctor` reports a login or password in that record as your choice instead of
warning, and an account signed in later is still a warning. Once a `machine`
run locks them away, the record goes.

When `machine` signs an account out of `gh`, "Worth fixing" ends with two
steps only you can take. Restart the Claude desktop app: it keeps the `gh`
token it read before the move until it restarts, so until then its own
GitHub actions (Auto-fix, the PR bar) run as you, and Auto-fix refuses the
agent's pull requests. And revoke the old token on GitHub (Settings →
Applications → Authorized OAuth Apps → GitHub CLI): `gh auth logout` deletes
it from the Mac but does not revoke it. `machine` records the move in
`~/.config/niyam/<agent, lowercased>/gh-moved.json` (before P-55, under
`~/.config/process-rules/`, still read), and `doctor`
repeats both steps while the desktop app was started before it. `doctor`
cannot see whether the token was revoked, so once the app has restarted it
no longer reminds you to revoke it.

The owner is never signed in to `gh`, and needs no sign-in kept anywhere on
the Mac. When a run of `onboard` (or `onboard --add`) reaches a step that
acts as the owner (giving the agent access, setting up the board, or
setting the `FIGMA_LIBRARY` secret from an older setting), it
asks for one browser approval, which serves the rest of that run; a run
with no such step asks for none. That approval comes after the plan's yes,
unless only it can tell what the plan is: which of several owners the
settings list ran it, or, on a first run with no owner named, whom to
suggest; the pull request then says so. It runs `gh auth login --web` into a
fresh temporary `gh` folder, asking for gh's own scopes (`repo`,
`read:org`, `gist`) plus only those the run's features add (`project` for
the board, and `admin:org` in an organisation), reads the token from
there, refuses it unless it is the owner's, and deletes the folder
whatever happens. Its line names the account to sign in as (each owner the
settings list, while the run has not chosen one). `onboard` reads `gh`'s
output rather than showing it: it shows the one-time code and opens the
link in the browser, drops `gh`'s tips and its notes about setting up that
temporary folder, and shows any other line, an error included, as `gh`
wrote it. The
token lives in the command's memory for that run; the owner's own `gh`
config and keychain are never read or written, so there is nothing to sign
out of afterwards.

A request to GitHub or Figma that gets no answer at all stops the command
with which request it was and why, such as `GET
api.github.com/repos/…/actions/secrets/public-key could not be made:
ECONNRESET (other side closed)`, never its query or token. A GET, PUT or
DELETE, which can be repeated safely, is tried once more a second later
first; a POST or PATCH never is. A call with a time limit keeps it for
both tries, and one that runs out of time stops with that, not tried
again.

`niyam doctor` only reads. It re-checks the key, the token and its
scopes, the key's registration, the session file, that the launcher runs,
that the CLI is the newest release (`▲` when a newer one is out, fixed by
`niyam upgrade`) and the only `niyam` on `PATH` (`✗`
otherwise, naming each copy and its version), and
what of the owner's an agent session could reach, any `owner-step` folder
left behind (`▲`, saying whether it still holds a token; see Owner steps), and, in a repository with
the board on, the organisation's issue types (see Issue types). It shows them grouped as
This Mac, GitHub and This repo, one line each: `✓` fine, `▲` worth fixing,
`✗` broken. Each problem line ends with its fix:

```
◆  niyam doctor   AGENT
│
◇  This Mac
✓  signing key ~/.ssh/agent_signing
✓  session file
✗  launcher missing, so hooks need node on PATH → niyam machine
▲  niyam 0.5.20 runs here; 0.5.30 is out → niyam upgrade
│
◇  GitHub — as AGENT
▲  token ends in 11 days → niyam machine
✓  signing key registered
│
└  3 to fix
```

It closes with `└  All good` or `└  N to fix`, and exits 1 when anything is
`✗`. A token that ends within 14 days is `▲`, and still exits 0. It needs no
terminal. In a Claude cloud session it runs the cloud checks instead (see
Claude cloud sessions below).

## Adopting

1. On each Mac that runs agent sessions: `niyam machine <agent>`.
   Only you can run it: it asks for the agent's token and makes its signing
   key. `onboard` refuses on a Mac it has not set up, naming what is missing.
2. In the client repository, as its owner: `niyam onboard`. It
   suggests the owner from the run's browser sign-in (below) and the agent from the accounts
   `machine` set up on this Mac, for you to confirm (or name them:
   `niyam onboard <owner> <agent>`). It first works out everything
   it would change, changing nothing, and prints that as one plan, then asks
   once:

   ```
   ◆  niyam onboard   v0.5.17 → v0.5.20
   │  owner/repo · owner OWNER · agent AGENT
   │
   ◇  Pull request
   │    workflow        pins → v0.5.20
   │    cloud-setup.sh  new, installs v0.5.20
   │    auto-merge      when checks pass
   │
   ◇  GitHub — one sign-in as OWNER
   │    board             set up or check
   │    issue types       org-wide: retype 1, disable 3
   │      example-app#12  Task → Brief
   │      disable         Task, Bug, Feature
   │
   ◇  This Mac
   │    pre-push hook  new
   │
   ◇  Claude cloud — by hand, once
   │    Setup script        niyam cloud-setup, first
   │    claude.ai's GitHub  as AGENT
   │
   ◇  Check
   │    one signed test commit by AGENT, deleted after
   │
   ◆  Go ahead?   ● Yes  ○ No
   ```

   It shows only what changes, in a few words each; the pull request's
   description holds each change in full. No changes nothing and opens no
   pull request. `--yes` goes ahead without asking, and `--dry-run` prints
   the plan and stops, changing nothing and signing in to nothing, so where
   only a sign-in could tell which of the settings' owners runs it, a dry
   run asks you to name the owner. Without a terminal, `onboard` refuses
   unless given `--yes` or `--dry-run`. After the yes it shows one line per step, a
   spinner while it works, and ends with the pull request and a short "By
   hand:" list of what GitHub's API cannot do.

   It writes `.github/niyam.json` (in a repo onboarded before P-56 it moves
   `.github/process-rules.json` there, byte for byte but for the changes it
   makes, and deletes the old one), adds to `.claude/settings.json`
   the lock in `env`, a SessionStart hook running `niyam session-start`, a
   PreToolUse hook running `niyam guard` (each through the launcher `machine`
   writes, else `niyam` on PATH; since P-53, hooks an older release wrote,
   which name `process-rules`, are replaced), and `permissions.allow` rules
   for `niyam review-thread` (replacing the rule under the old command) and for
   the app's `mcp__ccd_pr__bind_pr`, `mcp__ccd_pr__get_status` and
   `mcp__ccd_pr__set_monitor`, which turn Auto-fix on (a rerun adds only
   the ones missing), and
   writes `.github/workflows/niyam.yml`, which calls this repository's
   shared checks (`.github/workflows/checks.yml`) from two jobs: `niyam`
   on pull requests and pushes, read-only, and `niyam-weekly` on the
   weekly run, the only one that writes to issues. Each job carries a
   `name:` (`niyam`, `niyam-weekly`, …), so its checks read
   `niyam / Work rules`. A workflow an older release wrote as
   `.github/workflows/process-rules.yml`, with the job ids `process-rules`,
   `process-rules-weekly`, … and the input `process-rules-ref`, moves to the
   new name with niyam's ids and `niyam-ref`, keeping the client's own
   edits, and the old file is deleted in the same pull request; the check
   names stay, so no ruleset changes (P-56). With identity alone `onboard`
   writes no workflow, and leaves an old one as it is, saying so in the plan. It writes
   `.github/niyam/cloud-setup.sh`, which installs the CLI in Claude
   cloud sessions at the version the workflow pins, and the same file as
   `.github/process-rules/cloud-setup.sh`, which a Setup script pasted
   before P-56 runs, and writes both again on
   every run (see Claude cloud sessions below); the first time, the plan
   lists the one paste into the cloud environment's Setup script, and in a
   repo that had only the old file, one paste of the new snippet. It checks the agent can
   push. With no access, or read access only (a public repo, or an
   organisation's base permission), the plan gives it write access as you
   and accepts the invitation as the agent; and `onboard` names
   an organisation that
   requires SAML authorisation or blocks classic tokens. As the owner (with
   the `project` scope, and `admin:org` in an organisation), it sets up the
   work board: the organisation's issue types
   (Work item, Slice, State, Decision, Brief; see Issue types below), the repo's labels (`approved`,
   `needs-owner`, `mechanical`, `veto`, `expiring`, `cannot-run-here`), and a
   Project "<repo> work" linked to the repo. It makes that Project by copying
   the product's public [niyam template](https://github.com/orgs/athya-hq/projects/4),
   which holds the fields Step (Frame, Specify, Slice, Build, Done), Decision
   and Review date and the views Needs
   you (`label:needs-owner is:open`), Board (`type:Slice,Brief`, by Status,
   showing linked pull requests), Work items (`type:"Work item"`, grouped by Step), Decisions
   (`type:Decision`, grouped by Decision) and Reviews due (`"Review
   date":<=@today`), with its workflows; so the board needs nothing done by
   hand. What the board lacks is known only once you have signed in, so the
   plan says "set up or check"; issue types are an organisation-wide
   setting, so the plan says "org-wide" and lists what it would change. If
   a copy's workflows arrive off, "By hand:" links where to turn them on. A
   Project of that title made before the template is left as it is: the plan's
   yes does not replace it. When GitHub refuses the copy, or for such an
   older Project, `onboard` adds the fields and makes or updates the views
   itself, and "By hand:" links the Project for the three things GitHub's API
   cannot set: the Type column on Needs you (`+` at the right of the
   headers → Type, then Save), the grouping, and the auto-archive workflow.
   GitHub's API cannot even see a Type column, so `onboard` sends a view's
   columns only when they differ from what it asks for: a rerun keeps Type.
   When it does set Needs you's columns, it says Type may be gone and how to
   add it again. On any Project it
   adds an option a field lacks, such as Step's Done on one made before it,
   sending each option it keeps with its id, so no item loses its value. The Board keeps a
   closed slice or brief in Done until that workflow archives it, with the
   filter `is:closed updated:<@today-7d`: a week. A view's filter cannot do
   this, since GitHub's Project filters join different fields with AND alone
   and have no closed date, and GitHub's API can neither read nor set a
   workflow's filter. Last, it pushes
   one signed test commit as the agent to a throwaway branch, checks GitHub
   shows it Verified by the agent (asking again when the network or GitHub
   fails for a moment), and deletes the branch. The steps that act as you
   (giving the agent access, the board, the `FIGMA_LIBRARY` secret) share one browser approval, for
   that run only. The files git tracks in your checkout are never changed: once every step has run,
   `onboard` commits the files it changes as the agent, signed, on the
   branch `niyam/onboard` (`process-rules/onboard` before P-56) from the default branch's tip, in a
   temporary repository it deletes afterwards, pushes it as the agent and
   opens the agent's pull request (or updates the one an earlier run opened),
   titled `chore(niyam): onboard at v<version>`, as Conventional
   Commits reads it, and its commit the same. Where most of the default
   branch's latest 20 commit subjects, merge commits aside, lead with an
   emoji or a gitmoji shortcode, so does the title: the one an earlier
   onboard commit had, else the one the repo puts most on chores, else `🔧`
   (`:wrench:` where shortcodes are the style). Where the default branch's
   Mergify configuration (the first of `.mergify.yml`, `.mergify/config.yml`
   and `.github/mergify.yml`) has a queue rule and queues pull requests by
   itself, through a rule whose actions hold `queue` and whose conditions
   ask for no label, or merge protections' `auto_merge_conditions` set to
   `true` or to conditions that ask for no label, the merge queue merges the pull
   request, and the run ends "<url> the merge queue merges it when checks
   pass". Otherwise it turns on GitHub's
   auto-merge for that pull request as the agent, squashing where the repo
   allows it (else rebasing, else merging), so it merges itself once its
   checks pass, and any review the repo's rules require is given. Where the
   repo does not allow auto-merge, or GitHub refuses it (as it does for a
   pull request already clean to merge), the run still succeeds: it ends
   "Merge <url>", and "By hand:" says why. A run
   that changes no file, or that stops, opens none. A file the default branch has otherwise than your
   checkout is refused, so bring the checkout up to date first. The pre-push
   git hook, which git does not track, is written in place. The work rules
   pass that pull request without a `Slice:` line while it changes only the
   files `onboard` writes. `onboard` leaves the repo's CODEOWNERS as it is:
   when a rule there names you, GitHub asks you to review the agent's pull
   requests that change the files it matches, and the repo's own rules
   decide whether that review is required. An existing `.claude/settings.json`
   keeps its layout: `onboard` adds only its entries, and replaces the hook
   entries an older release wrote where they stand. The repository needs at
   least one commit. The pull request checks read the settings from the base
   branch, so a pull request cannot rename the agent it is checked against.
   The pull request that first commits them, `onboard`'s, passes PR identity, Work rules
   and Design frames, saying the repo is not adopted on its base yet, as for
   a feature that is off; they apply from the next pull request.

The shared checks run five jobs. **Settings** validates
`.github/niyam.json`, else `.github/process-rules.json`, and fails when a job's `niyam-ref`
(or `process-rules-ref`, which a workflow onboard has not moved still passes)
names another release than the `checks.yml@` line it calls (see Releases and
upgrading). **PR identity** runs on pull requests: every
commit that claims the agent (its login or its no-reply address) must be
Verified as the agent, and agent commits must be pushed by the agent, so agent
work pushed with the owner's login fails. Who pushed comes only from GitHub's
record of the pushes to the pull request's branch (the fork's, for a fork),
never from whoever started the run, so an edit, a reopen or a re-run by anyone
gives the result the push gave. A push GitHub has not recorded yet is waited
for about a minute, then fails until a re-run finds it. A merge queue's test runs
pass with nothing to check, since each queued pull request was checked on its own:
a `merge_group` run, and a pull request `mergify[bot]` opened from a
`mergify/merge-queue/` branch of the repository itself (anyone else's pull request
on such a branch is checked). **Work rules** runs on the agent's
pull requests: each names exactly one slice, as a line `Slice: #N`, and that
slice may be built:

- it is a Slice issue under a Work item the owner labeled `approved`;
- if it was added to the work item after the approval, the owner approved
  it: a 👍 on the agent's proposal for it, made after it was added, a
  comment starting `Decision:` naming it, or the owner's own request: a
  comment they wrote on the work item before the slice was last added,
  which the slice's body links (`…/issues/<work item>#issuecomment-<id>`)
  and they have not edited since. Which comment asked for the slice is the
  agent's claim, shown in the slice's body: the comment came first, so it
  cannot name the slice;
- each of its State sub-issues closed as not planned after the approval
  carries the owner's approval: a 👍 on the agent's proposal for it, or a
  `Decision:` comment;
- no other open pull request names it;
- each State it names with a line `State: #N` is a State sub-issue of the
  slice, and when the slice is closed already, so the pull request is a fix,
  it names at least one open State: the one the fix is filed as.

**One comment answers a batch.** Settings that name the repository's standing
Approvals issue (`"approvals": N`) let the owner answer many asks at once:
an owner's comment there whose first line opens `Decision: approve`, then
`#N` for each issue it approves (`Decision: approve #31 #12 #40`). Only that
line approves; the lines under it are reasons, so `Not #44 yet` approves
nothing. The work rules take it for a slice added after the approval when it
names the slice and was made after the slice was last added, and for a
dropped State when it names the State and was made after the State was
closed. They read the Approvals issue's comments once a check, only when a
decision is owed. If GitHub cannot find the Approvals issue, it answers
nothing and the check goes on.

A `Decision:` comment, a batch answer included, counts only while it says
what owners wrote: unedited, or edited by owners alone. Repo writers, agents included, can edit anyone's
comment, and only GitHub's GraphQL API (`userContentEdits`) names who made
each edit, so the work rules read it for an owner's edited `Decision:` alone;
an unedited one is read through REST, as before. Where GraphQL is refused, as
in a Claude cloud session, an edited `Decision:` does not count, and the
refusal says why.

**The board follows the work.** When an agent session's push names a slice
the work rules let it build, pre-push moves the board on, as the agent, on
every open Project of the repository's owner that holds the issues: the
slice's Status to In Progress; its work item's Step to Build, since its first
slice has started; and every other Work item of the repository to the Step
GitHub's facts give it. A closed work item is at Done; an open one is at
least Frame, where a new one starts, at least Slice once it has sub-issues,
and at least Build once one of them is closed. Nothing on GitHub marks
Specify, so the owner sets it by hand and it stays. A Step moves only
forward, except that a reopened work item leaves Done, and an option the
owner added to Step is left alone. So once Step has Done, the Work items
view groups no closed work item under Frame, Specify, Slice or Build, and
none under "No Step", but for one the owner put at an option of their own. The items it reads
hold their issues, so this reads no issue on its own. A Project whose Step
has no Done, made before it, gets one line saying so, and `onboard` adds the
option, keeping every item's Step. A workflow's `GITHUB_TOKEN` cannot write to a Project, so the
agent's push does this, with the agent token's `project` scope, with `board`
on. It uses GitHub's REST API for Projects alone, so it works through a
Claude cloud session's GitHub proxy, which refuses GraphQL.
A board it cannot read, or a move GitHub refuses, is said and does not stop
the push; a push for a closed slice, such as a fix, moves nothing. When a pull request naming a slice merges into the default branch,
the shared workflow comments on the slice, linking the pull request, and
closes it, and the Project's Item closed workflow moves it to Done: a
`Slice: #N` line is not one of GitHub's closing keywords, so GitHub does not
close it. Each State under that slice the pull request names with a line
`State: #N` gets the same comment and is closed as completed too; a State
named only in prose stays open, a State closed as not planned is left as it
is, and so is one under a slice the pull request does not name. A slice or
State GitHub closed already, through a closing keyword such as "Closes #N"
beside it, still gets the comment; one that has it gets no second one. That job alone of a pull request's runs writes to issues. It runs only for
pull requests from the repository itself: a fork's run gets a read-only token, so
a slice a fork's pull request builds is closed by hand.

**What needs the owner.** A request the owner made on the work item is its
own approval, linked as above. A fix needs none: it restores what the owner
approved and changes nothing they would see beyond it, so it is filed as a
State under the slice it fixes and its pull request names that slice, with
`Slice: #N`, and the State, with `State: #N`, which closes the State on merge. The
State needs no approval, though that slice's own approval rules still apply,
as for any pull request naming it. A request made in chat is filed as a slice quoting the
owner's words and proposed once. Anything else the agent adds, a fix filed
as its own slice included, waits for the owner's 👍.

**Approving with one tap.** In an agent session, `niyam propose
<issue> --page <url>` asks the owner for what a slice owes: given the slice, it comments
on it as the agent, one `Proposal:` comment for its addition after the
approval and one for each State dropped after it (given a State, for that
state alone), mentioning the owner, and labels the slice `needs-owner`, so it
shows in the owner's Needs you view and their GitHub notifications. Each
proposal is a pointer, as every ask to the owner is: one line naming what it
proposes, `Page: <url>` and how to answer, in at most 500 characters. The
page, which the agent publishes first and names with `--page <url>` (one page
for the whole run), argues it: what changes and why, from the slice's
`**You will see:**` and `**Why:**` sections (a dropped State's own
`**Why:**`), what it costs and what happens if the owner declines. Without
`--page`, a proposal still to be posted is refused, posting nothing, with
the command to run; a `--page` that is no published page is refused before
GitHub is asked anything. It also refuses, posting nothing, while a
body lacks those sections, naming them, and when a comment would break the
guard's rule (a title so long the comment runs over 500 characters). The owner
approves a proposal by reacting 👍 to it, from the phone or the web; a typed
`Decision:` comment still works. A 👍 counts only from the owner, only on the
agent's comment starting `Proposal:` whose first `#N` is the slice or state
it approves, and only when made after the proposal's last edit (and, for a
slice, after it was last added). Run again, `propose` posts nothing twice, and
once the owner has approved everything it takes `needs-owner` off. Each run
prints, for each decision still waiting, the link GitHub gives its newest
proposal, posted now or before: the comment's own `#issuecomment-` address,
where the owner reacts, never the slice's top or the `needs-owner` list. A
waiting decision with no proposal yet gets the command that posts one,
`niyam propose <issue> --page <page url>` with its number. A
reaction does not re-run a pull request's checks: the agent proposes before
it starts, and pre-push or a re-run of Work rules sees the 👍.

**Many at once.** `propose` takes several issues, `niyam propose 12
30 41 --page <url>`, and asks for each in turn, each comment linking that page. Where the settings name an Approvals issue
(`"approvals": N`), each proposal also says it can be answered in the batch
on Approvals, and the run ends with that issue's link and the first line of
the owner's answer there, ready to paste: `Decision: approve #12 #30 #41`,
one number per proposal still waiting (a slice for its addition, a State for
its drop). The owner pastes it as a comment on Approvals, deleting any number
they refuse. The agent hands the line over and never posts it: only the
owner's own comment approves anything. The Needs you job reads each
proposal by its own number, so a slice whose only waiting proposal is a
State's leaves Needs you as soon as the batch names the State.

**The Needs you list keeps itself.** With `board` on, the client workflow's
`niyam-asks` job runs `niyam needs-owner`. An agent's comment
opening with `Needs you:` or `Proposal:`, on an issue, a pull request or a review thread, labels its issue or pull request
`needs-owner`, so it shows in the owner's Needs you view. On an issue, the
owner's `approved` label or `Decision:` comment takes the label off at once;
on a pull request, where a label approves nothing (approvals are given on
issues only), the owner answers with a `Decision:` comment, which takes it
off at once, or a 👍 on the ask, which the hourly sweep counts. The sweep
reads an issue's or pull request's own comments, not review threads, so an
ask in a review thread is answered with a `Decision:` reply there. Hourly
(cron `41 * * * *`), on a run by hand, and at once when the owner posts a
batch answer on the Approvals issue, a sweep takes it off each open issue
whose every agent ask the owner has answered. Each `Proposal:` is an ask of
its own, for the issue its first line names first (a slice for its addition,
a State for its drop; the issue itself when it names none); a `Needs you:` is
one when it is the latest agent ask there. An ask is answered by a 👍 on it
after its last edit, a `Decision:` comment after it on the issue, or a batch
answer after it on the Approvals issue whose first line names its issue,
that no one but owners edited. So a batch naming one proposal on a slice
leaves the slice on Needs you while another there waits. A proposal for the
slice's own addition counts only answers after the slice was last added to
its work item, so a slice taken out and added again waits on the owner
again. The sweep reads that from the slice's own timeline; unlike the work
rules, it misses an addition GitHub records only on the work item's. An issue labelled
with no agent ask on it, such as the weekly job's undo issues, is left as it
is, unless the owner's batch answer names it. Only comments
that may ask or decide, from the owner, a member or a collaborator, the
`approved` label and the hourly cron start the job, so other comments, and an
outsider's, run nothing.

**Answering review threads.** In an agent session, `niyam
review-thread <thread-id> --reply <text> --resolve` replies on a review
thread (`PRRT_…`), resolves it, or both, as the agent. It refuses unless the
session's token is the agent's and the thread is on a pull request the agent
opened in the repository here. `onboard` allows exactly this command in
`.claude/settings.json` (`Bash(niyam review-thread *)`), so answering
review findings on its own pull requests needs no prompt, even in Claude
Code's auto mode, where an allow rule settles a command without the
classifier. It allows the command, not `gh api`: a rule cannot hold `gh
api`'s arguments to one endpoint, since its `*` matches anything after it. It
uses GitHub's GraphQL API, the only one that resolves a thread, so it does not
work in a Claude cloud session, whose proxy refuses GraphQL.

**Design frames** is the `figma` feature, an optional extension for clients
that design in Figma: with it on and two Actions secrets, `FIGMA_LIBRARY`
(the design library's file key) and `FIGMA_TOKEN`, each State of the slice
an agent pull request builds, other than one closed as not planned, must link
a Figma frame (`figma.com/design/...?node-id=...`) that holds at least one
component published by that library and is not a captured image (an image
covering half the frame or more). Frames are for Experience work: a slice
whose parent Work item names any other kind in a `Kind:` line (`**Kind:** Process.`,
or plain `Kind: Process`) passes without a Figma call; one whose Work item
names no kind, or whose parent is not a Work item, is checked. Without `FIGMA_TOKEN`, or without a
library (from `FIGMA_LIBRARY`, or an older committed key, below), the job says
the check is off and passes. The library key is a secret, not a committed setting,
so a public repository does not publish its design file, and the workflow
`onboard` writes passes the Figma secrets only while `figma` is on. Settings
an older release wrote still work: a `design` feature is read as `figma`, and
a `"figma": { "library": ... }` setting is read when `FIGMA_LIBRARY` is not
set, each with a warning; `onboard` renames the feature, takes the key out
and sets it as the `FIGMA_LIBRARY` secret itself, as you, with the run's one
browser approval: it seals the key with the repository's Actions public key
(a libsodium sealed box, as GitHub requires) and stores it through GitHub's
API, never printing it.

**Decisions, weekly** runs on Mondays at 06:17 UTC (and by hand), or on the
`schedule` the settings set. A Decision issue carries
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
[routines/review.md](routines/review.md). It runs `niyam reviews-due`
for the open decisions whose `Review:` date has come, then for each one either
keeps it (comment `Kept:` with reasoning and a new review date) or settles it
(comment `Settled:` with reasoning, and closes it), labeling both `veto` so
the owner has a week to reverse it. A decision touching secrets, money or
production is held for the owner with a suggestion and `needs-owner`. The
weekly job removes `veto` once the week has passed.

`reviews-due` lists only a decision the owner or the agent wrote and last
edited, so no one else's text reaches the routine. It reads only GitHub's REST
API, which a cloud session's GitHub proxy allows, and REST does not say who
last edited an issue's body, so the weekly job, whose token reads GraphQL,
vets the text for it: on each open decision with a `Review:` date that the
owner or the agent wrote and last edited, it keeps one comment naming the
text's SHA-256, and updates it after their edits. `reviews-due` lists a
decision only while its text has the hash in the workflow's latest such
comment. Any other text is left out, and `reviews-due` says so: a decision
the owner or the agent wrote or edited since the job last ran comes up after
its next run.

The weekly job also watches the routine: an open decision the routine reviews
whose `Review:` date is over a week past, with no `Kept:` or `Settled:` from
the agent since, is labeled `needs-owner` with a comment, so a routine that
was never created, or has stopped, shows up. Only the agent's comments count
as verdicts: anyone can write `Kept:`. `reviews-due` still lists a decision
the job labeled so, until the agent comments on it, and the job takes the
label off once the agent's verdict follows it; a `needs-owner` the routine or
the owner added stays. `onboard`, with `review` on, lists the routine under
"By hand:", and its pull request says how to create it: a weekly Claude routine on the repository (claude.ai/code/routines,
or `/schedule`), with claude.ai's GitHub connected as the agent, and the
prompt from `routines/review.md` at the release in use. It cannot create the
routine itself: Claude's routines API answers only a Claude Code session's own
sign-in, not a command, and a routine works as claude.ai's GitHub connection,
which no API names.

`onboard` also writes a pre-push git hook running `niyam pre-push`,
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
`Slice: #N` trailer. Commits a remote already has are not the push's own,
and neither are the default branch's commits the clone can find: those its
tip as GitHub names it reaches, when the clone has that commit, and those
its remote-tracking ref reaches. Where those are behind, as in a
single-branch clone that merged the default branch from `FETCH_HEAD`, and the
push would be refused, GitHub is asked which commits the push's merges
brought are on the default branch, and those are left out too. So a merge of
the default branch brings none of the slices its commits name. A push whose
own commits name no slice, such as a merge or a commit with no trailer, is
judged by the branch's own commits, those not on the default branch: it
passes when they name exactly one slice. Where the clone cannot find the
default branch at all, a push of only merges is judged by the commits the
merges did not bring, as before. In an agent session, a push is refused when the CLI is
missing, or, with `work-rules` on, the session has no token. When the repository already has its own
pre-push hook, or git runs hooks from a folder outside the repository (a
global `core.hooksPath`), `onboard` leaves it alone and lists the line to add
under "By hand:": `niyam pre-push "$@"`. The client workflow re-runs the checks when a
pull request's description is edited. After upgrading niyam, run
`onboard` again: it upgrades the hook entries in `.claude/settings.json` and
the workflow. An older release's workflow, one job that let every run write
to issues, is replaced; a workflow split into `niyam` and
`niyam-weekly` (`process-rules` and `process-rules-weekly` before P-56, renamed
on the way) alone gets the `niyam-merged` job, which
closes a merged pull request's slice, and runs on closed pull requests; a
workflow with those three jobs alone gets the `niyam-asks` job, with
the comment and label triggers and the hourly cron it runs on, and the weekly
job leaves that cron alone; a 0.5.28 asks job, which any
commenter's ask started, starts on an owner's, member's or collaborator's alone;
a 0.6.3 one, which the approved label alone of the issue events started, starts
on an issue opened or reopened too (see Issue types), unless the client changed
its `issues:` trigger; a
workflow already split into its jobs keeps everything but its version pins, which move to the
new release, the one branch pushes run on, which follows a changed default
branch, and the one cron the weekly job runs on, which follows a changed
`schedule` (a schedule with more crons, or a comment on its cron line, is the
client's own and stays as it is); any other workflow is offered a replacement. Make the checks of the
features a client has turned on required on its default branch, such as
`niyam / PR identity` with `pr-identity` and `niyam / Work rules` with
`work-rules`; a check of a feature that is off still runs and passes, but with
identity alone there is no workflow at all, so require none. Before P-53 these
read `process-rules / …`: where a ruleset still requires the old names,
`onboard` lists `niyam owner-step required-checks <repo> <ruleset>` by hand,
to run while its pull request is open, which then merges; pull requests
opened before it report the old names until they merge the default branch.

### One feature at a time

A client can turn features on one at a time. `identity` is always on: the
settings, the session-start hook, the agent's access and its Verified commit.
The others are `pr-identity`, `board`, `work-rules`, `figma`, `decisions` and
`review`. The settings list the ones a client has turned on:

```json
{ "owner": "example-owner", "agent": "ExampleBot", "features": ["identity"], "project": "Example work" }
```

`niyam onboard <owner> <agent> --features identity` sets up identity
alone; later, `niyam onboard --add board` turns one more on and sets
it up. Settings with no `features` key keep every feature on, as before;
`"features": []` means identity alone. The shared checks,
the weekly job, `reviews-due` and the pre-push hook each pass, saying so, when
their feature is off; `onboard` writes the workflow only once a check needs it. `project` names the board's
Project (by default `<repo> work`). `schedule` sets when the weekly job runs,
as a five-field cron in UTC (by default `"17 6 * * 1"`, Mondays at 06:17);
`onboard` refuses one that is not a cron, or that is `41 * * * *`, the hourly needs-owner sweep's, and writes it into the workflow, so
run `onboard` again after changing it. `approvals` names the repository's
standing Approvals issue, where one owner comment answers a batch of asks
(see the work rules); without it, there are no batch answers on an
Approvals issue.

GitHub has issue types for organisations only, so on a repository a personal
account owns, `work-rules`, `decisions` and `figma` cannot run: the work rules
need a Slice under a Work item, the weekly job and `reviews-due` list
Decision issues, and the design check reads a slice's State sub-issues.
`onboard` refuses to turn them on there, with `--features` or `--add`, saying
why; with no `--features`, it turns on the rest and names the ones it left
off. Should the settings list them anyway, `pr-work-rules`, `pr-design`, the
weekly job, `reviews-due` and the pre-push hook's work rules pass, saying the
feature is off on a personal account's repository and why, rather than
failing every pull request. They ask GitHub whose the repository is once per
run.

### Issue types

The work model has five issue types, Work item, Slice, State, Decision and
Brief, and `onboard` makes the organisation's enabled types exactly these.
Issue types are an organisation-wide setting, so this reaches every
repository in the organisation, onboarded or not, and the plan says
"org-wide". `onboard` adds a work model type the organisation lacks and
enables one it has disabled. Every other type, GitHub's default Task, Bug
and Feature or one of the organisation's own, it disables, after giving each
issue that holds one, open or closed, in any of the organisation's
repositories, a work model type from GitHub's facts about it:

- a sub-issue of a Work item becomes a Slice;
- a sub-issue of a Slice becomes a State, an experience state of that slice;
- an issue with sub-issues becomes a Work item;
- any other becomes a Brief.

Each open issue with no type at all, in any of the organisation's
repositories, gets one by the same rule, under the same yes. A repository's
Approvals issue, the one its settings (`.github/niyam.json`, or
`.github/process-rules.json`, on its default branch) name as `"approvals":
N`, is left with no type, and the plan says so: it is a standing record the
owner answers batches on, never closed, which none of the five fits, and the
work rules find it by its number, not its type. A closed issue with no type
is left as it is, and the plan says that too. No rule reads a title or a
label: the CLI writes neither for a Decision, so a Decision is typed by hand.

An issue whose parent is being retyped is read as the parent's new type, so
a Task with Task sub-issues becomes a Work item with Slices. The plan names
every issue it types, a run of consecutive ones in a repository that one
rule types alike on one row (the question names the first ten), and each
type it disables, and the one yes covers them. The agent
reads the organisation's types, but only the repositories it can see, so
where an enabled type outside the work model exists, or an issue to type, `onboard`
signs you in before the
plan and reads every repository as you: the plan shows what the yes
approves. The run reads again and changes nothing beyond it: an issue found
only after the plan keeps its type, or its lack of one, that type stays
enabled, and "By hand:" says to run `onboard` again. A dry run signs in to
nothing, so it lists what
the agent can see. It retypes every issue first and disables a type only then, so no
issue is left holding a disabled type: GitHub hides a disabled type on the
issues that hold it and shows it again if it is enabled. `onboard` disables
rather than deletes, so a type can come back; GitHub does not say what
deleting one does to its issues. A rerun cannot check a type that is
disabled: GitHub refuses to list issues by one (HTTP 422), for the owner
too, so the plan names each such type on a `disabled` row (as `disabled
Task, Bug, Feature: GitHub lists no issues by a disabled type, so onboard
cannot tell whether any holds one`), never saying none holds it, and the
type stays disabled; enabled again, `onboard` retypes what holds it and
disables it once more. Any other 422, one for an enabled type included,
still fails the read, as does any other refusal but the 410 of a repository
with issues turned off.
An issue in an archived repository cannot be
changed, so it keeps its type, that type stays enabled, and "By hand:" says
to unarchive the repository and run `onboard` again. A repository with issues
turned off, as a fork usually is, has none to read. A rerun changes
nothing when all is in order, and catches a type someone enabled again or a
default GitHub adds later. Disabling a type needs an organisation owner
(`admin:org`); retyping an issue needs write access to its repository. Both
come from the owner's sign-in for the run.

**New issues get a type as they open.** With `board` on, `onboard` writes
the client workflow (for `board` alone too), whose `niyam-asks` job
also starts when an issue is opened or reopened, and runs `niyam
issue-type`, which gives an issue with no type one by the same rule, read
from GitHub when the job runs, so a parent set as the issue was made counts.
GitHub starts no run for an issue a workflow's own `GITHUB_TOKEN` opens, such
as a monthly reminder a client's workflow files, so the job also runs on the
asks job's hourly cron and types every open issue in the repository with
none: such an issue has its type within the hour. An issue opened with a
type, one closed since, the Approvals issue, and a repository a personal
account owns are left alone. A workflow whose `issues:` trigger the client
changed keeps it, so there the job starts hourly alone. The job's
`issues: write` sets the type: GitHub's `type` on an issue takes write access
to issues, as the weekly job's undo issues, opened as Briefs by that token,
show. Issue events never come from a fork, and the job reads its settings
from the default branch and runs the CLI from the release the workflow pins,
so an issue's author, whoever opens it, changes nothing but that issue's
type. An issue made as a Brief and only
later made a sub-issue keeps Brief: no event starts the job then, so retype
it by hand.

`doctor` on a Mac, in a repository whose settings turn the board on, warns (`▲`)
when the organisation has an enabled type outside the work model or lacks
one of the work model's, naming the issues in this repository that hold
another type, and when an open issue here has no type, but the Approvals
issue; the fix is the owner running `onboard` again.

### Hooks that call GitHub

The lock in the settings' `env` reaches every hook, and session-start lifts
it only for the session's shells, through `CLAUDE_ENV_FILE`, which Claude
Code gives the SessionStart, Setup, CwdChanged and FileChanged hooks alone.
So a client's own hook that runs `gh` or git's remote commands, a
PreToolUse or Stop hook say, presents the lock's token, and GitHub answers
`HTTP 401: Bad credentials`; in a cloud session too. Run each such command
through `as-agent`, with the `session_id` Claude Code puts in every hook's
JSON input:

```sh
input=$(cat)
sid=$(printf '%s' "$input" | jq -r .session_id)
cli="$HOME/.config/niyam/bin/niyam"; [ -x "$cli" ] || cli="$HOME/.config/process-rules/bin/process-rules"; [ -x "$cli" ] || cli=niyam
printf '%s' "$input" | "$cli" as-agent --session "$sid" -- gh pr view --json state
status=$?
[ "$status" -eq 77 ] && exit 0  # locked: this session does not work as the agent
exit "$status"
```

`niyam as-agent --session <session_id> -- <command> [args...]` runs
the command only when session-start recorded, for that session id, that the
session works as one of the agents the settings file names, the
record the guard reads. On a Mac the command gets what the session file
gives a shell: the agent's identity, the lock's variables removed, and
`GH_TOKEN` read from the keychain as it starts. In a cloud session it gets
the proxy's placeholder token, which the proxy swaps for the connected
account's. Its standard input, output and error are the hook's, and its exit
code is `as-agent`'s. Otherwise nothing runs: one line on standard error says
why, in the guard's words, and `as-agent` exits **77**, a code
`gh`, git and the shell do not use, so a hook can tell "locked" from
the command's own failure. A missing `--` or command is bad usage, exit 2. The token is
only ever in the command's environment, never on a command line, in output
or in a file, and it never falls back to the owner's `gh` logins, git
password or SSH. Use the launcher line above, as the hooks `onboard` writes do:
the app's hooks may have no node on their `PATH`. `niyam doctor`,
run in the client repo, warns under "This repo" about each hook in `.claude/settings.json` or
`.claude/settings.local.json` whose command, or the repo script it runs,
calls `gh` or git's remote commands outside `as-agent`. A script that
imports a Python module tracked in the repo whose code runs `as-agent` (a
helper wrapping each `gh` call) counts as routed through it; the hook's
command is still judged. Outside a cloud session, a script is read only up
to a line, at column 0, that exits there,
`[ "${CLAUDE_CODE_REMOTE:-}" = true ] || exit 0` or
`[ "$CLAUDE_CODE_REMOTE" != true ] && exit`, when only blank lines, `set`,
`export` and the like, `.` or `source`, and assignments come before it: bash
runs nothing after it on a Mac. Both are read as text, so a routed script
that also calls `gh` on its own is not told apart.

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
the proxy before each push. `session-start` runs only as the SessionStart
hook: Claude Code sets `CLAUDE_ENV_FILE` for its hooks, never in the
session's shell, so run by hand there it always says STOP, which says
nothing about the session.
The hook's own line at session start is what counts.

A cloud session's git commits are authored and committed as Claude's own
account, `Claude <noreply@anthropic.com>`, and signed by it (Verified),
while the push is the agent's. PR identity checks only commits that claim
an agent, so these pass, and GitHub records the agent as having pushed
them.

The proxy refuses GitHub's GraphQL API, so the work rules and `reviews-due`
read only its REST API, here and everywhere else. The one exception is who
edited an owner's edited `Decision:` comment, which only GraphQL names; here
such a comment does not count.

The cloud environment's Setup script, which runs as root once the repo is
cloned and before Claude Code starts, installs the CLI. Claude Code has no
API or CLI for that field, so you paste it once, by hand, and it names no
version: `niyam cloud-setup` prints a short snippet that finds the
clone and runs its `.github/niyam/cloud-setup.sh`, else the
`.github/process-rules/cloud-setup.sh` of a repo `onboard` has not moved
yet, with `NIYAM_SETUP` and `PROCESS_RULES_SETUP` set. `onboard` writes
that file in its pull request at the version
`.github/workflows/niyam.yml` pins, and writes it again on every
run, so the pin bump that upgrades the checks upgrades cloud sessions too,
with no new paste. It writes the same file as
`.github/process-rules/cloud-setup.sh` too, which the snippet pasted before
P-56 runs, setting `PROCESS_RULES_SETUP` alone, so that paste keeps working
until you paste the new snippet once. The Setup script runs from the folder that holds the
clone (the VM's home, the clone one folder down), so the snippet looks there
and in each home. The file unpacks Node and the CLI under
`/opt/niyam` (`/opt/process-rules` before P-56), each once it matches the sha256 the file pins (Node's
from this release, the CLI's from GitHub's record of the release archive),
and puts `niyam` on `PATH`, leaving the image's own Node alone. The
environment needs the network to reach nodejs.org and GitHub's release
downloads.

The Setup field holds one script, so the snippet runs in a shell of its
own (`bash <<'NIYAM' … NIYAM`): a failed download, or a
clone with no such file, says so on standard error and the commands after
it still run. If the repo has its own Setup script, put this first, then
the repo's own: a repo's script may end with `exit`, and nothing after that
runs.

Claude keeps a snapshot of the environment once its Setup script has run,
and builds it again only when the Setup script changes or after about a
week. So after a pin bump, a cloud session's `session-start` finds its CLI
is not the release `cloud-setup.sh` installs, runs that file itself, and
says so in one line; the session goes on with the new CLI, and the snapshot
catches up on its next build. When the repo has no `cloud-setup.sh` while
the workflow pins another release, or the file is not at the workflow's
pin, the line says to run `onboard` again. When the Setup script still
installs a release of its own (an older paste), the line also says to paste
the snippet over it, once. It only warns: the session works on.

claude.ai has one GitHub connection per account, so it is the agent's for
every cloud session that account starts.

`niyam doctor` in a cloud session (`CLAUDE_CODE_REMOTE=true`) only
reads, in the same layout and with the same exit codes as on a Mac:

```
◆  niyam doctor   AGENT
│
◇  This cloud session
✗  .github/niyam/cloud-setup.sh installs 0.5.24, but .github/workflows/niyam.yml pins v0.5.25 → niyam onboard again
✓  niyam 0.5.24 runs here
▲  /opt/niyam/from-setup missing, so the cloud environment's Setup script does not run .github/niyam/cloud-setup.sh → paste what niyam cloud-setup prints into the cloud environment's Setup script, once
│
◇  GitHub — as AGENT
✓  the proxy acts as AGENT, an agent the repo's settings name
✓  session-start gave this session AGENT's identity
│
└  2 to fix
```

This cloud session checks that `cloud-setup.sh` opens with the comment
`onboard` writes, naming the release it installs, and that this release is
the workflow's pin (`✗`, fixed by running `onboard` again; a workflow that pins no one version is `▲`), that the CLI running is that
release (`▲`: `session-start` installs it, or `bash
.github/niyam/cloud-setup.sh` does), and that the Setup script
runs the repo's file (`▲` without `/opt/niyam/from-setup`, or the
`/opt/process-rules/from-setup` a cloud setup file before P-56 leaves),
naming the file it ran: the mark holds its path, and the old mark means the
old file. Each
file is read under its new name, else its old one, and named as the repo
has it. GitHub
checks that the account the proxy acts as is one of the settings' agents,
and that `session-start` gave the session that identity (`✗` otherwise:
`gh` and git stay locked out). This repo lists hooks that reach GitHub
outside `as-agent` and the Auto-fix rules missing, as on a Mac. It installs nothing; on Linux outside a
cloud session, `doctor` still refuses.

### Owner steps

Some GitHub changes only the owner's account can make: an organisation's
issue types, the `approved` and `do-not-merge` labels (the auto-mode
classifier keeps agents from changing them), and a ruleset's required checks.
An agent that needs one asks the owner to run one command in their own
terminal, never a script or a settings page:

```bash
niyam owner-step issue-types <org>
niyam owner-step label <owner/repo> <number> <add|remove> <approved|do-not-merge>
niyam owner-step required-checks <owner/repo> <ruleset id or name>
```

- `issue-types` adds the work model's issue types the organisation lacks and
  enables any that are disabled. It changes no other type and no issue; `onboard`
  does that.
- `label` adds or removes `approved` or `do-not-merge` on an issue or pull
  request. It refuses a label the repository does not have.
- `required-checks` makes the ruleset also require the checks of the features
  the repository's settings turn on, read from its default branch
  (`.github/niyam.json`, or `.github/process-rules.json` where that is
  missing): `niyam / PR identity` for `pr-identity`, `niyam / Work rules`
  for `work-rules` and `niyam / Design frames` for `figma`. It adds a check
  only when the repository's `.github/workflows/niyam.yml` (else, before
  P-56, `.github/workflows/process-rules.yml`) has a `niyam` job (or a
  `process-rules` one), named `niyam`, calling shared checks that run that
  job, at the version it pins. A required check that never reports would
  hold every pull request, so any other check is a `✗` saying why. Each
  check the ruleset requires under its name before P-53, `process-rules /
  …`, it requires as `niyam / …` in its place, once the workflow on the
  default branch, or on onboard's branch `niyam/onboard` (or
  `process-rules/onboard`), names the job `niyam`; before that it changes
  nothing. It keeps every other check
  and rule, removes none but those it renames, and shows the before and
  after.

It refuses in an agent session (`NIYAM_AGENT` or `PROCESS_RULES_AGENT` set, or `CLAUDECODE=1`)
and without a terminal. It makes a new folder in the user's temporary folder
(`niyam-owner-step-…`; on macOS, `getconf DARWIN_USER_TEMP_DIR`) and runs gh
with that folder as `GH_CONFIG_DIR`, `GH_PAGER=cat`, no `GH_TOKEN`, and
git's global config pointed inside the folder. It then signs in with one
browser approval of gh's device code: `gh auth login -h github.com -p https
--skip-ssh-key -w -s <scope> --insecure-storage`. The scope is `admin:org`
for issue types and `repo` for the others; gh always adds `repo`, `read:org`
and `gist`. The token stays in that folder: never in the keychain, the
owner's gh config, git's or SSH's settings, a command's arguments or the
output. Every call goes through `gh api` there, and none is made unless the
folder holds the token, so gh can never fall back to another login.

It checks that the signed-in login owns the organisation, or the repository
(the user who owns it, or an owner of its organisation), and reads what is
there. Then it prints exactly what it will change and asks for a yes; the
sign-in and the reads change nothing. It makes each change, reads it back,
and marks it `✓` or `✗`. Whatever happens, an error or Ctrl-C included, it
tries to delete the folder, which holds the token's only copy, and marks that
`✗`, with the `rm -rf` to run, when the delete fails. It does not run
`gh auth logout`, which deletes gh's keychain entries for the host whatever
`GH_CONFIG_DIR` says, and which cannot revoke the token anyway. The token
stays valid on GitHub until it is revoked, so the command ends with the link
to do that: https://github.com/settings/applications. Exit 0 when every change was made, or none
was needed or wanted, and no check was skipped; 1 otherwise, a `required-checks`
run that skipped a check included, even after a no; 130 after a Ctrl-C.
`doctor` marks `▲` any owner-step folder left behind, which a killed run or a
failed delete leaves, and says whether it still holds a token. A run going on
now has one too, so delete it only when no owner-step is running. Each step lives here with tests; a new step
is a slice the owner approves.

### Releases and upgrading

Each release is a tag `vX.Y.Z` on `main`, matching `package.json`; the
Release workflow checks both, runs `pnpm check` and publishes the GitHub
release, attaching the CLI package it built and tested. Install that package on
each machine with pnpm, once; nothing is built on install:

```bash
pnpm add -g https://github.com/veda-hq/niyam/releases/download/v0.6.9/veda-hq-niyam-0.6.9.tgz
```

The package puts one command on `PATH`, `niyam`; since 0.6.9 (P-54) it no
longer installs `process-rules`, its old name. Each release also attaches the
same CLI as `athya-hq-process-rules-<version>.tgz`, which still carries the
old command, so `process-rules upgrade` from an install of 0.5.37 to 0.6.3
still finds it; an install older than 0.5.37 has no `upgrade`, so it takes
the `pnpm add -g` line above.

After that, update it with one command on each machine:

```bash
niyam upgrade
```

`upgrade` asks GitHub's public releases API for the newest release, with no
token and no sign-in, and when it is newer than the CLI running, installs it
with the same `pnpm add -g`, printing old → new and the version the shell then
runs. On the newest release it says so and installs nothing; it never moves
back to an older one. When GitHub cannot be reached, or a newer release has no
package attached yet, or pnpm fails, it says which and exits 1, checking
nothing more. After an install, or when there was nothing to install, it walks
`PATH`, as `type -a niyam` does, reading an empty or relative entry
against the current folder as the shell does. It exits 0 when exactly one
`niyam` is there and it is the newest release. When more than one is
there, or the first is not that release, it lists each path and its version,
marks pnpm's own copy to keep, names the others to remove, and exits 1, since
an older copy the shell finds first is how a Mac keeps running an old release
after an upgrade. It works in an agent session on a Mac too; in a Claude cloud
session it refuses, because there the repo's `cloud-setup.sh` installs the
release the workflow pins. A CLI from before `upgrade` has none (`process-rules
help` lists it when it is there): install the newest release with the line above. `onboard`, when the repo pins a newer release than the
CLI running, refuses and says to run `niyam upgrade` first.

`onboard` pins the client's workflow to one version, the release of the CLI
that ran it. Each job writes the pin twice, `checks.yml@vX.Y.Z` and, two lines
below it under `with:`, `niyam-ref: vX.Y.Z`. `checks.yml` still takes
`process-rules-ref`, its name before P-56, from a workflow `onboard` has not
moved yet, and declares both, since GitHub refuses a caller that passes an
input the called workflow does not declare. Every job of
`checks.yml` runs the CLI from the commit it was called at (GitHub's
`job.workflow_sha`), so the checks and the CLI are always one release; on
GitHub Enterprise Server, which has no `job.workflow_sha`, the CLI comes from
`niyam-ref`, else `process-rules-ref`. Settings fails a run whose input names
another release, saying which, under the input's own name, and how to fix it: Dependabot and Renovate move
a job's `uses:` line and nothing else, so their bump of niyam leaves
the pair apart, and it also leaves out the cloud setup file's pin and any job a
newer release adds. So leave `veda-hq/niyam` and `athya-hq/process-rules` out of their updates (a
Dependabot `ignore` entry, a Renovate `packageRules` entry with `enabled:
false`). Upgrading is two steps: `niyam upgrade`, then `onboard` again,
which moves every pin together. Editing the version by hand means changing
every line that names it, two per job. A split workflow needs v0.5.4 or later: GitHub refuses a whole run, before
any job's `if:`, when the called workflow asks for more than the calling job
grants, and before v0.5.4 `checks.yml` asked for `issues: write` itself. The hooks run the
launcher `machine` writes, else the one it wrote before P-55, else `niyam` from the `PATH`; without
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

## Renamed from process-rules

process-rules became niyam in the release after 0.6.3 (docs/decisions.md,
P-49, P-50, P-53, P-54, P-55 and P-56). What changed, and what still reads or runs the old name:

| What | Now | The old name |
| ---- | --- | ------------ |
| Repository | veda-hq/niyam | athya-hq/process-rules, which GitHub forwards |
| Package | `@veda-hq/niyam` | each release also attaches the same CLI as `athya-hq-process-rules-<version>.tgz`, for 0.6.x's `upgrade` |
| Command | `niyam` | none since P-54: only the bridge archive, for 0.6.x's `upgrade`, still installs `process-rules`. Since P-53 the hooks, the launcher `machine` writes and the cloud setup run `niyam`; `doctor` marks ✗ a launcher that still runs `process-rules`, and `niyam upgrade` points it at `niyam` |
| Required checks | `niyam / Work rules`, `niyam / PR identity` (P-53) | `process-rules / …`; `owner-step required-checks` swaps them |
| Settings file | `.github/niyam.json` | `.github/process-rules.json`, read where the new one is missing, until P-57; since P-56 `onboard` moves it to the new name and deletes it |
| Keychain item | service `niyam` | service `process-rules`, read where the new one is missing; `machine` copies it to `niyam`, and while it is there a new token goes under both |
| Workflow pin | `veda-hq/niyam/.github/workflows/checks.yml@v…` | `athya-hq/process-rules/…`, which `onboard` moves |
| This Mac's files (P-55) | `~/.config/niyam/`: the agent folders and their session files, the session records, the locked `gh` folder | `~/.config/process-rules/`, which `machine` leaves in place and every reader still takes where the new folder has none, until P-57; a session file 0.6.9 wrote there still counts, and `doctor` marks it ▲ |
| Launcher (P-55) | `~/.config/niyam/bin/niyam` | `~/.config/process-rules/bin/process-rules`, left in place: the hooks `onboard` writes run the new one, else the old one, else `niyam` on PATH; older hooks run the old one, which `niyam upgrade` also points at `niyam`. `doctor` marks ▲ a working old one that is the only one, and ✗ an old one, alone or beside the new one, that cannot run or runs `process-rules` |
| Agent variable (P-55) | `NIYAM_AGENT` | `PROCESS_RULES_AGENT`, still set beside it, since older pre-push hooks and scripts read only it; every reader takes either |
| Lock (P-55) | placeholder token `niyam-no-agent-token`, and the SSH refusal says `niyam:` | `process-rules-no-agent-token`, still taken as no token; `onboard` updates the lock in a repo's `.claude/settings.json` `env` |
| Workflow (P-56) | `.github/workflows/niyam.yml`, its jobs `niyam`, `niyam-weekly`, `niyam-merged`, `niyam-asks`, each with the same `name:`, so the check names stay | `.github/workflows/process-rules.yml` and its `process-rules…` ids, which `onboard` moves and deletes, keeping the client's edits in every shape it knows (one it does not know is replaced by the template, as before, and the plan says so); `onboard`, `owner-step`, `doctor` and session-start still read it, until P-57 |
| Workflow input (P-56) | `niyam-ref` | `process-rules-ref`, which `checks.yml` still declares and takes, until P-57 |
| Cloud setup file (P-56) | `.github/niyam/cloud-setup.sh`, installing under `/opt/niyam`, with the Setup mark `/opt/niyam/from-setup`; the Setup snippet runs it, else the old file, setting `NIYAM_SETUP` and `PROCESS_RULES_SETUP` | `.github/process-rules/cloud-setup.sh`, which `onboard` still writes alike, since the snippet pasted before runs it until the new one is pasted once; it honours `PROCESS_RULES_SETUP`, and `/opt/process-rules/from-setup` still counts |
| Onboard branch (P-56) | `niyam/onboard` | `process-rules/onboard`, which `owner-step required-checks`, `onboard`'s check for a newer release's pull request and the work rules still take; a pull request still open from it, when it is the only open onboard pull request, is updated there rather than left beside a new one; when both branches have one open, `niyam/onboard`'s is updated and the old one is left for you to close |
| Decisions concurrency key | unchanged, `process-rules-decisions-<repo>` | kept, so runs at older releases and this one never run at once; P-57 renames it once no repo pins a release before P-56's |
| Board template (P-56) | the Project titled "niyam template" (athya-hq #4) | "process-rules template"; `onboard` finds it by number, so the title changed nothing it reads |
| Internal names (P-56) | the decisions check's mark `niyam-check-exit=`, temporary folders `niyam-…`, the test commit's branch `niyam/verify-…`, a new token's description `niyam agent` and signing key's title `niyam signing` | none read; tokens and keys made before keep their titles |

Still read, and P-57 stops: `~/.config/process-rules/` and its launcher,
`PROCESS_RULES_AGENT`, `process-rules-no-agent-token`, the keychain service
`process-rules`, `.github/process-rules.json`, `.github/workflows/process-rules.yml`
with its ids, `process-rules-ref`, `.github/process-rules/cloud-setup.sh`,
which `onboard` writes until then, `/opt/process-rules/from-setup`,
`PROCESS_RULES_SETUP` and `process-rules/onboard`; the decisions job's
concurrency key `process-rules-decisions-…`, which P-57 renames; and the bridge archive for
0.6.x's `upgrade`. Unchanged for good: the `process-rules vetted` marks on
decisions vetted before the rename, which the reviews still read; GitHub's
redirect from athya-hq/process-rules; the titles of tokens and signing keys
made before; and the history in docs/decisions.md and docs/roadmap.md.

From a 0.6.x install, `process-rules upgrade` installs the old-name archive,
which replaces the old package in place; pnpm refuses a second global package
with the same bin. Then `niyam upgrade` moves it to `@veda-hq/niyam`: it
removes the old package, adds the new one, and puts the old one back if the add
fails. pnpm keeps the `process-rules` command at the same path, so the
launcher `machine` wrote keeps working until `niyam upgrade` points it at `niyam`; since P-54 the package installs no `process-rules`.
`niyam upgrade` and `niyam machine` point the launcher at `niyam`. Run `niyam machine` once afterwards to
copy the token to the `niyam` keychain service and write the session file and
the launcher under `~/.config/niyam/`; until then the old ones still work, and
a session started before the upgrade keeps its record and its identity. The
old folder stays for hooks and CLIs that still read it.

The old folder, launcher, `PROCESS_RULES_AGENT` and placeholder token of
P-55's rows stay for one release: P-57 removes the folder and the launcher and
stops reading the old names, once every Mac has run `niyam machine`.
