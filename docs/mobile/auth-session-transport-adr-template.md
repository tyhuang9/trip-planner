# Auth/session transport ADR — issue #64

> **TEMPLATE / NOT EVIDENCE** — This ADR records a decision shape, not a device
> result. All decision and evidence placeholders below are `UNEXECUTED`.

## Decision status

| Field | Value |
| --- | --- |
| Decision | `UNEXECUTED` |
| Physical iPhone evidence | `UNEXECUTED` |
| Physical Android evidence | `UNEXECUTED` |
| Reviewer/owner | `UNEXECUTED` |
| Date | `UNEXECUTED` |

Select exactly one of the two issue-approved outcomes after the physical-device
spike is complete. No third option is permitted.

## Approved outcome 1 — `cookie_only_proven`

**Proven cookie-only configuration.** Prove that the existing cookie transport
works across the entire member **and guest** lifecycle on both physical platforms:
issuance, storage, attachment, access expiry/refresh rotation, background/resume,
force-kill/relaunch, logout, deletion, verification/reset returns, guest
acceptance/relaunch/claim/expiry/revocation, REST reads/writes, and genuine SSE.
Include iOS WebView domain configuration and Android third-party-cookie behavior.

## Approved outcome 2 — `native_credential_transport`

**Explicit native credential transport.** Specify and prove native handling that
covers the entire member **and guest** lifecycle above, including where credentials
are issued, stored, attached, rotated, claimed, and revoked. Document the security
boundary and frontend/backend changes required to support it.

These are the only allowed outcomes. An endpoint-only fallback, or a web-storage
refresh-token/guest-token workaround, is explicitly out of scope and must not be
used to close issue #64.

## Required decision record

| Required section | Entry |
| --- | --- |
| Security properties (confidentiality, integrity, revocation, replay, logging) | `UNEXECUTED` |
| Required frontend work | `UNEXECUTED` |
| Required backend work | `UNEXECUTED` |
| Migration and backward compatibility | `UNEXECUTED` |
| Rollback or kill switch | `UNEXECUTED` |
| Revised estimate | `UNEXECUTED` |
| Follow-up issues/owners | `UNEXECUTED` |
| Redaction-safe evidence reference and artifact checksum | `UNEXECUTED` |

Do not commit raw cookies/tokens, credentials, email reset or verification links,
signing material, API keys, secrets, or other secret values. Reference a restricted
artifact by identity/checksum and record only redacted metadata (`<REDACTED>` for
values). The companion JSON fixture is the executable contract for this template.
