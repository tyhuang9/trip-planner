# Mobile release-readiness preflight

<!-- issue64-release-policy
contract_version=2
claim_bearing_artifact=results_json_only
-->

Issue #64 sources are **TEMPLATE / NOT EVIDENCE**. The immutable [JSON template](auth-session-device-evidence.template.json), instruction-only spike runbook, and instruction-only ADR are validated by `npm run check:mobile-release-readiness`; only a dated, validated JSON result copy can carry execution claims.

<!-- mobile-release-contract
app_id=io.github.tyhuang9.dupert
app_name=Dupert
capacitor=8.4.2
node=22
java=21
gradle=8.14.3
android_gradle_plugin=8.13.0
android_compile_sdk=36
android_target_sdk=36
android_min_sdk=24
ios_deployment_target=15.0
-->

<!-- mobile-release-gates:start -->
| Gate | Status | Owner | Evidence |
| --- | --- | --- | --- |
| Repository contract | PASS | Engineering | `frontend/scripts/check-mobile-release-readiness.mjs` and CI |
| Artifact provenance | BLOCKED | Unassigned | No tagged signed artifact or controlled-build run recorded |
| Signing and secrets | BLOCKED | Unassigned | No approved signing workflow, secret store, or certificate fingerprints recorded |
| Identity and versioning | BLOCKED | Unassigned | Source values agree, but signed artifact metadata has not been inspected |
| Production configuration | BLOCKED | Unassigned | Source origin policy passes; packaged artifact inspection is not recorded |
| Authentication and guest sessions | BLOCKED | Unassigned | Issue #64 JSON template is TEMPLATE / NOT EVIDENCE |
| Maps | BLOCKED | Unassigned | Depends on issue #66 renderer ADR and restricted-key evidence |
| Universal/App Links | BLOCKED | Unassigned | Depends on issue #67 owned-host association files and signed fingerprints |
| Privacy and store metadata | BLOCKED | Unassigned | Privacy audit and store evidence are not recorded |
| Device install smoke | BLOCKED | Unassigned | Issue #64 device JSON template is TEMPLATE / NOT EVIDENCE |
| Backward compatibility and rollback | BLOCKED | Unassigned | Compatibility and rollback drill are not recorded |
| Monitoring and ownership | BLOCKED | Unassigned | Release owners and monitoring are not assigned |
<!-- mobile-release-gates:end -->
