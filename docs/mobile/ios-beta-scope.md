# Dupert iOS-first beta scope

The current mobile release track is an **internal iOS beta**. Its release gates
are authoritative in [release-readiness.md](release-readiness.md).

## Included

- A signed iOS artifact with controlled provenance and platform-restricted Maps
  credentials.
- Physical-iPhone member and guest authentication, maps, Universal Links, and
  staged upgrade/rollback smoke evidence.
- App Store privacy, support, deletion, review, monitoring, and ownership evidence.

## Deferred Android qualification

Dupert continues to compile, inspect, and test Android through the repository's
native profiles and CI. This preserves compatibility coverage only. The following
are explicitly deferred and require a later Android release track: physical-device
authentication/session evidence, native Maps qualification, App Links, signed AAB
provenance, Play disclosures, and upgrade/rollback evidence.

No iOS pass result grants an Android release approval, and no Android artifact or
credential belongs in the iOS beta evidence record.

## Source audit baseline

- **Authentication:** the native client currently uses cookie-backed refresh and
  logout, in-memory bearer access tokens, credentialed API calls, refresh
  single-flight locking, guest-write headers, and an offline logout tombstone.
  This is source evidence only; iPhone WebView behavior remains unproven.
- **Maps:** the native trip surface already uses the Capacitor Google Maps bridge
  with iOS key input, lifecycle and bounds handling, markers, polylines, camera
  controls, an accessible map label, and an actionable key-failure state. It has
  no physical-iPhone or externally restricted-key evidence.
- **Links:** the deep-link bridge allows only `https://dupert.vercel.app` and
  the supported share, verification, reset, trip, and trip-day routes. It queues
  links until bootstrap, keeps sensitive values in a memory-only vault, and
  scrubs history. Associated Domains and a deployed Apple association file have
  not been verified.

## Repository baseline

Recorded 2026-08-03 against commit
`7787ed64e7c03c11b140b52cac4ae0adc81debfc`:

- `npm run check:mobile-release-readiness` passed.
- Focused mobile-release and iOS-privacy Node contract suites passed (83 tests).
- Frontend lint passed.
- The full frontend suite was not clean: one existing
  `TripWorkspacePage` edit-conflict test could not find **Save changes**. This
  release-contract change does not touch that component, so it remains an
  unverified unrelated baseline failure.
