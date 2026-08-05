# iOS beta auth/session transport ADR — issue #64

<!-- issue64-ios-beta-adr-policy
contract_version=1
allowed_outcomes=cookie_only_proven,native_credential_transport
forbidden_fallbacks=endpoint_only_fallback,web_storage_refresh_or_guest_token_workaround
decision_artifact=results_json_only
-->

> **TEMPLATE / NOT EVIDENCE** — This document is instruction-only and records no decision.

The sole iOS-beta claim-bearing record is a validated
docs/mobile/evidence/issue-64-ios/YYYY-MM-DD/<lowercase-run-id>/results.json
copy. Its ADR contract permits exactly cookie_only_proven or
native_credential_transport; endpoint-only fallbacks and web-storage refresh
or guest-token workarounds are prohibited. A decision requires distinct member and
guest evidence from a physical iPhone and remains limited to the iOS beta. Keep raw
captures and credentials outside the repository.
