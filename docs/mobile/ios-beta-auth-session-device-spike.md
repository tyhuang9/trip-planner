# iOS beta auth/session physical-device spike — issue #64

<!-- issue64-ios-beta-spike-policy
contract_version=4
release_track=ios_beta
qualification=provisional_ios_implementation
claim_bearing_artifact=results_json_only
immutable_template=true
raw_captures=external_restricted_only
-->

> **TEMPLATE / NOT EVIDENCE** — This runbook carries no status, result, or decision.

This is the iOS-first beta execution contract for the `ios_beta` release track. Use the
[catalog](ios-beta-auth-session-evidence.catalog.json) and copy its matching
[template](ios-beta-auth-session-device-evidence.template.json) only to
docs/mobile/evidence/issue-64-ios/YYYY-MM-DD/<lowercase-run-id>/results.json.
Run every member and guest case on one physical iPhone against staging. Record
only redaction-safe restricted references; keep cookies, tokens, reset and
verification links, and raw network captures outside the repository.

The selected outcome may authorize only provisional iOS implementation. It must never
claim final shared or cross-platform qualification, does not establish Android cookie
behavior, and cannot close the `shared_cross_platform` release track.
