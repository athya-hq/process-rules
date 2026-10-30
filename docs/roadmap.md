# Roadmap

process-rules is a product. Client repositories adopt a released version;
the product names none of them and holds no client's data. Every slice is
proven against a sandbox client repository made for the purpose, never a
real client.

**Version v1 — drafted 2026-10-30, awaiting the owner's approval.**

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

| id   | title                   | you will see                                                                                                                                                                     | status   | needs          |
| ---- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------- |
| P-01 | Skeleton                | Public repo, CI green, secret scans clean                                                                                                                                        | shipped  | —              |
| P-02 | Agent identity          | `machine` on a Mac with no client repo: key made and registered, token stored; `doctor` names each missing step; one session file per agent account                              | building | token decision |
| P-03 | Session start           | `session-start` gives a session the agent identity the repo's settings name, or locks GitHub out (a refused token, no credential helper, every SSH remote refused); never the owner's login          | todo     | P-02           |
| P-04 | Onboard a client        | `onboard` in the sandbox writes the settings file, hook entry and workflow; checks the agent can push, naming pending organisation approval or a missing invite; a signed test commit Verified by the agent | todo     | P-03, sandbox  |
| P-05 | Board setup             | `onboard` creates issue types, labels, fields and the Project; prints the views checklist                                                                                        | todo     | P-04           |
| P-06 | Owner locked away       | `machine` signs the owner out of `gh`, offers to drop the saved git password, warns about unprotected keys; a planted agent commit pushed as the owner fails the PR identity check | todo     | P-04           |
| P-07 | Work rules check        | Planted cases refused at pre-push and on the PR: unapproved start, added slice, dropped state, second PR                                                                         | todo     | P-05           |
| P-08 | Design frames checked   | Optional per client: a state links an existing frame built from the client's design library; a captured frame refused                                                           | todo     | P-07           |
| P-09 | Decision issues, weekly | One weekly run in the sandbox: checks run, a planted trip opens its undo issue, `expiring` and `cannot-run-here` set                                                              | todo     | P-05           |
| P-10 | Review routine          | One routine run: Kept and Settled with reasoning and `veto`; a production risk held for the owner                                                                                | todo     | P-09           |
| P-11 | Releases                | A tagged version a client pins; `onboard` writes that pin; upgrading is one pin change                                                                                           | todo     | P-04           |

## Open, for the owner

- **Token for the agent account.** A fine-grained token has one resource
  owner. Owned by an organisation, it reaches that organisation's chosen
  repositories, may need an organisation owner's approval, and cannot
  register the agent's signing key, since "SSH signing keys: write" is a
  permission only a token owned by the agent account itself can hold; that
  step stays in the browser or takes a second, user-owned token. It reaches
  no repository where the agent is only an outside collaborator. A classic
  token with `repo`, `workflow`, `read:org`, `project` and
  `write:ssh_signing_key` reaches every repository the agent is invited to
  and registers the key itself, with broader rights within those
  repositories; an organisation may block classic tokens or require SSO
  authorisation for them. P-02 waits on this choice.
- **Sandbox client repository.** P-04 onward need one; creating it is the
  owner's call.
