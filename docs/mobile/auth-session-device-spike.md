# Issue #64 auth/session physical-device spike

> **TEMPLATE / NOT EVIDENCE** — Every status, run row, and evidence placeholder
> in this runbook is intentionally `UNEXECUTED`. Completing this file requires a
> controlled staging run on both a physical iPhone and a physical Android device;
> this repository contains no device results.

The machine-readable contract is [`auth-session-device-evidence.template.json`](auth-session-device-evidence.template.json).
Copy it to a reviewable evidence location only when a run is authorized. Do not
replace `UNEXECUTED` with a claim unless the linked, redaction-safe artifact exists.

## Required execution metadata

Record each field for each physical device. `UNEXECUTED` is the only allowed value
in this template.

| Field | iPhone | Android |
| --- | --- | --- |
| Commit or tag | `UNEXECUTED` | `UNEXECUTED` |
| App version/build | `UNEXECUTED` | `UNEXECUTED` |
| Device model | `UNEXECUTED` | `UNEXECUTED` |
| OS version | `UNEXECUTED` | `UNEXECUTED` |
| Xcode/macOS tooling | `UNEXECUTED` | `UNEXECUTED` |
| Android/ADB tooling | `UNEXECUTED` | `UNEXECUTED` |
| Staging environment | `UNEXECUTED` | `UNEXECUTED` |
| Test date/time | `UNEXECUTED` | `UNEXECUTED` |
| Tester/owner | `UNEXECUTED` | `UNEXECUTED` |
| Artifact identity/checksum | `UNEXECUTED` | `UNEXECUTED` |

The iOS run must use a physical iPhone (not Simulator). The Android run must use a
physical Android device (not an emulator). Record the exact staging environment and
tooling used; never infer a device result from a web or simulator run.

## Run matrix

Run every row on both platforms unless a row explicitly says otherwise. Keep the
status and every evidence field `UNEXECUTED` until the run and its artifact are
reviewed.

| Case ID | Required coverage | Status | Safe evidence reference |
| --- | --- | --- | --- |
| `member_login` | Member login | `UNEXECUTED` | `UNEXECUTED` |
| `access_token_expiry_refresh_rotation` | Access-token expiry and refresh rotation | `UNEXECUTED` | `UNEXECUTED` |
| `background_resume` | Background and resume | `UNEXECUTED` | `UNEXECUTED` |
| `force_kill_relaunch` | Force-kill and relaunch | `UNEXECUTED` | `UNEXECUTED` |
| `logout` | Logout | `UNEXECUTED` | `UNEXECUTED` |
| `account_deletion` | Account deletion | `UNEXECUTED` | `UNEXECUTED` |
| `email_verification_return` | Email-verification return | `UNEXECUTED` | `UNEXECUTED` |
| `password_reset_return` | Password-reset return | `UNEXECUTED` | `UNEXECUTED` |
| `guest_acceptance` | Guest acceptance | `UNEXECUTED` | `UNEXECUTED` |
| `trip_rest_read` | Trip REST read | `UNEXECUTED` | `UNEXECUTED` |
| `trip_write` | Trip write | `UNEXECUTED` | `UNEXECUTED` |
| `sse_streaming_genuine_without_global_native_http_patch` | Genuine SSE streaming; prove incremental delivery and no global native HTTP patch | `UNEXECUTED` | `UNEXECUTED` |
| `guest_relaunch` | Guest relaunch | `UNEXECUTED` | `UNEXECUTED` |
| `guest_claim` | Guest claim | `UNEXECUTED` | `UNEXECUTED` |
| `guest_expiry` | Guest expiry | `UNEXECUTED` | `UNEXECUTED` |
| `guest_revocation` | Guest revocation | `UNEXECUTED` | `UNEXECUTED` |
| `offline_loss_reconnect_each_session_boundary` | Offline loss/reconnect at every listed member, guest, REST, and SSE session boundary | `UNEXECUTED` | `UNEXECUTED` |
| `ios_webview_domain_configuration` | iOS WebView domain configuration | `UNEXECUTED` | `UNEXECUTED` |
| `android_third_party_cookie_behavior` | Android third-party-cookie behavior | `UNEXECUTED` | `UNEXECUTED` |

For the offline row, exercise loss and reconnect at every boundary listed in the
JSON fixture, including login, refresh, lifecycle transitions, logout/deletion,
verification/reset returns, guest acceptance/relaunch/claim/expiry/revocation,
trip REST read/write, and SSE.

## Credential and network evidence

Trace where member and guest credentials are issued, stored, attached, rotated,
claimed, and revoked. Capture only method/endpoint, status code, cookie or token
name, timing, redacted headers, and a durable artifact identity/checksum. A safe
reference may point to a private run artifact, but the repository must never contain
raw cookies or tokens, credentials, reset/verification links, signing material, API
keys, or secrets. Replace each value with `<REDACTED>` and leave this template's
placeholders `UNEXECUTED` until review.

## Platform-specific checks

- iOS: record the configured WebView domain and cookie behavior from the actual
  physical iPhone build; do not treat a simulator result as proof.
- Android: record the third-party-cookie behavior from the actual physical Android
  build and the WebView version. Do not silently assume cookie policy parity with iOS.
- SSE: show a timestamped sequence demonstrating genuine incremental streaming;
  a buffered response or a global native HTTP patch is not evidence of success.

The [transport ADR template](auth-session-transport-adr-template.md) must remain
`TEMPLATE / NOT EVIDENCE` until one of its two approved outcomes is proven.
