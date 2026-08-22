# iOS beta release-readiness runbook

<!-- ios-beta-readiness-policy
contract_version=1
claim_bearing_artifact=results_json_only
platform=ios_only
-->

> **TEMPLATE / NOT EVIDENCE** — This runbook contains no release decision.

Use [`ios-beta-release-readiness.template.json`](ios-beta-release-readiness.template.json)
only after the prerequisite iOS evidence is available. Keep the tracked template
unchanged. A controlled release owner may copy it only to
`docs/mobile/evidence/ios-beta-release-readiness/YYYY-MM-DD/<lowercase-run-id>/results.json`.
That dated result, after review, is the only artifact that may record `GO`.

Before a `GO`, provide redaction-safe restricted references for each template
check: the iPhone auth matrix and ADR; iPhone map renderer/key qualification;
hosted and signed-device Universal Links; controlled signed archive/provenance
and member/guest install; privacy policy, support contact, deletion resource,
App Store declarations, review credentials, and screenshots; previous-build
staging smoke; rollback drill; monitoring/escalation; and named release and
go/no-go owners. Record only opaque restricted references and summaries. Do not
commit passwords, tokens, cookies, profile/certificate material, email/reset
links, private incident URLs, screenshots, screen recordings, IPAs, archives, or
raw device/network captures.

Run the latest signed build and immediately preceding iOS build against the
current staging backend using separate disposable member and guest data. A
failed, blocked, or unverified check is `NO_GO`; do not close #64, #66, #67,
or #68 or claim an iOS beta until every required check has a reviewed `PASS`.
Android source, build, and CI compatibility remain supported, but Android
physical-device parity is explicitly deferred for this iOS-first beta cycle.
