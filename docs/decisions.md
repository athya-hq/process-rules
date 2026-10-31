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
