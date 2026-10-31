# Roadmap

process-rules is a product. Client repositories adopt a released version;
the product names none of them and holds no client's data. Every slice is
proven against a sandbox client repository made for the purpose, never a
real client: the private repository `process-rules-sandbox` beside this
one, the product's own, created by the owner on 2026-10-30 with the agent
account given write access.

**Version v1 — approved by the owner, 2026-10-30**, in chat: "Approved, mark ready".
The token choice, later that day, settled P-02's need and P-04's wording
(docs/decisions.md).
P-12, P-13 and P-14 were added on 2026-10-31, on the owner's word
(docs/decisions.md).

**From P-14 on, the roadmap lives in issues**: the Work item
[#22 process-rules roadmap v1](https://github.com/athya-hq/process-rules/issues/22),
one Slice sub-issue per row below, on the Project
[process-rules work](https://github.com/orgs/athya-hq/projects/2). Slices are
added, changed and closed there, not here; this file keeps v1 as it was
approved, with each row's issue (docs/decisions.md).

## What a client gets

A client repository names two GitHub accounts in `.github/process-rules.json`:
the **owner**, whose labels and comments count as approvals, and the
**agent**, which every agent session works as. Adopting takes:

1. **Once per machine and agent account:** `process-rules machine`. It needs
   no client repository.
2. **Once per client repository, by its owner:** `process-rules onboard`.
   It writes what the client commits and checks the rest.
3. **Every agent session:** the session-start hook `onboard` installed runs
   `process-rules session-start`, which gives the session the agent
   identity or locks GitHub out.

## Slices

| id   | issue | title                   | you will see                                                                                                                                                                     | status   | needs          |
| ---- | ----- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------- |
| P-01 | [#23](https://github.com/athya-hq/process-rules/issues/23) | Skeleton                | Public repo, CI green, secret scans clean                                                                                                                                        | shipped  | —              |
| P-02 | [#24](https://github.com/athya-hq/process-rules/issues/24) | Agent identity          | `machine` on a Mac with no client repo: key made and registered, token stored; `doctor` names each missing step; one session file per agent account                              | shipped  | —              |
| P-03 | [#25](https://github.com/athya-hq/process-rules/issues/25) | Session start           | `session-start` gives a session the agent identity the repo's settings name, or locks GitHub out (a refused token, no credential helper, every SSH remote refused); never the owner's login          | shipped  | P-02           |
| P-04 | [#26](https://github.com/athya-hq/process-rules/issues/26) | Onboard a client        | `onboard` in the sandbox writes the settings file, hook entry and workflow; checks the agent can push, naming a missing invite, an organisation's SAML authorisation or its block on classic tokens; a signed test commit Verified by the agent | shipped  | P-03           |
| P-05 | [#27](https://github.com/athya-hq/process-rules/issues/27) | Board setup             | `onboard` creates issue types, labels, fields and the Project; prints the views checklist                                                                                        | shipped  | P-04           |
| P-06 | [#28](https://github.com/athya-hq/process-rules/issues/28) | Owner locked away       | `machine` signs the owner out of `gh`, offers to drop the saved git password, warns about unprotected keys; a planted agent commit pushed as the owner fails the PR identity check | shipped  | P-04           |
| P-07 | [#29](https://github.com/athya-hq/process-rules/issues/29) | Work rules check        | Planted cases refused at pre-push and on the PR: unapproved start, added slice, dropped state, second PR                                                                         | shipped  | P-05           |
| P-08 | [#30](https://github.com/athya-hq/process-rules/issues/30) | Design frames checked   | Optional per client: a state links an existing frame built from the client's design library; a captured frame refused                                                           | shipped  | P-07           |
| P-09 | [#31](https://github.com/athya-hq/process-rules/issues/31) | Decision issues, weekly | One weekly run in the sandbox: checks run, a planted trip opens its undo issue, `expiring` and `cannot-run-here` set                                                              | shipped  | P-05           |
| P-10 | [#32](https://github.com/athya-hq/process-rules/issues/32) | Review routine          | One routine run: Kept and Settled with reasoning and `veto`; a production risk held for the owner                                                                                | shipped  | P-09           |
| P-11 | [#33](https://github.com/athya-hq/process-rules/issues/33) | Releases                | A tagged version a client pins; `onboard` writes that pin; upgrading is one pin change                                                                                           | shipped  | P-04           |
| P-12 | [#34](https://github.com/athya-hq/process-rules/issues/34) | Staged adoption         | A client turns on one feature at a time: `onboard <owner> <agent> --features identity` sets up identity alone; `onboard --add <feature>` adds one; checks of features that are off pass, saying so; the Project's title is a setting | shipped  | P-11           |
| P-13 | [#35](https://github.com/athya-hq/process-rules/issues/35) | Onboard finds the accounts | Plain `process-rules onboard` in a new client suggests the owner from the `gh` login and the agent from the accounts `machine` set up, for the owner to confirm; `.claude/settings.json` keeps its formatting, gaining only the hook entry | shipped  | P-12           |
| P-14 | [#36](https://github.com/athya-hq/process-rules/issues/36) | process-rules adopts itself | process-rules onboarded with `board`, `pr-identity` and `work-rules`: its roadmap slices as Slice issues under a Work item the owner approved, on a Project; an agent PR here, Verified and pushed by the agent, passes its own checks | shipped  | P-13           |

## Added after v1

Slices added since v1 live in their issues; these rows only point to them.

| id   | issue | title | you will see | status |
| ---- | ----- | ----- | ------------ | ------ |
| P-35 | [#83](https://github.com/athya-hq/process-rules/issues/83) | Owner commands sign in for one run only | `onboard` and `onboard --add` ask for one browser approval per run, into a temporary `gh` folder deleted afterwards; the owner stays signed out of `gh`, and nothing tells the owner to sign in or out of it | shipped |
| P-39 | [#94](https://github.com/athya-hq/process-rules/issues/94) | Work rules read a slice's parent as CI can | the work rules read a slice's parent from GitHub's parent endpoint, which a workflow's token can read on a private repository; a parent that cannot be read fails closed naming the failed read, never "not a sub-issue of a Work item" | in progress |
