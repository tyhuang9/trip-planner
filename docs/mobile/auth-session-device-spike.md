# Issue #64 auth/session physical-device spike

<!-- issue64-spike-policy
contract_version=3
claim_bearing_artifact=results_json_only
immutable_template=true
raw_captures=external_restricted_only
-->

> **TEMPLATE / NOT EVIDENCE** — This runbook carries no status, result, or decision.

The [canonical version-3 catalog](auth-session-device-evidence.catalog.json) is the sole source of truth for platforms, contexts, cases, lifecycle stages, and ADR options. Use [the JSON template](auth-session-device-evidence.template.json) as the only execution record. Never edit or rename either tracked source. An authorized run may copy the template only to `docs/mobile/evidence/issue-64/YYYY-MM-DD/<lowercase-run-id>/results.json`. Each physical platform must record distinct `member` and `guest` contexts, structured attestation, preconditions, actions, expected outcomes, cleanup, and redaction-safe evidence.

Use a disposable account for account deletion; record its destructive prerequisite and cleanup in that JSON case. Keep raw captures in restricted external storage. Evidence references, trace references, and checksums must be redaction-safe; do not commit cookies, credentials, tokens, JWTs, Bearer values, reset/verification links, or query secrets. Simulator and emulator runs are not evidence.

Both platform results must identify the same revision in `commit_or_tag` and the same semantic `app_version`; `platform_build` remains platform-specific.
