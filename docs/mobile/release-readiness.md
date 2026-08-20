# iOS beta release-readiness preflight

This document is the repository-controlled contract for Dupert's current
**iOS-first internal beta**. Passing the automated preflight means only that
checked-in identifiers, versions, toolchain pins, public production configuration,
and this evidence schema are internally consistent. It does **not** mean an
artifact was signed, installed, tested on a device, approved for a store, or ready
for release.

<!-- ios-beta-release-scope
contract_version=1
primary_platform=ios
android_device_parity=deferred
-->

Android source, native build profiles, and CI verification remain maintained as
compatibility coverage. Physical Android qualification, Android signing, Play
delivery, and Android App Links are intentionally outside this iOS beta gate and
must be re-qualified in a later Android release track. They must not be inferred
from iOS evidence.

<!-- issue64-release-policy
contract_version=2
claim_bearing_artifact=results_json_only
-->

Issue #64's physical-device contract is maintained in the
[`auth-session-device-spike.md`](auth-session-device-spike.md) runbook,
[`auth-session-device-evidence.catalog.json`](auth-session-device-evidence.catalog.json)
canonical contract catalog,
[`auth-session-device-evidence.template.json`](auth-session-device-evidence.template.json)
fixture, and [`auth-session-transport-adr-template.md`](auth-session-transport-adr-template.md).
These are **TEMPLATE / NOT EVIDENCE** and deliberately contain no device execution
or credential values; only a dated, validated `results.json` copy is claim-bearing.
The Authentication and guest sessions and Device install smoke gates below remain
`BLOCKED` until a reviewed, redaction-safe physical-iPhone run proves them. The
existing two-platform template remains the Android-parity source contract and is
not itself iOS-beta evidence.

The iOS beta uses the separate
[`ios-beta-auth-session-device-spike.md`](ios-beta-auth-session-device-spike.md)
runbook, [`ios-beta-auth-session-evidence.catalog.json`](ios-beta-auth-session-evidence.catalog.json)
catalog, [`ios-beta-auth-session-device-evidence.template.json`](ios-beta-auth-session-device-evidence.template.json)
fixture, and [`ios-beta-auth-session-transport-adr-template.md`](ios-beta-auth-session-transport-adr-template.md).
They are also **TEMPLATE / NOT EVIDENCE**; a validated, redaction-safe result copy
is the only iOS-beta claim-bearing artifact.

Run the secret-free preflight from `frontend/`:

```bash
npm run check:mobile-release-readiness
```

## Repository-backed toolchain contract

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

| Component | Supported value | Source of truth |
| --- | --- | --- |
| Application identity | `io.github.tyhuang9.dupert` / `Dupert` | `capacitor.config.ts`, Android Gradle, Xcode project |
| Capacitor | `8.4.2` | `frontend/package.json`, generated Swift package |
| Node | `22` | GitHub Actions CI |
| Java | `21` | GitHub Actions CI |
| Gradle / Android Gradle Plugin | `8.14.3` / `8.13.0` | Gradle wrapper and Android build file |
| Android SDK | compile `36`, target `36`, minimum `24` (compatibility coverage) | `frontend/android/variables.gradle` |
| iOS deployment target | `15.0` | Xcode project |
| Xcode and macOS builder | **UNVERIFIED / UNPINNED** | Must be selected from a successful controlled signed-build run; do not infer it from the iOS deployment target. |

Changing a supported value requires changing its source configuration and this
contract in the same reviewed PR. Exact Xcode/macOS versions remain blocked until
a real macOS builder produces reproducible evidence.

## Evidence rules

- `PASS` requires an accountable owner and a durable evidence link or repository path.
- `BLOCKED` identifies a missing prerequisite and must not be read as partial approval.
- `UNVERIFIED` means the check has not been executed in the required environment.
- `FAIL` records executed evidence that did not meet the gate.
- A GitHub handle or explicitly accountable team must replace `Unassigned` before a
  gate can pass.
- Signing files, private keys, provisioning profiles, and release secrets stay out of
  source control and untrusted pull-request jobs.
- Evidence must name the commit/tag, artifact version, platform/OS, app version, and
  test date when those fields apply.

## Release gate ledger

