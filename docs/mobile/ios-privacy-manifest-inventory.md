# Dupert iOS privacy-manifest inventory

This is the source-backed, app-owned declaration for
`frontend/ios/App/App/PrivacyInfo.xcprivacy`. It describes the Dupert app code
in this repository; vendor SDK manifests remain separate and are not declared
here. It is not a signed-archive, device, App Store, or store-metadata
approval.

## App-owned collection declaration

| Manifest data type | Dupert source flow | Declaration |
| --- | --- | --- |
| `NSPrivacyCollectedDataTypeName` | `displayName` is sent to and returned from `/auth/*` by `frontend/src/api/auth.ts`, with its shape in `frontend/src/types/auth.ts`. | Linked; not used for tracking; app functionality only. |
| `NSPrivacyCollectedDataTypeEmailAddress` | Registration, login, verification, reset, and profile-session responses use `email` in `frontend/src/api/auth.ts` and `frontend/src/types/auth.ts`. | Linked; not used for tracking; app functionality only. |
| `NSPrivacyCollectedDataTypeUserID` | The authenticated `UserSummary.id` field in `frontend/src/types/auth.ts` identifies the current account. | Linked; not used for tracking; app functionality only. |
| `NSPrivacyCollectedDataTypeOtherUserContent` | Trip and activity requests carry user-authored names, destinations, and notes through `frontend/src/api/trips.ts`, `frontend/src/api/activities.ts`, and their types. | Linked; not used for tracking; app functionality only. |

`NSPrivacyTracking` is `false`. `NSPrivacyTrackingDomains` and
`NSPrivacyAccessedAPITypes` are absent: the app-owned native source is only
`frontend/ios/App/App/AppDelegate.swift`, which does not call a covered
required-reason API. This app-owned manifest intentionally does not declare
`NSPrivacyCollectedDataTypePreciseLocation`,
`NSPrivacyCollectedDataTypeSearchHistory`, or
`NSPrivacyCollectedDataTypeProductInteraction`; it also does not claim any
third-party SDK behavior.

## Remaining privacy and store gate

Privacy and store metadata remains **BLOCKED** until a controlled Xcode archive
produces its privacy report and the resulting disclosures are reconciled in App
Store Connect. Reconcile vendor manifests and App Store Connect metadata then;
this repository check cannot establish signed, device, or App Store readiness.
