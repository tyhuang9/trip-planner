# iOS beta auth/session transport ADR — issue #64

<!-- issue64-ios-beta-adr-policy
contract_version=4
release_track=ios_beta
qualification=provisional_ios_implementation
allowed_outcomes=cookie_only_proven,native_credential_transport
forbidden_fallbacks=endpoint_only_fallback,web_storage_refresh_or_guest_token_workaround
decision_artifact=results_json_only
-->

> **TEMPLATE / NOT EVIDENCE** — This document is instruction-only and records no decision.

The sole iOS-beta claim-bearing record is a validated
docs/mobile/evidence/issue-64-ios/YYYY-MM-DD/<lowercase-run-id>/results.json
copy. Its ADR contract permits exactly cookie_only_proven or
native_credential_transport; endpoint-only fallbacks and web-storage refresh
or guest-token workarounds are prohibited. A decision must record its selected outcome,
restricted external decision reference, security properties, catalog-owned frontend and
backend work classifications and scopes, migration compatibility, revised estimate, and
any required follow-up issue partition. It requires distinct member and guest evidence
from a physical iPhone and may authorize only provisional iOS implementation. It must
never claim final shared or cross-platform qualification; only the dual-device
`shared_cross_platform` track can do so. Keep raw captures and credentials outside the
repository.