<!-- mobile-release-gates:start -->
| Gate | Status | Owner | Evidence |
| --- | --- | --- | --- |
| Repository contract | PASS | Engineering | `frontend/scripts/check-mobile-release-readiness.mjs` and CI |
| Artifact provenance | BLOCKED | Unassigned | No tagged signed iOS artifact or controlled-build run recorded |
| Signing and secrets | BLOCKED | Unassigned | No approved iOS signing workflow, secret store, or certificate fingerprint recorded |
| Identity and versioning | BLOCKED | Unassigned | Source values agree, but signed iOS artifact metadata has not been inspected |
| Production configuration | BLOCKED | Unassigned | Source origin policy passes; packaged iOS artifact inspection is not recorded |
| Authentication and guest sessions | BLOCKED | Unassigned | Issue #64 templates are TEMPLATE / NOT EVIDENCE; physical-iPhone ADR and smoke evidence is unexecuted |
| Maps | BLOCKED | Unassigned | Issue #66 iOS template is source-only; physical-iPhone renderer ADR and iOS-restricted-key evidence remain unexecuted |
| Universal/App Links | BLOCKED | Unassigned | Issue #67 code policy is implemented, but acceptance remains blocked on issue #64 ADR, deployed iOS `/.well-known/apple-app-site-association`, Apple Team ID, and signed-iPhone cold/warm evidence |
| Privacy and store metadata | BLOCKED | Unassigned | App-owned manifest source contract passes, but Xcode archive privacy report, App Store Connect reconciliation, disclosures, review data, and screenshots are not recorded |
| Device install smoke | BLOCKED | Unassigned | Issue #64 device-spike template is TEMPLATE / NOT EVIDENCE; no signed iOS install or member/guest staging smoke evidence is recorded |
| Backward compatibility and rollback | BLOCKED | Unassigned | Previous iOS-version compatibility and rollback drill are not recorded |
| Monitoring and ownership | BLOCKED | Unassigned | iOS release owners, monitoring links, escalation path, and go/no-go approver are not assigned |
<!-- mobile-release-gates:end -->

## Controlled beta evidence checklist

Before any row above moves to `PASS`, record:

1. The exact tagged commit, version/build numbers, artifact checksums, and controlled
   build-run URL.
2. The external secret-store/signing identity used, without copying secret values or
   private material into issues, logs, artifacts, or the repository.
3. Packaged configuration evidence showing the production API origin, application
   identifiers, platform-restricted Maps keys, and link fingerprints match the signed
   artifacts and contain no development endpoint or app-access credential.
4. iOS privacy-manifest/data-use audit results from the actual release toolchain.
5. Physical iPhone install results for login, refresh, logout, deletion, guest
   accept/relaunch/claim, maps, and cold/warm links against staging.
6. Store-facing privacy/support/deletion URLs, disclosures, review credentials,
   screenshots, rollback procedure, monitoring, and named owners.
7. A smoke run proving the immediately previous app version remains compatible with
   the current backend.

Issue #68 stays open until the signed iOS artifact installs and all iOS beta
acceptance evidence is recorded. This preflight deliberately performs no signing
and reads no release secret. Android qualification remains a separately blocked
follow-up and is not implied by an iOS beta release.

## iOS Maps evidence status

Issue #66's [`ios-map-device-spike.md`](ios-map-device-spike.md) runbook,
[`ios-map-device-evidence.template.json`](ios-map-device-evidence.template.json),
and [`ios-map-renderer-adr-template.md`](ios-map-renderer-adr-template.md) are
**TEMPLATE / NOT EVIDENCE**. They prove only the source contract for recording a
future iPhone qualification; they do not select the native renderer, validate an
external key restriction, or provide device, accessibility, lifecycle, memory, or
network evidence. Android device qualification is deferred for this iOS-first beta.

## Universal/App Links evidence status

The application contains only the #67 client-side deep-link parser, memory-only
handoff policy, and native capture bridge. This is not association or signing
evidence. Do not add placeholder Apple App Site Association/Asset Links files or
invent an Apple Team ID or certificate fingerprint. Full iOS #67 acceptance is
**BLOCKED** until issue #64 supplies its iOS ADR and the production host, signing
owners, and physical iPhone provide the evidence named in the gate ledger. Android
App Links remain deferred with Android device qualification.
