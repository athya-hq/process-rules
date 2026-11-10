# Decisions

- **2026-10-30 — Record: an independent product.** The owner, in chat:
  "Please make sure that process-rules is an independent product and [the
  first client] is its first client about which the product shouldn't know.
  If you need to re-slice then re-slice." The product is built and released
  here and proven against a sandbox client; clients adopt a released version
  and track their own adoption. Code, tests and docs here name no client,
  this record included.
- **2026-10-30 — Record: machine setup is per agent account.** A first
  `machine` run asked for a token limited to one client repository and made
  its test commit there; the token then waited on an organisation owner's
  approval that the instructions only hinted at. Whether the agent can push,
  and the Verified test commit, depend on the client, so they move to
  `onboard`; `machine` sets up the agent account alone (P-02, P-04).
- **2026-10-30 — Record: the agent account uses one classic token.** The
  owner, in chat: "Yes, classic token". A fine-grained token waits on each
  organisation owner's approval, reaches no repository where the agent is
  only an outside collaborator, takes one token per organisation, and, when
  an organisation owns it, cannot register the agent's signing key. A
  classic token with `repo`, `workflow`, `read:org`, `project` and
  `write:ssh_signing_key` reaches every repository the agent is invited to.
  What a leak could reach is bounded by inviting the dedicated agent account
  to client repositories only, and by an expiry: `machine` refuses a token
  that never expires and recommends 90 days, and `doctor` warns 14 days
  before it ends. `machine` also refuses a fine-grained token or missing
  scopes; `onboard` names an organisation that requires SAML authorisation
  or blocks classic tokens (P-02, P-04).
- **2026-10-31 — Record: staged adoption, P-12.** The owner, in chat: "Yes,
  add P-12 first". The first client adopts one feature at a time, and
  `onboard` turned every feature on at once: its work rules would refuse
  every agent push and pull request before the client's work lives in
  issues. So a client's settings list the features it has turned on,
  `onboard` sets up only those and adds one more on request, the shared
  checks and the pre-push hook skip features that are off, and the
  Project's title is a setting. Settings that list no features keep every
  feature on, as before. Added to roadmap v1 as P-12, after P-11.
- **2026-10-31 — Record: P-13, onboard works out the accounts.** The owner,
  asked whether a third party should be able to run plain `process-rules
  onboard`: "Yes." `onboard` suggests the owner from the `gh` login and the
  agent from the accounts `machine` set up on the Mac, for the owner to
  confirm, and adds its hook to `.claude/settings.json` without rewriting the
  rest of the file.
- **2026-10-31 — Record: P-14, process-rules adopts itself.** The owner: "Yes,
  add P-14". The product's own work moves from these files to issues and a
  Project, and agent sessions on it work as the agent account, so the product
  is built under its own rules before its first client moves its work.
- **2026-10-31 — Record: the roadmap moves to issues, P-14.** The owner, on
  P-14: "Yes, add P-14". Onboarding process-rules with `work-rules` means an
  agent pull request here names a Slice issue under a Work item the owner
  approved, so the roadmap became the Work item #22 "process-rules roadmap
  v1", with one Slice sub-issue per row (#23 to #36), on the Project
  "process-rules work". The issues are the source of truth from then on;
  `docs/roadmap.md` keeps v1 as approved and links each row to its issue.
  The shipped slices were closed as completed, each citing its pull request.
- **2026-10-31 — Record: P-15, the adoption gaps closed.** The owner, on the
  Work item #22: "Decision: add #40 (P-15) to roadmap v1." process-rules hit
  three gaps adopting itself: `onboard` stopped when the agent could already
  read the repo instead of offering the grant; pre-push refused a push that
  brought only a merge of the default branch; and the pull request that first
  commits the settings failed its own PR checks. The slice #40 closes them.
- **2026-10-31 — Record: P-16, onboard makes the Project views.** The owner
  approved the slice, and on the Work item #22: "Decision: add #44 (P-16),
  #45 (P-17) and #46 (P-18) to roadmap v1." `onboard` printed that GitHub's API cannot make Project views;
  its GraphQL API now creates and updates them, with a layout, a filter and
  the visible fields. So `onboard` makes the five views, renaming the default
  one, and prints only what the API still cannot set: grouping, the Board's
  column field and the auto-archive workflow, which it can only read or
  delete.
- **2026-10-31 — Record: P-17, agent sessions fail closed.** The owner, on
  the Work item #22: "Decision: add #44 (P-16), #45 (P-17) and #46 (P-18) to
  roadmap v1." The first client
  found agent sessions reaching GitHub as the owner when session-start left
  no trace or its variables never reached the session's shells. Claude Code
  hooks other than SessionStart cannot see the variables it writes to
  `CLAUDE_ENV_FILE`, so nothing can check them before a command; three
  layers instead. The client's `.claude/settings.json` holds the lock in
  `env`, which Claude Code gives every session before any hook runs, so a
  session nothing set up reaches GitHub as nobody; a cloud session's
  SessionStart hook unsets it, as cloud sessions reach GitHub as the account
  connected to them. A PreToolUse guard refuses
  `gh` and git's remote commands unless session-start recorded, for that
  session id, that it gave the agent identity, repeating why it did not; a
  session whose shells lost the variables after it recorded success still
  has the lock. And the hooks run a launcher `machine` writes, naming node by
  its real path, since a version manager's per-shell node may be missing
  from the app's hook environment. The guard matches commands by their text,
  so it misses what a script runs; the lock and the pre-push hook cover that.
- **2026-10-31 — Record: P-18, the owner's SSH route.** The owner, on the
  Work item #22: "Decision: add #44 (P-16), #45 (P-17) and #46 (P-18) to
  roadmap v1." After `machine` signed `gh` out of the owner, git still
  reached GitHub as the owner over SSH, with the owner's key from the SSH
  agent. `machine` and `doctor` name the account SSH reaches GitHub as, but
  removing that route is out of scope: the key is the owner's own way to
  GitHub, used outside agent sessions, and an agent session runs as the same
  macOS user, so nothing on the Mac tells its `ssh` from the owner's. The
  route is covered where agents act instead. The lock, in every session's
  `env` since P-17, sends GitHub's SSH remotes over HTTPS and refuses SSH,
  and the pre-push hook, now written for every adopter, refuses an agent
  session's push over SSH, or over HTTPS as anyone but the agent. It knows an
  agent session by `CLAUDECODE`, which Claude Code sets in every shell it
  runs, so it holds where the hooks never ran. What remains is a session that
  works around the lock and the hook on purpose; only a separate macOS user
  for agent sessions would close that.
- **2026-10-31 — Record: P-19, onboard copies a template Project.** The
  owner, on the views P-16 could not finish through the API: "I need an
  onboarding process where the repo owner has to do absolute minimum which in
  my opinion is running a command and giving owner and agent account. Rest
  all should be taken care by product itself." And on the Work item #22:
  "Decision: add #66 (P-19) and #67 (P-20) to roadmap v1." GitHub's API
  cannot group a view or make a workflow, but it copies a Project with its
  views, grouping, fields and workflows. So the product keeps one public
  Project, set up once by its owner, and `onboard` copies it into each
  client; a Project made before it is offered a move to a copy. It is a
  plain public Project, not one marked as a template: marking it turned its
  workflows off, and copies kept them off.
- **2026-10-31 — Record: P-20, the owner approves with a reaction.** The
  owner, on the Work item #22: "Decision: add #66 (P-19) and #67 (P-20) to
  roadmap v1." Typing a `Decision:` comment was the only way to approve a
  slice added after its work item's approval, or a State dropped after it.
  Now the agent runs `process-rules propose <issue>`, which posts a
  `Proposal:` comment as the agent, mentioning the owner, and labels the
  slice `needs-owner`; the owner's 👍 on it counts as a `Decision:` does.
  The choices: proposals go on the slice, for a dropped State too, because
  the Needs you view shows open issues only and a dropped State is closed;
  a proposal approves the issue its first line names first (`#N`), so a 👍
  on a state's proposal cannot approve the slice's addition; GraphQL gives
  each reaction's user and time, so a 👍 counts only after the slice's latest
  addition, as a `Decision:` does, and only after the proposal's last edit,
  so the agent cannot change what was approved; and reactions are read only
  for proposals that could still settle something, so a check costs no more
  when nothing is owed. `propose` refuses to post unless the session's token
  is the agent's, since only the agent's proposals count, and takes
  `needs-owner` off once nothing waits. A reaction triggers no workflow, so
  the pull request's Work rules check sees a 👍 made after it ran only when
  it runs again.
- **2026-10-31 — Record: P-22, cloud sessions work as the agent.** The
  owner, in chat: cloud sessions are "needed": claude.ai's GitHub
  connection for agent sessions is the agent account, the environment's
  setup script installs the CLI, and session-start checks the account
  GitHub sees is the agent, printing STOP otherwise. This replaces the
  2026-10-31 rule above (P-17) that a cloud session's hook unsets the lock: now it
  lifts it only for the agent. Claude's GitHub proxy refuses GraphQL
  (whatever the credentials), so the owner chose the more robust of the
  ways through: the work rules read GitHub's REST API alone, on a Mac, in
  a cloud session and in Actions, rather than skipping them before a cloud
  push or refusing cloud pushes. REST names when a comment was last edited
  only as `updated_at`, which a reaction does not move, so a 👍 counts only
  after it. REST pages reactions too, so a proposal with more than 100 👍s
  is read in full. A cloud clone has no pre-push hook, so session-start
  writes it there before lifting the lock. The CLI reaches GitHub through
  `HTTPS_PROXY` when one is set, as gh and git do.
