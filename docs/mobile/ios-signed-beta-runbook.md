# Controlled iOS signed beta runbook

<!-- ios-signed-beta-policy
contract_version=1
claim_bearing_artifact=results_json_only
secrets=external_controlled_keychain_only
-->

> **TEMPLATE / NOT EVIDENCE** — This runbook does not claim a signed archive,
> successful export, or installed beta.

Run this only on a controlled macOS builder after a release owner has assigned a
tag, semantic version/build number, Apple Team, distribution channel, restricted
keychain, profile, certificate, and physical-iPhone tester. Keep private keys,
profiles, export options containing sensitive data, IPA/archive files, raw tool
output, and device captures outside this repository and untrusted PR jobs.

1. Start from a clean checkout at the assigned tag and record the revision,
   macOS version, and exact Xcode version in restricted release evidence.
2. Obtain the Team identifier, distribution certificate/profile, and export
   options from the approved secret manager into the controlled keychain and
   an external, access-controlled workspace. Do not use automatic provisioning
   updates or copy these inputs into source control.
3. From `frontend/`, build the production native bundle and sync it with the
   approved production API configuration. Confirm the release preflight first:

   ```bash
   npm ci
   npm run check:mobile-release-readiness
   npm run sync:native:production
   ```

4. Archive with an explicit Team supplied only in the controlled environment;
   save the archive outside the repository:

   ```bash
   xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination generic/platform=iOS -archivePath "$DUPERT_IOS_ARCHIVE_PATH" DEVELOPMENT_TEAM="$DUPERT_IOS_TEAM_ID" CODE_SIGN_STYLE=Manual archive
   ```

5. Export outside the repository with the externally managed export-options
   file. Do not put `-allowProvisioningUpdates` in this workflow:

   ```bash
   xcodebuild -exportArchive -archivePath "$DUPERT_IOS_ARCHIVE_PATH" -exportPath "$DUPERT_IOS_EXPORT_PATH" -exportOptionsPlist "$DUPERT_IOS_EXPORT_OPTIONS_PATH"
   ```

6. Run the signed-archive inspector with only non-secret expected values. Store
   its sanitized result, archive/IPA SHA-256 values, signing channel, certificate
   fingerprint, restricted evidence references, and any error detail outside Git:

   ```bash
   node scripts/check-ios-signed-archive.mjs --archive "$DUPERT_IOS_ARCHIVE_PATH" --bundle-id io.github.tyhuang9.dupert --version "$DUPERT_IOS_VERSION" --build "$DUPERT_IOS_BUILD" --team-id "$DUPERT_IOS_TEAM_ID" --production-api-origin https://dupert.onrender.com
   ```

7. Copy the unexecuted fixture only after the controlled archive inspection and
   physical member/guest smoke run complete. Use its dated destination exactly;
   include opaque restricted references and redaction notes, never raw values.

Rollback means disable or revoke the beta build through the authorized delivery
channel and revert the source tag/configuration through a separate reviewed
change. Neither action is evidence that a beta was ever approved.
