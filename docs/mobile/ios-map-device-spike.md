# Issue #66 iOS native-map physical-device spike

<!-- issue66-ios-spike-policy
contract_version=1
claim_bearing_artifact=results_json_only
raw_captures=external_restricted_only
platform=ios_only
-->

> **TEMPLATE / NOT EVIDENCE** — This runbook records no renderer decision or
> physical-device outcome.

Use [`ios-map-device-evidence.template.json`](ios-map-device-evidence.template.json)
as the sole source for a physical-iPhone execution record. Never edit or rename
the tracked template. An authorized run may copy it only to
`docs/mobile/evidence/issue-66-ios/YYYY-MM-DD/<lowercase-run-id>/results.json`.
Only that dated result may state a `PASS`, `FAIL`, or renderer decision.

The test owner must use a provisioned iPhone, a controlled staging trip with
coordinates and route data, and an externally managed Google Maps SDK for iOS
credential restricted to `io.github.tyhuang9.dupert`. Do not place its value in
source, screenshots, device logs, recordings, analytics, crash reports, or the
result JSON. Store raw captures only in restricted external storage and record
opaque `restricted://issue-66-ios/...` references plus a redaction note.

Run every template gate in the real trip workspace: map creation and destruction;
tab and workspace navigation; background/resume; force-close/relaunch; orientation;
camera/style/fit; markers, polylines, map clicks, and place selection; sheets,
overlays, scrolling, and gesture boundaries; VoiceOver labels/focus; repeated
mount/unmount memory observations; and missing/rejected-key and backend-network
failure states. Record an agreed `map-ready` timing criterion before collecting
performance samples; do not infer a threshold after the fact.

[`ios-map-renderer-adr-template.md`](ios-map-renderer-adr-template.md) defines
the only possible selections. `native_google_maps_ios_qualified` requires every
gate to pass. A failed gate selects `native_google_maps_ios_rejected` and names
the smallest separately reviewable correction; it does not authorize a renderer
rewrite or a mixed/key-specific workaround in this spike.
