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
  to client repositories only, and by a 90-day expiry that `doctor` warns
  about 14 days ahead. `machine` refuses a fine-grained token or missing
  scopes; `onboard` names an organisation that requires SAML authorisation
  or blocks classic tokens (P-02, P-04).
