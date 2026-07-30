# Android Gradle dependency verification

Dupert commits Gradle's dependency-verification metadata at
`frontend/android/gradle/verification-metadata.xml`. Gradle discovers that file
automatically and verifies the Android release build's external dependency
artifacts in strict mode. A dependency with no approved checksum, or bytes that
do not match an approved checksum, makes the build fail before it can be treated
as release evidence.

The metadata permits SHA-256 checksums only. It deliberately contains no trusted
artifacts, ignored artifacts or keys, regular-expression trust rules, PGP trust
configuration, or weak hashes. Do not add a bypass to make a verification
failure pass.

## Bootstrap evidence and trust boundary

The initial metadata was generated on Ubuntu 24.04 with Java 21 and Gradle
8.14.3 by two separate, fresh Gradle homes. Both runs resolved the Android
release graph independently and produced byte-identical XML:

- Source commit: `398fa34f73f617c171192f2f04b1ff0c864dd05f`
- Hosted proof:
  [Android Gradle verification bootstrap run 30492993751](https://github.com/tyhuang9/dupert/actions/runs/30492993751)
- Metadata SHA-256: `3e5d1bbcd879d5b9ff70297915d989d8926952bd4e512d7205e814b10cb97464`
- Coverage at bootstrap: 459 components, 812 artifacts, 812 SHA-256 entries

The hosted proof also rebuilt from another fresh Gradle home with strict
verification, then changed every approved checksum for the exact Android Gradle
Plugin 8.13.0 JAR and required a new build to fail specifically because of
dependency verification. Only the XML files were uploaded; no APK, AAB, signing
material, or secret was uploaded.

This bootstrap is trust on first use. Two matching resolutions demonstrate
reproducibility at that point in time, but both runners used the same configured
artifact repositories. The checksums protect future builds from changed or
unexpected bytes after adoption; they do not independently prove publisher
identity or that the first downloaded bytes were benign. PGP signature
verification remains disabled and would require a separate reviewed trust-policy
change.

The Gradle wrapper distribution is outside this XML and retains its separate
`distributionSha256Sum` pin in `gradle-wrapper.properties`. npm packages,
GitHub Actions, the hosted Android SDK/NDK, project dependencies, and local file
dependencies have their own controls and are not covered by this metadata.

## Normal verification

The path-scoped Android workflow performs the authoritative hosted build. For a
local check, first produce and sync the native production bundle using the
documented public build configuration, then run from `frontend/android/`:

```bash
./gradlew --dependency-verification strict :app:assembleRelease --no-daemon
```

The explicit flag documents intent; strict verification is already Gradle's
default when the committed metadata file is present. A task that resolves an
additional configuration can legitimately fail because its artifacts are not
yet approved. Treat that as a review request, not as a reason to relax the
policy.

## Reviewing a dependency change

Update metadata only in the same narrow pull request as the dependency or
toolchain change that requires it:

1. Review the requested dependency coordinates and repository changes before
   resolving anything.
2. Build and sync the production native bundle for Android. Set
   `GRADLE_USER_HOME` to a newly created empty directory, then run from
   `frontend/android/`:

   ```bash
   ./gradlew --write-verification-metadata sha256 \
     :app:assembleRelease \
     --refresh-dependencies \
     --no-daemon
   ```

3. Repeat generation from a second fresh Gradle home and require the two XML
   files to be byte-identical. Do not reuse a dependency cache as independent
   evidence.
4. Review the XML diff. Every new or removed component and artifact must be
   explained by the intended dependency change. Require SHA-256 for every
   artifact and reject trust or ignore rules, weak hashes, unexplained
   repositories, and unrelated coordinate churn.
5. Run a clean strict `:app:assembleRelease` with the reviewed metadata. For a
   policy/tooling change, also prove that tampering a known resolved checksum is
   rejected for dependency-verification reasons.
6. Record the exact commit, runner/toolchain versions, metadata digest, counts,
   commands, and hosted run URL in the pull request.

`--write-verification-metadata` downloads and trusts the bytes available during
that execution. Never accept its output without the coordinate review,
independent reproduction, aggregate diff review, and clean strict build above.

## Responding to a verification failure

First confirm that the build uses the intended commit, repositories, Gradle
wrapper, and dependency coordinates. Gradle writes a local HTML report under its
dependency-verification reports directory with the rejected artifact details.
Use that evidence to decide whether the failure is an intentional dependency
update, repository inconsistency, cache corruption, or a possible supply-chain
event.

Do not regenerate metadata during an ordinary CI run, automatically accept a new
checksum, add a second checksum without explaining the byte difference, disable
metadata verification, or add a broad trust/ignore rule. If the bytes changed
without an approved coordinate change, stop release work and investigate before
updating the repository.
