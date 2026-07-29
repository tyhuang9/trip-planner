# Issue #64 auth/session physical-device spike

<!-- issue64-spike-policy
contract_version=2
claim_bearing_artifact=results_json_only
immutable_template=true
raw_captures=external_restricted_only
-->

> **TEMPLATE / NOT EVIDENCE** — This runbook carries no status, result, or decision.

Use [the versioned JSON template](auth-session-device-evidence.template.json) as the only execution record. Never edit or rename that tracked template. An authorized run may copy it only to `docs/mobile/evidence/issue-64/YYYY-MM-DD/<lowercase-run-id>/results.json`. Each physical platform must record distinct `member` and `guest` contexts. The JSON schema specifies every applicable case, offline boundary, credential lifecycle stage, precondition, action, expected outcome, cleanup, and redaction-safe evidence object.

Use a disposable account for account deletion; record its destructive prerequisite and cleanup in that JSON case. Keep raw captures in restricted external storage. Evidence references, trace references, and checksums must be redaction-safe; do not commit cookies, credentials, tokens, JWTs, Bearer values, reset/verification links, or query secrets. Simulator and emulator runs are not evidence.
