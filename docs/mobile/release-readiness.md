# Mobile release-readiness preflight

This document is the repository-controlled contract for Dupert mobile release
evidence. Passing the automated preflight means only that checked-in identifiers,
versions, toolchain pins, public production configuration, and this evidence schema
are internally consistent. It does **not** mean an artifact was signed, installed,
tested on a device, approved for a store, or ready for release.

Issue #64's physical-device contract is maintained in the
[`auth-session-device-spike.md`](auth-session-device-spike.md) runbook,
[`auth-session-device-evidence.template.json`](auth-session-device-evidence.template.json)
fixture, and [`auth-session-transport-adr-template.md`](auth-session-transport-adr-template.md).
These are **TEMPLATE / NOT EVIDENCE** and deliberately contain no device execution
or credential values. The Authentication and guest sessions and Device install
smoke gates below remain `BLOCKED` until a reviewed, redaction-safe run proves them.

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
| Android SDK | compile `36`, target `36`, minimum `24` | `frontend/android/variables.gradle` |
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
| Artifact provenance | BLOCKED | Unassigned | No tagged signed artifact or controlled-build run recorded |
| Signing and secrets | BLOCKED | Unassigned | No approved signing workflow, secret store, or certificate fingerprints recorded |
| Identity and versioning | BLOCKED | Unassigned | Source values agree, but signed artifact metadata has not been inspected |
| Production configuration | BLOCKED | Unassigned | Source origin policy passes; packaged artifact inspection is not recorded |
| Authentication and guest sessions | BLOCKED | Unassigned | Issue #64 templates are TEMPLATE / NOT EVIDENCE; physical iPhone and Android ADR and smoke evidence is unexecuted |
| Maps | BLOCKED | Unassigned | Depends on issue #66 renderer ADR and restricted-key evidence |
| Universal/App Links | BLOCKED | Unassigned | Depends on issue #67 owned-host association files and signed fingerprints |
| Privacy and store metadata | BLOCKED | Unassigned | Privacy audit, declarations, policy/support URLs, disclosures, review data, and screenshots are not recorded |
| Device install smoke | BLOCKED | Unassigned | Issue #64 device-spike template is TEMPLATE / NOT EVIDENCE; no signed iOS and Android installs or member/guest staging smoke evidence recorded |
| Backward compatibility and rollback | BLOCKED | Unassigned | Previous-version compatibility and rollback drill are not recorded |
| Monitoring and ownership | BLOCKED | Unassigned | Release owners, monitoring links, escalation path, and go/no-go approver are not assigned |
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
4. iOS privacy-manifest/data-use audit results and Android target-SDK/native-library
   compatibility evidence from the actual release toolchains.
5. Physical iPhone and Android install results for login, refresh, logout, deletion,
   guest accept/relaunch/claim, maps, and cold/warm links against staging.
6. Store-facing privacy/support/deletion URLs, disclosures, review credentials,
   screenshots, rollback procedure, monitoring, and named owners.
7. A smoke run proving the immediately previous app version remains compatible with
   the current backend.

Issue #68 stays open until signed artifacts install and all acceptance evidence is
recorded. This preflight deliberately performs no signing and reads no release secret.