- **2026-11-01 — Record: pull request and push runs are read-only.** A
  review of a client's adoption flagged that the workflow `onboard` wrote
  gave every run `issues: write`, though only the weekly decisions run
  writes to issues; so did upgrading, since `onboard` replaced a client's own
  split with its one job. `onboard` now writes two jobs calling
  `checks.yml`: `process-rules` on pull requests and pushes, with the
  workflow's read-only permissions, and `process-rules-weekly` on the
  schedule and by hand, with `issues: write`. The pull request checks keep
  their names, `process-rules / …`, so required checks need no change.
  Splitting alone was not enough: GitHub refuses a whole run, before any
  job's `if:`, when a called job asks for more than its caller grants, and
  `checks.yml`'s weekly job asked for `issues: write` itself, so a split
  workflow at v0.5.2 or earlier fails to start on every pull request and
  push. From v0.5.4 `checks.yml` sets no workflow-wide permissions, its
  read-only jobs set their own, and its weekly job takes what the calling
  job grants. `onboard` replaces the older single-job template, moves only
  the version pins of a workflow already split (and its push branch, when the
  default branch has changed), and offers to replace any other workflow, as
  before. Released in v0.5.4, a patch release: v0.5.3 was never tagged.
- **2026-11-01 — Record: P-33, onboard warns about a CODEOWNERS naming the
  owner.** The owner, in chat, answered "OK." to: "process-rules release:
  onboard warns about such a CODEOWNERS file and offers the fix. This is the
  product's job, and every client would get it." Once the agent authors the
  pull requests, a CODEOWNERS rule naming the owner makes GitHub ask the
  owner to review every agent pull request, shown as coming from the agent,
  since GitHub never asks a pull request's author. `onboard` reads the file
  GitHub uses (the first of `.github/CODEOWNERS`, `CODEOWNERS` and
  `docs/CODEOWNERS`), says so, and offers to remove the owner's handle from
  those rules and drop a rule left with no owners, whose paths then fall to
  the rules before it; the default is no, and declining leaves the file,
  since a client may want the requests. It asks last, after the test
  commit, so a run stopped earlier and run again still names the file to
  commit. Only the owner's own handle counts: a team the owner belongs to
  is the client's to change, and GitHub's API does not say who a team's
  review would reach without more scopes. `doctor`, in an adopting repo,
  warns about the same rules and changes nothing.
  Reversed on 2026-11-05: onboard keeps CODEOWNERS (below).
- **2026-11-01 — Record: P-34, agent sessions answer review threads
  without asking.** The owner, in chat, when replying to and resolving a
  review thread waited on approval in auto mode: "This shouldn't be a
  question. My work shouldn't wait for this. Please ask the product to fix
  this." The issue asked for permission rules on the replies endpoint and
  the GraphQL review-thread mutations. Claude Code's permission docs call
  rules that constrain a command's arguments fragile, and a `*` in a Bash
  rule matches any text, spaces included, so a rule on `gh api
  repos/*/pulls/*/comments/*/replies *` would also allow a call to any other
  endpoint with that text in a field. So the rule allows one CLI command,
  `process-rules review-thread`, which builds the requests itself and
  refuses unless the session is the agent's and the thread is on a pull
  request the agent opened in the repository here. `onboard` adds the rule
  to `permissions.allow` for every client, as part of identity. Released as
  v0.5.5, a patch release.
- **2026-11-01 — Record: P-23, Figma settings out of the repo.** The
  owner's decision of 2026-10-31 on #53: the design library's key moves out
  of the committed settings into the client's Actions secrets, next to the
  token; `onboard` writes the Figma lines into the workflow only when the
  feature is on; and the feature is renamed `figma`, so another design tool
  would be a feature of its own. The key is a secret (`FIGMA_LIBRARY`), not
  an Actions variable, so a public repository's run logs mask it too, and the
  workflow passes it to the shared checks like `FIGMA_TOKEN`. Older settings
  keep working: `design` is read as `figma` and a committed
  `figma.library` is read when the secret is not set, each with a warning
  in the run; `onboard` renames the one and takes out the other, after
  asking, and prints the `gh secret set` command for the key. In a workflow
  already split into its two jobs, `onboard` sets each job's Figma secrets
  to what `figma` needs and leaves a secrets block holding the client's own
  secrets as it is, saying which job that leaves without FIGMA_LIBRARY.
  Released as v0.5.6, a patch release.
- **2026-11-01 — Record: P-37, onboard sets the FIGMA_LIBRARY secret
  itself.** Since P-23, `onboard` took the Figma library key out of older
  settings and printed `gh secret set FIGMA_LIBRARY …` for the owner to run,
  but the owner stays signed out of `gh` for good (P-35). Decided: `onboard`
  sets the secrets it needs itself, as the owner for one run. With the
  run's one browser approval it reads the repository's Actions public key,
  seals the key as a libsodium sealed box and PUTs the secret through the
  REST API; a value that is not a Figma file key is not stored, and the
  owner is told where in the repository's settings to set the right one.
  The key never appears in onboard's output or in a request in the clear.
  The sealing uses `libsodium-wrappers` (with its `libsodium`), the
  reference implementation of `crypto_box_seal` and the package GitHub's
  own documentation uses: `tweetnacl`, smaller, has no sealed box and no
  BLAKE2b for its nonce and has had no release since 2020, and the
  `@noble` packages would mean assembling the sealed box from primitives
  here. It is loaded only when a secret is set, since the shared checks run
  the CLI from its source with no packages installed. Approval: the
  owner's 👍 on #88. Released in the next 0.5.x patch release.
