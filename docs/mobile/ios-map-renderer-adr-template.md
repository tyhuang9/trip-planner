# iOS native-map renderer ADR — issue #66

<!-- issue66-ios-adr-policy
contract_version=1
allowed_renderers=native_google_maps_ios_qualified,native_google_maps_ios_rejected
decision_artifact=results_json_only
-->

> **TEMPLATE / NOT EVIDENCE** — This document is instruction-only and records
> no selected renderer.

The only claim-bearing decision is the validated issue-66 iOS `results.json`
copy. It can select `native_google_maps_ios_qualified` only when every functional,
lifecycle, accessibility, key-restriction, and stability gate passes on a physical
iPhone. Any executed failure selects `native_google_maps_ios_rejected` and must
describe the smallest corrective implementation as a new PR; this evidence PR
does not change the renderer. The native target must continue to omit the browser
Google Maps renderer and browser Maps credential.
