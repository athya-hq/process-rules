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
