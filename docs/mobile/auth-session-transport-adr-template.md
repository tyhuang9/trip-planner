# Auth/session transport ADR — issue #64

<!-- issue64-adr-policy
contract_version=2
allowed_outcomes=cookie_only_proven,native_credential_transport
forbidden_fallbacks=endpoint_only_fallback,web_storage_refresh_or_guest_token_workaround
decision_artifact=results_json_only
-->

> **TEMPLATE / NOT EVIDENCE** — This document is instruction-only and records no decision.

The sole claim-bearing record is the validated issue-64 `results.json` copy. Its `adr_contract` permits exactly `cookie_only_proven` or `native_credential_transport`; endpoint-only fallbacks and web-storage refresh/guest-token workarounds are prohibited. A decision requires separately validated physical iOS and Android member and guest evidence. Keep raw captures and credentials outside the repository.