- **2026-11-01 — Record: P-36, onboard opens its changes as the agent's
  pull request.** `onboard` wrote `.github/process-rules.json`,
  `.claude/settings.json`, the workflow and CODEOWNERS into the owner's
  checkout and left them uncommitted: run on the default branch, as an
  owner naturally does, it blocked the next `git pull --ff-only`, and a run
  that stopped early never said the files needed committing. Decided: the
  owner's checkout is never modified. Each file change is held in memory
  until every step has run; then `onboard` makes a temporary repository
  holding the default branch's tip (its trees only, fetched as the agent
  with `--filter=blob:none`, so a large repository costs little), puts each
  changed file in its index, commits once, signed as the agent, pushes to
  `process-rules/onboard` as the agent (forced, so a run again updates the
  same branch) and opens the agent's pull request, or updates the open one;
  the temporary repository is deleted in a `finally`. A file the default
  branch has otherwise than the checkout is refused, so nothing merged
  since is undone. A run that stops, or changes no file, opens no pull
  request. Steps that are not files (the agent's access, the board) still
  act at once, as the owner for one run (P-35); the pre-push hook, which
  git does not track, is written in place. The work rules pass an agent
  pull request from `process-rules/onboard` in the repository itself that
  changes only the files `onboard` writes: the owner confirmed each change
  at the terminal and merges it. Approval: the owner's 👍 on #82. Released
  in the next 0.5.x patch release.
- **2026-11-01 — Record: P-35, owner commands sign in for one run only.**
  `machine` signs the owner out of `gh` so agent sessions cannot use the
  owner's account, but `onboard` read the owner's stored `gh` login (with
  `project` and `admin:org`) for the board and the agent's access, so the
  owner was told again and again to sign in and out of `gh`. Decided: the
  owner stays signed out of `gh` for good, and no process-rules command,
  message or doc tells the owner to sign in to or out of `gh`. A command
  that needs the owner's GitHub rights runs `gh auth login --web` with the
  scopes its features need into a fresh temporary `GH_CONFIG_DIR` (no
  `GH_TOKEN` or `GITHUB_TOKEN`, plain-text storage there, SSH as the
  protocol with no key so gh does not set up git), reads the token with
  `gh auth token` from that folder, refuses it unless its login is the
  owner's, and deletes the folder in a `finally`. One browser approval per
  run serves every step that acts as the owner; the token is held in
  memory only. GitHub keeps the gh app's authorisation on the owner's
  account, which the owner can revoke under Settings → Applications; no
  token is left on the Mac. Approval: the owner's 👍 on #83. Released as
  v0.5.7, a patch release.
- **2026-11-01 — Record: P-38, PR identity judges the pusher, not the
  run's actor.** In sandbox PR #8 on 2026-10-30, the run on `opened` failed
  the owner's push of an agent commit, and the run started ten seconds
  later by Cubic editing the description passed, "pushed by
  cubic-dev-ai[bot]". #11 moved the check to GitHub's push record
  (`GET /repos/{repo}/activity` on the head branch), but kept the run's
  actor as the pusher of commits not recorded yet on `opened` and
  `synchronize`, so the owner pushing and the agent opening the pull
  request at once still passed. Decided: who pushed comes from the push
  record alone and `GITHUB_ACTOR` is not read. A commit no recorded push
  brought is read again for about a minute, then fails closed until a
  re-run finds it; a push recorded with no actor, and a pull request whose
  head repository is gone, fail too. The record is the head repository's,
  so a fork's pull request reads the fork's; a private fork the run's token
  cannot read fails the check. Merge-queue pushes go to the queue's own
  branches, not the pull request's, so they never count. Approval: the
  owner's 👍 on #91. Released in the next 0.5.x patch release.
- **2026-11-01 — Record: P-27, a declined lockout stays declined.** The
  owner's decision of 2026-10-31 on #57: keep offering the lockout. On a
  team member's laptop or a shared machine, accepting it signs that person
  out of their own GitHub tooling, and declining left `doctor` warning on
  every run. So `machine` records what the owner declined, the `gh` logins
  it named and the saved git password, in the agent's folder beside the
  session file, and `doctor` reports those as a passing line. The record
  names each finding, so an account signed in after the owner declined is
  still a warning; each `machine` run offers again and rewrites the record
  from that run's answers, so accepting clears it. Keys with no passphrase
  and the SSH route are not offered, so they are not recorded. The docs
  present the lockout as optional hardening for a machine that runs agents,
  and a separate macOS user for the agent sessions as the stronger
  alternative.
- **2026-11-01 — Record: P-31, the classic token trade-off documented.**
  The owner's decision of 2026-10-31 on #52: "keep the one classic token
  for now (Athya's organisation allows it)". The README records the
  trade-off for outside adopters: the token's `repo` scope reaches every
  repository the agent account can access, and an organisation or
  enterprise that blocks classic tokens cannot adopt yet. A fine-grained
  token or a GitHub App waits for adoption outside Athya. Docs only; no
  release.
- **2026-11-01 — Record: P-29, the token store behind an interface.** The
  owner's decision of 2026-10-31 on #49: Athya's agents run on macOS
  laptops and in Claude cloud sessions, so keep the macOS keychain, but put
  the token store behind an interface so a Linux or Windows store can be
  added without rework. One `TokenStore` reads and stores the agent's token
  and gives the session file the shell command that reads it on each use;
  the keychain, through `/usr/bin/security`, is its only implementation,
  and `machine`, `doctor`, `session-start` and `onboard` reach the token
  through it. The session file is unchanged, so no machine needs `machine`
  run again. On a platform with no store, `machine` and `doctor` refuse,
  naming macOS, and `session-start` keeps GitHub locked out. The owner
  lockout's checks of the owner's own keychain items stay as they are: they
  are not the agent's token. Other platforms wait for adoption outside
  Athya; the README states macOS as the supported platform.
- **2026-11-01 — Record: P-28, org-wide issue types announced; schedule a
  setting.** The owner's decision of 2026-10-31 on #55. Issue types are an
  organisation-wide setting, so the ones `onboard` adds reach every
  repository in the organisation, not only the one being onboarded. Before
  adding any, `onboard`'s question now says so and names the types it
  would add; it says nothing when they all exist. The weekly decisions
  schedule, fixed at Mondays 06:17 UTC, becomes `"schedule"` in
  `.github/process-rules.json`: a five-field cron in UTC, checked before
  `onboard` changes anything, defaulting to `17 6 * * 1`. `onboard` writes
  it into the workflow's `schedule:`. When `onboard` repins a split
  workflow, it moves the one cron it wrote as it moves the push branch,
  asking first and leaving a schedule the client has made its own (more
  crons, or a comment on the line) alone. Renaming the types, labels, field
  options and markers waits for adoption outside Athya.
- **2026-11-01 — Record: P-24, personal repos refused what they cannot
  run.** The owner's decision of 2026-10-31 on #48: `onboard` and the
  checks refuse `work-rules`, `decisions` and `figma` on a repository a
  personal account owns, saying why: GitHub has issue types for
  organisations only. The work rules need a Slice under a Work item, the
  weekly job and `reviews-due` list issues by type, and the design check
  reads State sub-issues, so none can run there. `onboard` refuses them in
  `--features` and `--add`, and with no `--features` turns on the rest and
  names what it left off; it asks GitHub whether the owner is an
  organisation once per run. The checks that need issue types ask GitHub
  the repository's `owner.type` once per run and, on a personal account's
  repository, pass with the line a feature that is off prints, giving the
  reason, rather than failing every pull request; the weekly job leaves
  vetoes alone there too, since they sit on Decision issues. Labels as a
  substitute for issue types wait for adoption outside Athya.
- **2026-11-01 — Record: P-40, approvals ask only for what needs the
  owner.** The owner approved eight late-added slices on #22 in minutes
  each, none questioned, and asked: "How can we be sure of it so that we
  can use the mechanism properly?" In chat they agreed that a comment on the
  work item counts as approval ("This is OK"), kept chat requests filed with
  a quote and approved once ("But let's keep the following too"), and
  declined a daily batch of proposals ("not appropriate") and a weekly
  approval health check ("no need"). So:
  - **A request on GitHub is its own approval.** A slice added after its
    work item's approval is approved when its body links
    (`…/issues/<work item>#issuecomment-<id>`) a comment the owner wrote on
    that work item before the slice was last added. The work rules match the
    link to the work item's comments as GitHub returns them, so the author,
    the issue and the time are GitHub's, not the link's. A comment edited
    since it was written does not count: REST does not say who edited it,
    and the agent, with write access, can edit another's comment. The
    comment cannot name the slice, which it came before, so which comment
    asked for it is the agent's claim, in the slice's body for the owner
    to see; the owner accepted that check (author, work item, time).
  - **Fixes need no approval, and need no new rule.** A fix restores what
    the owner approved and changes nothing they would see beyond it. It is
    filed as a State under the slice it fixes, and its pull request names
    that slice (`Slice: #N`), closed or not; the slice's own approval
    rules still apply. A State added after approval
    already owes the owner nothing; only a slice added late, or a State
    dropped, does. Anything filed as its own slice, called a fix or not,
    keeps the 👍: whether a change goes beyond what was approved is a
    judgement about what the owner would see, which no code rule can make
    from an issue's text, so the gate is not loosened on a label or a word.
  - **Chat requests keep the 👍.** The agent files the slice quoting the
    owner's words and proposes it; the owner's 👍 approves it once.
  - **Every proposal stands alone.** `propose` writes what changes (the
    slice's "You will see"), why (its "Why"), what it costs (its "Cost",
    else one more slice of the work item for the owner to review) and what
    happens if the owner declines; for a dropped State, why from the
    state's own "Why". It refuses, posting nothing, while a body lacks
    those sections, naming them, so the agent writes them first. The first
    line still names the issue first (`#N`), which the 👍 matching relies
    on, so proposals posted before P-40 still count.
- **2026-11-01 — Record: one GitHub host constant, P-30.** The owner, in
  chat: route every github.com and api.github.com address through one host
  constant, so a host setting is easy to add later; the README documents
  github.com as the only supported host. `src/host.ts` names the host once
  and derives the API, web, SSH and no-reply forms from it; the API base,
  remotes and their HTTPS rewrites, the credential helper, the token and key
  pages, the release download, `gh -h` calls and push-identity's checks all
  use it. What clients already have stays byte for byte the same: the
  settings `env` that `onboard` writes, the session file session-start
  compares, the hook commands and the workflow template. A test fails when
  the host is written out in `src/` outside that module. The shared
  workflow `.github/workflows/checks.yml` names no host: its checkout of
  `athya-hq/process-rules` and the actions it uses (`actions/checkout`,
  `actions/setup-node`) come from whichever host runs the workflow. On
  another host all of them must exist there (for actions, GitHub Connect
  can sync them), or the checkout must name github.com; that is for the
  host setting, which, for GitHub
  Enterprise Server or GHE.com, is not built. GitHub Enterprise Server's
  API is `https://<host>/api/v3`, not `api.<host>`, so the setting also
  changes how the API base is derived.
- **2026-11-01 — Record: owners and agents as lists, P-26.** The owner, on
  #56 (31 Oct 2026, in chat): Athya keeps one owner and one agent for now,
  but the settings become generic: they accept lists of owners and agents,
  the single-string form still read, and every check accepts anyone in the
  list. `loadSettings` reads `"owner"` and `"agent"` as a login or a
  non-empty list of logins and returns lists; it refuses an empty list, a
  non-login, and any account named as both. A login listed twice, in any
  case, counts once. The work rules take a 👍, a `Decision:` comment, a
  request on the work item or the `approved` label from any owner, and
  proposals and pull requests from any agent; PR identity takes a commit
  claiming an agent only when it is Verified as that same agent, and
  pushed by any agent; pre-push, `review-thread`, `propose`, the design,
  decisions and `reviews-due` checks and the doctor's CODEOWNERS check take
  any of the list. The guard reads only what session-start recorded, so it
  needed no change. Where one account must be chosen:
  - **A Mac's sessions work as one agent.** With one agent listed, that
    one, as before. With several, session-start, `machine` and `doctor`
    (without a login named) take the one listed that `machine` set up on
    this Mac, found by its session file. With none of them set up, or more
    than one, session-start keeps GitHub locked out and says which, and
    `machine` and `doctor` ask for the login: two set up on one Mac would
    make the session's identity a guess. A cloud session works as whichever
    listed agent claude.ai's GitHub connection is.
  - **Who to tell is the first owner.** session-start's "tell" and "ask …
    to run machine" lines name the first owner; checks that list who may
    act name the whole list ("A or B"); a proposal mentions every owner.
  - **`onboard` keeps the one-login form.** It writes
    `{ "owner": "…", "agent": "…" }` as before, so existing settings do not
    change. On settings that list several, it works as the owner named,
    else the one the run's browser sign-in is, and the agent named, else
    the one set up here; it refuses a login the lists do not hold, a
    sign-in as anyone they do not hold included, and leaves the lists as
    they are. (At first it took the first owner, so only that owner could
    run plain `onboard`; the sign-in, which `onboard` needs anyway, says
    which owner is at the terminal.) Its CODEOWNERS offer removes every listed owner a rule names.
  Teams as approvers are out of scope.
- **2026-11-01 — Record: moving `gh` to the agent names the owner's two
  steps, P-42.** The owner asked for this in the P-30 session and had the
  coordinator file it. Sessions could not turn on Auto-fix for the agent's
  pull requests: the desktop app checks the PR's author against the account
  of the `gh` token it read, keeps that token until GitHub rejects it, and
  had read the owner's before the Mac's `gh` login moved to the agent. After
  a restart, Auto-fix turned on for an agent pull request with no per-PR
  step. `gh auth logout` also leaves the old token valid on GitHub, and only
  the owner can revoke it there. So when `machine`'s lockout signs an
  account out, it ends with both steps together and records when and which
  accounts beside the session file. `doctor` repeats them while the desktop
  app, as `ps` lists it, started before that time; it cannot see whether the
  token was revoked, so the revoke step goes with the restart step and both
  stop once the app has restarted: a revoke skipped then is not raised
  again. That is accepted, since the agent's token cannot list or check the
  owner's authorised OAuth apps, and asking the owner to confirm would add
  a step to every `doctor` run. A second move before a restart keeps the
  first move's accounts in the record.
- **2026-11-01 — Record: client hooks act on GitHub as the session's agent,
  P-43.** The owner, in chat: "New process-rules roadmap work: let a
  client's hooks act on GitHub as the session's agent." The first client saw
  a PreToolUse hook's `gh api graphql` get "HTTP 401: Bad credentials" while
  `gh` in the same session's shell worked as the agent. Claude Code's hooks
  docs (https://code.claude.com/docs/en/hooks, "Persist environment
  variables") give `CLAUDE_ENV_FILE` to SessionStart, Setup, CwdChanged and
  FileChanged hooks only, as P-17 says, so every other hook keeps the lock
  the settings' `env` gives. P-17 and P-18 stay as they are: the lock still
  reaches every hook, and nothing reaches GitHub as the owner. Instead a
  hook runs its GitHub command through `process-rules as-agent --session
  <session_id> -- <command>`, which runs it only when the session record the
  guard reads names one of the settings' agents. On a Mac the child gets
  `sessionEnv`, the session file's variables, over the hook's environment
  with the lock's removed, and only after the session file is checked as
  session-start checks it; the token is read from the token store as it
  starts and goes only into the child's environment. In a cloud session the
  child gets what session-start's `CLAUDE_ENV_FILE` lines give a shell
  there: the lock unset and the proxy's placeholder token. A cloud
  session's hooks see only the lock's token too: session-start's unset goes
  through `CLAUDE_ENV_FILE` as on a Mac, and the proxy swaps its own
  placeholder, not the lock's (read from the code and the docs; not seen in
  a live cloud session). The choices:
  - **Exit 77 means locked.** sysexits' `EX_NOPERM`. Not 0, 1 or 2, which
    are done, failed and bad usage here, and 2 blocks a tool call in
    Claude Code's hooks; not a code `gh` (1, 2, 4, 8) or git (1, 128, 129)
    exits with, nor the shell's 126, 127 or 128 plus a signal, which the
    child's own exit is reported as. A session id `sessionRecord` would not
    take, and any failure of the check itself, are locked too, since nothing
    ran; a missing `--` or command is bad usage, exit 2.
  - **Pass-through by inherited standard streams.** `Sys.exec`'s
    `interactive` option, already in the interface the fake implements,
    gives the child the hook's standard input, output and error;
    `as-agent` returns the child's code, which the real Sys now reports as
    a shell would for a signal or a command not found.
  - **`doctor` reports hooks that would hit the lock.** It was cheap: it
    reads the hooks in `.claude/settings.json` and
    `.claude/settings.local.json`, skips process-rules' own, and warns about
    each whose command, or the repo script its first word names, reaches
    GitHub by the guard's test outside a line running `as-agent`. Like the
    guard, it reads text, so a script another script runs is missed.
- **2026-11-01 — Record: P-25, the review routine watched.** The owner, on
  #60: "`onboard --add review` creates the scheduled routine itself (through
  Claude's API, if one is usable) and checks it runs as the agent; and the
  weekly job labels `needs-owner` any decision whose review is over a week
  overdue with no `Kept:`/`Settled:` from the agent". The watch is built:
  with `review` on, the weekly job labels and comments on each open decision
  the routine reviews (one an owner or agent wrote and last edited, not
  `veto` or already `needs-owner`) whose `Review:` date is more than seven
  days past with no `Kept:` or `Settled:` from an agent since that date; it
  takes off only a `needs-owner` it added itself (the issue's last such
  label event is the workflow's), once an agent's verdict comes after it,
  so the routine's holds and the owner's vetoes stay. Since `needs-owner`
  would hide the decision from the routine, `reviews-due` still lists one
  the job labeled until the agent comments on it, so a hold is not asked
  again. Only an agent's comments count as verdicts, wherever they are read;
  `reviews-due` read none before. Creating the routine is not built:
  Claude's routines (`/schedule`, the `RemoteTrigger` tool) call claude.ai's
  `/v1/code/triggers` with the Claude Code session's own sign-in, which a
  command such as `onboard` cannot reach, and a routine works as claude.ai's
  GitHub connection, which nothing reports and which the owner has not yet
  switched to the agent (P-22 is unproven in a cloud session). So `onboard`
  prints the steps and the prompt's link, and creating or checking the
  routine waits on P-22's proof.
- **2026-11-01 — Record: P-44, Claude Code is the only supported agent
  runner.** The owner decided on #50 on 2026-10-31: "Athya's agents run in
  Claude Code only. Deferred: the README names Claude Code as the only
  supported agent runner, and this stays open for adoption outside Athya."
  The README never said so; it now does, beside the supported host. The
  identity and the lock reach a session only through Claude Code's
  SessionStart hook and `CLAUDE_ENV_FILE`, so another tool's agent gets
  neither, and only PR identity catches its work after the push. #50 stays
  open.
- **2026-11-05 — Record: P-25, `reviews-due` reads only REST.** The
  routine's first run, in a Claude cloud session, stopped with "cannot read
  who edited the decisions (HTTP 403)": `reviews-due` asked GraphQL for each
  decision's last editor, and the cloud session's GitHub proxy refuses
  GraphQL. REST has no such field: an issue names its author, not who last
  edited its body, and a body edit leaves no event in the issue's events or
  timeline (a title edit leaves `renamed`). Fixed as State #140. The weekly
  job, whose token reads GraphQL, now vets: for each open decision with a
  `Review:` date that an owner or an agent wrote and last edited, it keeps
  one comment of its own naming the body's SHA-256, posted once and edited
  when the hash changes. It hashes the body GraphQL returns with the editor,
  so an edit landing between the job's listing and that read is not vetted
  under the earlier editor. `reviews-due` still checks the author, and lists
  a decision only when the workflow's latest such comment names the hash of
  the body it reads; REST and GraphQL return the same bytes for a body. A
  label the job adds, trusted while the issue's `updated_at` is not later,
  was weighed and dropped: every comment and label moves `updated_at`, the
  routine's own included, so it would wrongly hide decisions, and it cannot
  tell a body edit from a comment. The hash ties the vetting to the text
  itself: someone else's edit changes the hash, so the decision is left out
  until the job sees an owner's or the agent's edit; an edit that puts back
  the vetted text exactly leaves only vetted text. Only the workflow writes
  as `github-actions[bot]`, so a pasted mark counts for nothing; someone
  who can edit the workflow's comment can also change the workflow, so the
  vetting trusts no more than the job already did. A decision written or
  edited since the job's last run waits up to a week for its next one, and
  `reviews-due` names it.
- **2026-11-05 — Record: agent sessions turn Auto-fix on themselves, #142
  of P-42.** The owner saw Auto-fix off on the agent's pull requests and
  asked for it on. #137, #139 and #141 opened with it off although the
  desktop app's `gh` login was the agent's and the app had restarted since
  the login moved. The app turns Auto-fix on for a session's new pull
  request only once its renderer says the owner wants it for that session,
  and the renderer says so only while that session is open on screen; the
  slice sessions a coordinator starts in the background are not, and no
  Code tab setting changes that. So session-start's line for a local agent
  session tells it to turn Auto-fix on with `set_monitor` after each
  `gh pr create`, when the app's `ccd_pr` tools are there and `get_status`
  shows it off. `set_monitor` checks that
  the session opened the pull request and that the app's `gh` login wrote
  it, so a session can do this only for the agent's own pull requests. A
  cloud session has no such switch, and its line is unchanged.
- **2026-11-05 — Record: P-35, onboard names the owner to sign in as and
  why a request failed.** In the sandbox's onboard the sign-in line said
  only "as the owner", and the run then ended with "process-rules onboard:
  fetch failed": Node's message for a request that got no answer, whose
  reason fetch keeps in `cause`, which the CLI dropped. Minutes later the
  same requests answered, so it was most likely a passing network failure,
  but nothing told it apart from a blocked host. Fixed as State #145. The
  sign-in line names the owner, or each owner the settings list while the
  run has not chosen one, and says that `gh`'s lines about saving
  credentials mean the temporary folder deleted before onboard goes on.
  `http` names a request that got no answer by method, host and path, never
  its query, with the cause's code and message. GET, PUT and DELETE are
  tried once more a second later, since repeating one changes nothing more;
  POST and PATCH are not, since a request that reached GitHub before the
  connection broke could then be made twice. One deadline covers both
  tries, and a timeout keeps its own error and is not repeated, so a
  caller's time budget holds. A label's removal counts a 404 as done, since
  a repeated DELETE after one whose answer was lost finds it already off.
- **2026-11-05 — Record: onboard keeps CODEOWNERS, reversing P-33's
  offer.** The owner, in chat: "Don't remove the CODEOWNERS in the
  onboarding." This reverses the 2026-11-01 record for P-33. The owner
  prefers to be asked to review the agent's pull requests, and the repo's
  own rules (its branch protection or rulesets) decide whether that review
  is required, so `onboard` no longer offers to remove the owner from
  CODEOWNERS, `doctor` no longer warns about such a rule, and the
  CODEOWNERS files leave the list of files onboard writes: a pull request
  from onboard's branch that changes one is held to the work rules like any
  other. Fixed with State #153 of P-04.
- **2026-11-05 — Record: P-04, onboard asks once, from one plan.** The
  owner ran onboard in a client and found it too complex: about eight y/N
  questions, each a long sentence, with a browser sign-in in the middle, and
  output they did not read. Its pull request's title, "process-rules
  onboard at v0.5.19", failed that client's commitlint. The owner approved
  the layout this State (#153) builds. `onboard` now works out every change
  first, changing nothing, prints one plan grouped by where each change
  lands (the pull request you merge, GitHub as you, this Mac, the check),
  with short labels and only what changes, and asks once; the long
  explanations move into the pull request's description. `--yes` skips the
  question and `--dry-run` stops at the plan; with no terminal and no
  `--yes` it refuses rather than read an answer from a pipe. The browser
  sign-in comes after the yes, except where only it tells what the plan is
  (which of several owners ran it, or whom to suggest as the owner on a
  first run), which the pull request then says. What the board lacks is
  known only to the owner's token, so the plan says "set up or check", and
  the one yes covers every board step but replacing a Project made before
  the template, which moves its items and closes it: that is left as it is,
  with the template's grouping and auto-archive under "By hand:". `gh`'s
  output during the sign-in is read rather than shown: with it not a
  terminal, `gh` prints the one-time code and link instead of asking for
  Enter, so onboard shows the code and opens the link, drops `gh`'s tips
  and notes about its temporary folder, and shows any other line as `gh`
  wrote it, so an error still reaches the owner. The confirm and spinner
  come from `@clack/prompts`, loaded only by onboard, since the shared
  checks run the CLI from source with no packages installed; colour shows
  only on a terminal that has it, never with `NO_COLOR`. The title and the
  commit read `chore(process-rules): onboard at v<version>`, which
  Conventional Commits accepts. The owner, in chat, also chose that the pull
  request merge itself: "I prefer this for onboard step." So the agent,
  which can push, turns on GitHub's auto-merge for it through GraphQL's
  `enablePullRequestAutoMerge` (REST has no call for it), squashing where
  the repository allows it, else rebasing, else merging; onboard runs in
  the owner's terminal, where GraphQL is reachable. The plan names it in the
  pull request's group, "auto-merge when checks pass", and the run ends
  "<url> merges itself when checks pass". Not turning it on fails nothing:
  where the repository does not allow auto-merge, or GitHub refuses it, as
  it does for a pull request already clean to merge, the run ends "Merge
  <url>" and "By hand:" says why. A setting GitHub does not report is not
  taken as off, so GitHub's own refusal says why then.
- **2026-11-05 — Record: P-02, machine and doctor in onboard's layout.**
  The owner liked onboard's one plan and one question, then ran `machine`,
  which still asked a y/N question per change and ended with long ✓/!
  lines. They asked for `machine` and `doctor` to look the same ("Yes,
  both"). State #156 builds it. `machine` now works out every change first,
  changing nothing, shows one plan (This Mac, GitHub as the agent), and asks
  once, with `--yes` and `--dry-run` as in onboard. With nothing to change it
  asks nothing. The lockout's sign-outs are plan items like the rest, so the
  one yes covers them and a no leaves everything as it was. machine no
  longer declines them one at a time, so it no longer writes
  `lockout-declined.json`. `doctor` still honours a record an older release
  wrote, and `machine` removes it once it locks them away. A stored token
  near its end is replaced on the yes rather than asked about separately.
  The classic token's page and hidden paste stay steps after the yes, since
  only the owner can make the token. What is worth fixing after the run (a
  key with no passphrase, a sign-out that failed, the owner's steps after a
  `gh` move) becomes a `▲` line with its one-line fix; why a stored token is
  replaced shows as a `!` note in the plan's head, as onboard's warnings do. `doctor` stays read-only and asks nothing. It groups its
  checks, marks each ✓, ▲ or ✗ with a fix, and keeps its checks, exit codes
  and the 14-day warning. It now prints them all on standard output as one
  picture. The layout lives in `src/layout.ts`, which all three commands
  share.
- **2026-11-06 — Record: cloud setup shares the Setup field, and says when
  it drifts.** A client's cloud environment held only `cloud-setup`'s
  script in its Setup field, which holds one script, so the repo's own
  setup never ran and sessions came up on the image's Node without the
  repo's tools. The owner then pasted both, with process-rules' install
  wrapped in a shell of its own followed by the repo's own script, which
  ends with `exit 0`; it worked. The field had also installed an older
  release than the repo's workflow pinned, and nothing said so.
  `cloud-setup` now prints its install inside `bash <<'PROCESS_RULES' …
  PROCESS_RULES || echo … >&2`, so its `set -euo pipefail` and a failed
  download stay in that shell and the commands after it run; it, `onboard`
  and the README say to put it first, then the repo's own, because a repo's
  script may end with `exit`. The install's last command reads
  `/dev/null`, as the rest of its script is on standard input. In a cloud
  session `session-start` compares the installed CLI with the one version
  `.github/workflows/process-rules.yml` pins and, when they differ, says so
  in a second line naming the fix: print `cloud-setup` again from that
  version and paste it over the process-rules part. It only warns: the
  agent check, the record for the guard and the exit code are unchanged,
  and a missing or unreadable workflow, or one pinning no single version,
  says nothing, as `onboard` and `doctor` own the workflow itself.
- **2026-11-06 — Record: Figma frames are for Experience work only.** A
  client's design check refused a Process slice because one of its States, a
  step of process work with nothing to draw, linked no Figma frame. The
  client's Work items name their kind in a `**Kind:** <Kind>.` line
  (Experience, Process and others). The design check now reads the slice's
  parent Work item with its States, in the same GraphQL query, and a kind
  other than Experience passes the slice with one `✓` line and no Figma
  call. Experience work, a Work item that names no kind, a slice with no
  parent and one whose parent is not a Work item are checked as before, so
  the check fails closed where no kind is named. The line is read bold or
  plain and case-blind; the Decision parser in `src/decisions.ts` reads only
  the plain `Kind:` form and the whole line, so the design check keeps its
  own reader.
- **2026-11-06 — Record: onboard sets up cloud sessions, with one paste
  (State #165 of P-22).** The owner asked whether `onboard` should set up
  cloud sessions too: every release meant pasting `cloud-setup`'s output
  again, as it named a version, and a client's Setup field had stayed at
  0.5.19 while its workflow pinned 0.5.20. Claude Code has no API, CLI or
  repo file for a cloud environment's Setup script (its cloud environments
  docs: it is edited in claude.ai's environment dialog alone), so `onboard`
  cannot write the field. Instead the version moves into a file the repo
  owns: `onboard` writes `.github/process-rules/cloud-setup.sh` at the
  version the workflow pins, on every run, with the CLI's download checked
  against the sha256 GitHub records for the release archive, as Node's
  already is; and `cloud-setup` prints a snippet naming no version, which
  runs that file from the clone, so the field is pasted once. A client's
  own cloud work found the Setup script runs as root once the repo is
  cloned, from the VM's home, with the clone one folder down; the snippet
  looks there, in the clone and in each home. The docs say Claude keeps a
  snapshot of the environment and builds it again only when the Setup
  script changes or after about a week, so a stable paste alone would
  leave sessions on the old CLI after a pin bump: a cloud session's
  `session-start` runs the repo's file itself when its CLI is another
  release, and says so. Each release unpacks into a folder of its own, so
  the CLI that runs the install is not deleted under it. The snippet marks
  its run in `/opt/process-rules/from-setup`; without the mark, the field
  still holds an older paste, and the line asks for the one paste. Its
  warnings now say to run `onboard` again, not to paste again. The onboard
  pull request's work-rules pass, for the files onboard writes, covers the
  new file. Rejected: a SessionStart hook alone (the docs keep tool
  installs in the Setup script, which the snapshot caches), and a stamp
  that asks for a re-paste (what a client built for itself, which still
  needs the owner after each release).
- **2026-11-06 — Record: onboard keeps refusing a Mac `machine` has not
  set up.** Asked whether `onboard` should offer the `machine` step in its
  own plan instead. It should not: `machine` asks for the agent's classic
  token, pasted hidden, from a token page the owner opens signed in as the
  agent, then makes the agent's signing key and registers it, and asks its
  own questions about the owner's `gh` logins and git password; `onboard
  --yes`, or a run with no terminal, can answer none of these, and its one
  plan holds one yes. `machine` works once per Mac and agent account and
  needs no client repo (2026-10-30), while `onboard` is per repo. Both stay
  the owner's: `onboard` refuses in an agent session, and only the owner
  holds the token and the key. So `onboard` refuses as before, and now
  names what is missing (no token stored, the token's problem, or the
  key's), then the `machine` command to run.
- **2026-11-07 — Record: onboard's pull request fits gitmoji titles and a
  Mergify queue.** The owner ran `onboard` in a client whose pull request
  titles must lead with a gitmoji and which merges through Mergify. Its
  pull request, `chore(process-rules): onboard at v0.5.24`, failed that
  repo's title check and was renamed by hand, as earlier onboard pull
  requests there were; and the run told the owner to turn on GitHub's
  auto-merge, which the repo keeps off because Mergify's queue merges
  instead (it merged that pull request by itself). Now, before it commits,
  `onboard` reads the default branch's latest 20 commit subjects as the
  agent. Where most of them (merge commits aside) lead with an emoji or a
  gitmoji shortcode, the title and the commit do too: the one an earlier
  onboard commit had, else the one the repo puts most on `chore`, else
  `🔧` (`:wrench:` where shortcodes are the style). The rest of the title
  stays Conventional Commits. Where the default branch's Mergify
  configuration, read as the agent from GitHub (a checkout may be behind)
  and the first of `.mergify.yml`, `.mergify/config.yml` and
  `.github/mergify.yml` it has, as Mergify reads only that one, has a
  queue rule and queues pull requests by itself (a pull request rule whose
  actions hold `queue`, or merge protections' `auto_merge_conditions`,
  either asking for no label; the queue rules' `autoqueue`, which Mergify
  replaced with `auto_merge_conditions`, does not count), the plan says
  "merge queue Mergify, when checks pass", GitHub's auto-merge is neither
  turned on nor asked for (it could merge around the queue), and the run
  ends "<url> the merge queue merges it when checks pass". Rejected: a
  setting in `process-rules.json` for the title's emoji (the repo's history
  already says it, and a setting is one more thing to keep in step), and
  reading the repo's title-check workflow (each repo writes its own). The
  configuration is parsed with the `yaml` package, which onboard alone
  loads, as it does `@clack/prompts`; a line scan missed YAML's other
  forms.
- **2026-11-07 — Record: doctor checks a Claude cloud session (State #171
  of P-22).** A cloud session ran `process-rules doctor` to check its
  environment and got only "process-rules supports macOS only", exit 1,
  while every other cloud check passed; the owner asked for doctor to be
  useful there. Where `CLAUDE_CODE_REMOTE=true`, the test session-start and
  `as-agent` use, doctor now runs cloud checks before it looks for a token
  store, in the same grouped layout, fixes and exit codes: the release the
  cloud setup file's opening comment names against the workflow's pin
  (`✗`, run `onboard` again, as session-start's drift line says), the running CLI against that release
  (`▲`: session-start installs the repo's release itself when they differ,
  so a drifted CLI here means that install failed), the Setup snippet's
  `/opt/process-rules/from-setup` mark (`▲`, paste the snippet once), the
  account the proxy acts as among the settings' agents and the
  `PROCESS_RULES_AGENT` session-start exports when it lifts the lock, which
  must be that same account (`✗` each: GitHub is locked out or someone
  else's), and the repo's hooks as on
  a Mac. The pin and the file are read by one function session-start's
  drift check shares. Doctor installs nothing, as it only reads; the fix
  for a drifted CLI names `bash .github/process-rules/cloud-setup.sh`.
  Rejected: a Linux token store (a cloud session has no token of its own,
  only the proxy's), and lifting the refusal on every Linux (outside a cloud
  session nothing holds the agent's token, so the refusal stands).
- **2026-11-08 — Record: an ask reaches the owner as a page, and the Needs
  you list keeps itself (State #176 of P-40).** The owner approved athya_mono's
  0156 S-2 (athya_mono#3301, decision 3) to be built here: since 24 Oct, 41 of
  43 `Proposal:` comments there linked no page. The guard, which already sees
  every `gh` command, reads the comment bodies `gh` posts (inline, heredoc,
  `$(cat file)`, `--body-file`, `gh api` fields and `--input`) with a small
  shell reader, and refuses an ask over 500 characters or without a
  claude.ai artifact link. A body it cannot read in full is judged by what it
  spells out, so a variable in an ordinary comment still passes; only an ask,
  or a body that opens with the unknown part, is refused. `propose` is left
  alone: it posts through the API. The label job is a fourth client job,
  started only by comments that contain an opening word, the `approved`
  label and an hourly cron (`41 * * * *`), so other comments run nothing; the
  weekly job and the shared decisions job skip that cron. The sweep reads
  only 👍 and `Decision:` after the latest agent ask, leaving issues with no
  agent ask (undo issues) alone. Rejected: a separate client workflow file
  (onboard would track two files), and refusing every body with a variable
  (it would block routine comments).
- **2026-11-08 — Record: an edited `Decision:` counts only if owners made
  every edit (State #185 of P-40).** The owner approved this in a client's
  spec: a `Decision:` counts only if the owner made every edit. Repo writers,
  agents included, can edit anyone's comment, and the work rules and the
  Needs you sweep read only who wrote one. GitHub's GraphQL
  `userContentEdits` lists every revision, the comment as written included,
  each with its editor; public repositories show a bot's comment edited by
  two maintainers in turn, each named. So both read it, for an owner's edited
  `Decision:` alone: an unedited one settles as before, through REST, and the
  work rules ask GraphQL nothing when an unedited decision or a request
  settles the slice. An edit by a deleted account, an edit past the first
  100, or a comment GraphQL cannot find makes it not count. The work rules
  read REST, and GraphQL only for an edited `Decision:`, so a Claude cloud
  session's proxy, which refuses GraphQL, can still run them; there an
  edited `Decision:` does not count and the refusal says why, as an edited
  request already does not. Rejected: never counting
  an edited `Decision:` (the owner's own corrections would stop counting) and
  trusting the last editor alone (an agent's edit followed by the owner's
  would hide the agent's).
- **2026-11-08 — Record: one comment on the Approvals issue answers a batch
  (State #191 of P-40).** The owner approved this in a client's spec
  (decisions 1 to 3): after answering 18 asks across 11 Work items one at a
  time, one comment should answer them all. Settings may name a standing
  Approvals issue (`"approvals": N`); an owner's comment there whose first
  line opens `Decision: approve` approves each `#N` on that line, and
  nothing below it, so a reason such as `Not #44 yet` approves nothing. The
  work rules take it for a slice added after approval (made after the
  addition) and for a dropped State (made after the drop); the Needs you job
  takes `needs-owner` off each named issue at once, and its sweep counts it
  after an issue's latest ask. The edit rule of State #185 holds for it.
  Only the one issue counts, so the readers read one more list, once a
  check or sweep. Rejected: each batch's own ask issue (every proposal would
  have to name it, and the readers follow that link), counting a number
  anywhere in the comment (a reason naming an item would approve it), and
  teaching the Needs you job alone (the push check would still want one
  comment per Work item).
- **2026-11-08 — Record: the checks run their own commit's CLI (State #195
  of P-11).** Each client job pins the release twice, `checks.yml@vX` and
  `process-rules-ref: vX`, and Dependabot and Renovate move a reusable
  workflow's `uses:` line alone: Dependabot's #168 moved this repository's
  three `uses:` lines to v0.5.24 and left `process-rules-ref` at v0.5.19, so
  v0.5.24's checks would have run the v0.5.19 CLI, every check green. A
  called workflow can now read its own commit: GitHub's `job.workflow_sha`
  and `job.workflow_repository`, which GitHub's docs use to check out a
  reusable workflow's own source and its own `github/gh-aw` uses. So every
  job of `checks.yml` checks the CLI out there, falling back to
  `process-rules-ref` where GitHub gives no `job.workflow_sha`: GitHub
  Enterprise Server, which has neither, or, should it ever be empty there,
  github.com, where Settings then warns that it cannot compare the two;
  and Settings, which runs on every event, fails a run whose
  `process-rules-ref` names another release (by version, or by commit for a
  commit pin), naming the client's file and the fix. A bot's bump is still
  never a whole upgrade: it misses the cloud setup file's pin and any job a
  newer release adds (this repository's v0.5.19 file had no needs-owner job),
  so the upgrade stays `onboard`, its Dependabot here ignores
  `athya-hq/process-rules`, and the README tells clients to do the same.
  actionlint 1.7.12 does not know `job.workflow_*` yet
  (rhysd/actionlint#707), so `.github/actionlint.yaml` ignores that one
  error in `checks.yml`. Rejected: one pin per job, the `process-rules-ref`
  line dropped (every client file onboard repins counts two per job, so it
  is its own onboard change, once clients run a release with this check);
  passing a mismatch with a warning (no one reads a green run's warnings);
  and only `doctor`, whose cloud checks already show ▲ for a workflow that
  pins several versions but which runs in a session, not on the bot's pull
  request.
- **2026-11-08 — Record: P-46, `process-rules upgrade` updates the CLI in
  one step (#192).** The owner, in chat: "Shouldn't it be simple like
  `process-rules upgrade`?" Updating meant copying the README's `pnpm add -g`
  line for the right version; the owner's second Mac kept v0.5.20 for days,
  and an `onboard` run from it overwrote an athya_mono pull request's newer
  pin. Decided: `upgrade` reads GitHub's public `releases/latest` with no
  token (the repository is public, as the install line already relies on),
  installs a newer release with that same `pnpm add -g`, never an older one,
  and then walks `PATH` as `type -a` does, exiting 1 while another copy is
  there or the first is not the new release, since a stray older copy is how
  the old release kept running. `doctor` on a Mac gains the same two checks;
  `onboard`'s refusal of a newer pin names `upgrade`. It may run in an agent
  session on a Mac: it needs no credential, never signs in, only moves
  forward to a release the Release workflow published from `main`, and does
  what the owner would do by hand, so an agent finishing a release can
  update the Mac without an owner step; the guard still governs `gh` and git
  around it. It refuses in a Claude cloud session, where the CLI comes from
  the repo's `cloud-setup.sh` at the workflow's pin, not from pnpm. GitHub's
  "latest" is the newest release by date, which is the highest version while
  releases are tagged in order from `main`. Rejected: comparing against the
  repo's pin instead of the newest release (a Mac would stay behind until a
  repo moved), and warning about stray copies without failing (the owner
  would miss it, as before).
- **2026-11-09 — Record: Needs you judges each proposal on an issue (State
  #205 of P-40, from #203).** `propose` posts one `Proposal:` per decision a slice owes
  (its late addition, each dropped State), and the batch line names each by
  its own number, as the work rules read them; the Needs you job judged only
  an issue's latest ask, and its comment event took `needs-owner` off
  whatever numbers a batch named. So a batch naming a dropped State cleared
  nothing, and one naming the slice cleared it while the State's proposal
  still waited. The sweep, and now the comment event on Approvals, judge
  each agent `Proposal:` on its own, for the first `#N` of its first line
  (this repository's, HTML entities not counting, as `approvedIn` reads
  them; the issue itself when it names none): a `Decision:` after it, a 👍
  after its last edit, or a batch naming its number after it. The label
  comes off only when every one is answered. A `Needs you:` keeps the old
  rule: owed when it is the latest ask. The comment event cannot map a
  State's number to its slice from the batch alone, so it runs the sweep,
  counting the comment it brings though the list may not show it yet; an
  issue no agent asked on still comes off when the batch names it.
  Rejected: matching only the latest proposal's number (#202, reverted:
  it cleared a slice while another proposal there waited).
- **2026-11-09 — Record: Needs you counts a re-added slice's answers after
  its re-addition (State #207 of P-40).** The work rules count the owner's
  say on a slice's addition only after its latest addition; `propose` posts
  no new proposal when one exists, so a slice taken out and added again
  keeps its old one. The sweep counted a 👍 on it from before the
  re-addition and took `needs-owner` off while the work rules still owed
  the decision (Cubic, on #206). Now a proposal for the issue itself counts
  a `Decision:`, a 👍 or a batch answer only after the issue's latest
  `parent_issue_added` event in its own timeline, read only when such a
  proposal waits, none where GitHub cannot find it. A State's drop and a
  `Needs you:` keep their own times. The work rules also count the work
  item's `sub_issue_added` events that name no issue (a private
  repository's workflow token reads them so); the sweep reads only the
  slice's own events, which that token reads in full. Rejected: running the
  work rules' reader on each labelled slice (a dozen reads more a slice an
  hour, and its problems, such as an unapproved work item, are not the
  owner's answer).
- **2026-11-09 — Record: doctor names only hooks that really miss
  `as-agent` (State #211 of P-43).** After the owner rotated the agent's
  token, `doctor` in the first client passed every Mac and GitHub check but
  warned about two hooks that do not hit the lock on a Mac: one runs `gh`
  only through a Python helper whose `wrap` runs `as-agent` (doctor matched
  a variable named `gh` and messages naming `git push`), and one exits
  outside the cloud before it fetches. A warning that never goes away is
  skipped, so a real one would be too. `hooksHittingLock` now takes a script
  that imports a repo Python module running `as-agent` as routed, finding
  the module with `git ls-files` under any folder, since a hook sets its own
  `sys.path` (`from a import b` may be `a.py` or `a/b.py`), still judging
  the hook's own command; and, outside a cloud session, reads a script only
  up to a column-0 line that exits unless `CLAUDE_CODE_REMOTE` is `true`,
  when only lines that open no block (`set`, `export`, `.`, assignments, not
  continued) come before it. That cut is sound for bash: such a line always
  runs, nothing after a top-level exit runs, and a function must be defined
  before it is called. In a cloud session the whole script
  is judged, as before, since that is where it runs. Rejected: dropping
  string literals (a command handed to code as a string is still a call);
  a marker comment that silences a hook (it asserts instead of reading);
  following `in_cloud`-style functions into sourced files (the client moves
  the guard to the top instead).
- **2026-11-09 — Decision: release numbering.** The owner set it in chat:
  each release bumps the patch number up to 20 (0.6.0, 0.6.1, … 0.6.20),
  and the release after x.y.20 is x.(y+1).0, so 0.6.20 is followed by 0.7.0.
  The major number moves only when the owner says so. 0.6.0 starts the rule,
  with the code of 0.5.38. This replaces the rule of 2026-10-31, "0.5.x patch
  releases only", which came after sessions bumped the minor number four
  times in a day. Recording it here rather than only in agent memory means
  every session reads it with the code. Slice pull requests still never bump
  the version: one release pull request per batch does, and its tag must
  match `package.json`.
- **2026-11-09 — Record: `git remote` reaches GitHub only where it contacts
  the remote (State #219 of P-17).** `reachesGitHub`, shared by the guard and
  `doctor`, counted every `git remote` as reaching GitHub, so `doctor` named a
  hook running `git remote get-url origin`, which reads `.git/config` only,
  and the guard refused it in sessions not working as the agent. The owner
  asked for it fixed. Now only `update`, `prune`, `show`, `add -f`/`--fetch`
  and `set-head -a`/`--auto` count. P-17 is unchanged: every command that
  contacts a remote still runs only as the agent; what the guard now lets
  through contacts nothing. `show -n`, and `add` whose last fetch flag is
  `--no-fetch`, do not count either (review). Rejected: a doctor-only list
  (the guard and doctor would disagree on what reaches GitHub).
- **2026-11-10 — Record: a merged pull request closes the State it names
  (State #224 of P-07).** Five States stayed open after the pull requests
  that delivered them merged: #176 (#177), #171 (#172), #161 (#162), #198
  (#199) and #195 (#196), each shown in the owner's Needs you view until the
  coordinator closed it by hand. Each was a fix filed, as the README says, as
  a State under a slice closed already; each pull request named the slice
  with `Slice: #N` and the State only in prose ("Builds State #176 of
  P-40"), so the merged job commented on the closed slice and nothing named
  the State. Now a pull request names each State it delivers with a line
  `State: #N`, and the merged job closes each one under a slice it names as
  completed, with the slice's "Built in #PR" comment. The work rules refuse a
  `State:` line naming anything but a State under the slice, and an agent
  pull request for a closed slice that names no open State of it, so a fix
  cannot merge with its State unnamed. That is a new refusal on every
  adopting repository's agent pull requests for closed slices; the README
  already filed every fix as a State, so it asks for one line more. Only the
  pull request's description carries `State:` lines: pre-push reads commit
  trailers for the slice alone. Rejected: closing every open State of the
  named slice on merge (a slice often has States not built yet, filed ahead,
  and one pull request delivers one); reading States from prose (the five
  wrote it five ways); relying on "Closes #N" (nothing checks it is there,
  and it closes any issue, not only a State of the slice).
- **2026-11-10 — Record: process-rules becomes niyam (P-49).** The owner
  chose the name niyam (नियम, rule) on 2026-11-03 and said go on 2026-11-10;
  athya_mono's approved 0114 spec v5 holds it as W-39
  (athya-hq/athya_mono#3210): the repository moves to veda-hq/niyam and the
  package is `@veda-hq/niyam`. The owner approved the plan
  (https://claude.ai/artifact/HEQyFtZsxHKDLrt6GqQtEq) with a 👍 on #226, on
  #227 (P-50, which changes what P-17's lock reads) and on W-39. What people
  see is renamed: the package, the bin `niyam` with `process-rules` kept as a
  second bin (typed by the owner, it names `niyam`; hooks stay quiet), the
  messages, the README and the shared workflow's default repository. The
  workflow pin `onboard` writes is `veda-hq/niyam/.github/workflows/checks.yml`,
  and a pin of `athya-hq/process-rules` counts and is moved. What adopters'
  committed files and hooks name stays: the hook commands and launcher, the
  lock's text, `~/.config/process-rules`, `PROCESS_RULES_AGENT`,
  `.github/workflows/process-rules.yml` and its job ids (so the required
  checks keep their names and no ruleset changes), `process-rules-ref` and the
  cloud setup path (no new Setup paste). P-50: the keychain service is
  `niyam` and the settings file `.github/niyam.json`, each read first, the
  old one where it is missing; `machine` copies the token and leaves the old
  entry, `onboard` keeps a repo's existing settings file, and a session file
  an older release wrote, which reads the old entry, still counts (`doctor`
  marks it ▲). Releases attach the CLI twice: `veda-hq-niyam-<v>.tgz`, and the
  same build named `@athya-hq/process-rules` as `athya-hq-process-rules-<v>.tgz`,
  since 0.6.x's `upgrade` looks for that name and pnpm refuses a second global
  package with the bin `process-rules` (tried with pnpm 12.9.0). That bridge
  replaces the old package in place; `niyam upgrade` then removes it and adds
  `@veda-hq/niyam`, putting the old one back if the add fails. `upgrade`
  asks veda-hq/niyam for releases and athya-hq/process-rules on a 404, so it
  works before and after the transfer. Rejected: renaming the job ids, the
  workflow file, the cloud path and `~/.config` now (each needs every
  adopter re-onboarded, the job ids a ruleset edit in the same hour; a later
  slice); publishing to npm now (tarballs as before; its own slice).
- **2026-11-10 — Record: the lock reads niyam names, old ones too (P-50).**
  The owner approved #227 with a 👍 on its own, since the keychain service and
  the settings file are what P-17's lock reads. The agent's token is stored
  under the keychain service `niyam`; a token found only under
  `process-rules` is still read, and `machine` copies it to `niyam`, leaving
  the old entry for older CLIs on the Mac; while that entry is there, a token
  `machine` stores goes under both names, so an older CLI never reads one it
  replaced (review). The session file now reads
  `niyam`, then `process-rules`; one an older release wrote, which reads the
  old entry alone, still counts for session-start and as-agent, and `doctor`
  marks it ▲ until `machine` rewrites it, so no session locks out after the
  upgrade. The settings file is `.github/niyam.json`; session-start, the
  guard, as-agent, doctor, the work rules and the shared checks read
  `.github/process-rules.json` where it is missing, and name the file they
  read, and the workflow's schedule comment names the file in use. `onboard`
  writes `.github/niyam.json` in a repo that has neither and
  keeps an existing `.github/process-rules.json`, which an older CLI on
  another Mac still reads. Nothing else in P-17 or P-18 changes: the lock's
  placeholder token, the SSH refusal, `~/.config/process-rules` and
  `PROCESS_RULES_AGENT` stay. Rejected: moving the token (an older CLI would
  lose it); renaming an adopter's settings file now (an older CLI's
  session-start would lock out).
  cloud setup path (no new Setup paste). The keychain service and the settings
  file are P-50's, which the owner approves on its own. Releases attach the
  CLI twice: `veda-hq-niyam-<v>.tgz`, and the same build named
  `@athya-hq/process-rules` as `athya-hq-process-rules-<v>.tgz`, since 0.6.x's
  `upgrade` looks for that name and pnpm refuses a second global package with
  the bin `process-rules` (tried with pnpm 12.9.0). That bridge replaces the
  old package in place; `niyam upgrade` then removes it and adds
  `@veda-hq/niyam`, putting the old one back if the add fails. `upgrade` asks
  veda-hq/niyam for releases and athya-hq/process-rules on a 404, so it works
  before and after the transfer. Rejected: renaming the job ids, the workflow
  file, the cloud path and `~/.config` now (each needs every adopter
  re-onboarded, the job ids a ruleset edit in the same hour; a later slice);
  publishing to npm now (tarballs as before; its own slice).
- **2026-11-10 — Record: an organisation's enabled issue types are the work
  model's alone.** The agent filed an issue as Task, one of GitHub's default
  types, which `onboard` never touched, and it showed on the owner's Needs
  you view with a type outside the work model. The owner asked for a proper
  solution, not only turning the defaults off: issues holding another type
  must be handled, and `onboard` must see to it in every organisation. Now
  `onboard`'s issue types step adds or enables the work model's types, gives
  each issue holding any other type, in every repository of the
  organisation, a work model type (a sub-issue of a Work item a Slice, an
  issue with sub-issues a Work item, any other a Brief), and then disables
  the other types, all under the plan's one yes, as the owner. It disables
  (`PUT /orgs/{org}/issue-types/{id}` with `is_enabled: false`, sending the
  type's name, description and colour back, since the PUT takes them all)
  rather than deletes: GitHub's documentation says a disabled type is not
  shown and cannot be set, and shows again on its issues when enabled, but
  does not say what deleting one does to them. Retyping first leaves no
  issue holding a disabled type, which would hide it. It finds the issues by
  listing each repository's issues with `type=`, open and closed, not by
  search, which caps results at 1000 and lags its index; it keeps only rows
  GitHub shows holding the type, so a filter GitHub ignored retypes nothing.
  An issue in an archived repository, which GitHub keeps read-only, keeps
  its type, and that type stays enabled until the owner unarchives it and
  reruns. Where a type outside the work model exists, the owner signs in
  before the plan, since the agent sees only the repositories it can read,
  and the run changes nothing beyond the plan shown (review). `doctor` warns
  when an enabled type outside the work model, or a missing work model type,
  appears again. Rejected: deleting the types
  (unknown effect on issues, no way back); search (capped, lagging);
  retyping as the agent before the owner's run (the owner approves the
  organisation-wide change once, from one plan); typing the issues with no
  type at all (another question, for the owner).
- **2026-11-10 — Record: `propose` posts a pointer to a page (State #236 of
  P-40).** The owner approved it with a 👍 (page
  https://claude.ai/artifact/UKSecSCvue9yfwcbA9nHGP): on 10 Nov, all four
  proposals `propose` posted in the first client ran 716 to 2,134 characters
  and linked no page, which the guard refuses for any other ask, and one had
  to be cut by hand. A proposal is now three lines: what it proposes (the
  first `#N` still names the issue, which the 👍 matching relies on), `Page:
  <url>` from a required `--page`, and how to answer. The body is checked
  with the guard's own `askProblem` before anything is posted, so the two
  cannot drift apart. One page per run, a batch included: one page argues a
  batch, and every comment then carries its link. A run that only links
  proposals already posted needs no `--page`, so re-running to relabel or
  print the batch line still works. The slice must still have its "You will
  see" and "Why" sections, which the page is written from. Rejected: cutting
  the old body to 500 characters (it still argues in the comment and links
  no page); reading the page link from the slice body (a page link in a
  slice is evidence, not the ask's page).
- **2026-11-10 — Record: open issues with no type get one.** The record
  above left issues with no type at all as another question for the owner,
  who answered it: 38 open issues across athya-hq had none (sub-issues of a
  Work item, coordinator notes, chat approval records, the monthly secret
  rotation reminders athya_mono's own workflow files, old bugs), and the
  owner wants them typed as a proper solution, in the same run. Now
  `onboard`'s issue types step also lists each repository's open issues with
  `type=none` and types them by the same rule, under the plan's one yes, which
  gains one more fact: a sub-issue of a Slice is a State. Closed issues with
  no type are left as they are, as the plan says. A repository's Approvals
  issue, named by `"approvals"` in its settings on the default branch, keeps
  no type, as the plan says: a standing record, never closed, that no work
  model type fits, and one the work rules find by number. The plan now shows
  every issue it types, consecutive ones typed alike on one row, rather than
  the first ten. To keep them from coming back, the client workflow's
  `process-rules-asks` job, which already has `issues: write`, also starts
  on an issue opened or reopened (unless the client changed its `issues:`
  trigger, which `onboard` leaves as it is), and the shared workflow's new
  `Issue type` job runs `niyam issue-type`, which types an issue with no
  type by the same rule. GitHub starts no run for an issue a workflow's own
  `GITHUB_TOKEN` opens, as athya_mono's reminder workflow does, so the job
  also runs on the asks job's hourly cron and types every open issue there
  with none. The `needs-owner` job now runs on the `labeled` issue event
  alone. `onboard` now writes the workflow for `board` alone too, whose
  Needs you labels and issue types come from it.
  `issues: write` sets an issue's type: the weekly job's undo issues
  (process-rules-sandbox#15, athya_mono#2514) were opened as Briefs by that
  token. `doctor` warns of open issues with no type here. Rejected: a rule
  reading titles or labels (none that the CLI writes says Decision; #813's
  title says "decision" but carries no `Review:` field); typing the Approvals
  issue a Brief (it would read as a request a pull request closes); a fifth
  client job (the asks job already writes to issues, so one line each in its
  trigger and its condition upgrades a 0.6.3 workflow); editing athya_mono's
  `rotate-secrets.yml` (the job types what it files).
