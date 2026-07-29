# Web and native build profiles

For the source-controlled beta evidence contract and blocked release gates, see
[Mobile release-readiness preflight](release-readiness.md).

Dupert has six compile-time profiles. The selected target is never inferred from
a user agent, URL, or a Capacitor global. Vite validates the mode and injects
immutable target and environment constants; application code reads the typed
`platformRuntime` facade instead of scattering platform checks.

| Mode | Target | Environment | Backend requirement |
| --- | --- | --- | --- |
| `web-development` | web | development | Same-origin `/api` is allowed. |
| `web-staging` | web | staging | Same-origin `/api` is allowed. |
| `web-production` | web | production | Same-origin `/api` is allowed. |
| `native-development` | native | development | Explicit absolute `http` or `https` backend URL. |
| `native-staging` | native | staging | Explicit deployed HTTPS backend URL. |
| `native-production` | native | production | Explicit deployed HTTPS backend URL; browser Maps and app-wall values must be empty. |

`npm run dev` stays web development. `npm run build` remains the web-production
Vercel-compatible build. Run the corresponding `dev:web:*`, `build:web:*`, or
`build:native:*` script from `frontend/` for an explicit profile.

Native builds are deliberately rejected when their backend URL is blank,
relative, uses credentials/query/fragment data, targets localhost/loopback, or
uses a placeholder in staging or production. `VITE_*` values are public build
configuration, never a secret transport.

## Capacitor projects and native deployment profiles

The native projects live in `frontend/ios/` and `frontend/android/`. They are
generated from the committed `frontend/capacitor.config.ts` with the permanent
identity `io.github.tyhuang9.dupert`, the app name `Dupert`, and `webDir: dist`.
The config bundles the compiled files and deliberately has no `server.url`;
Capacitor documents a hosted URL as a live-reload feature rather than a
production setting. Its explicit bundled origins are `capacitor://localhost`
on iOS and `https://localhost` on Android.

| Native mode | Backend base URL | Source |
| --- | --- | --- |
| `native-development` | Explicit URL required | `.env.native-development.local` (copy the example first) |
| `native-staging` | `https://dupert-pm90.onrender.com` | `.env.native-staging` |
| `native-production` | `https://dupert.onrender.com` | `.env.native-production` |

The frontend appends `/api`; never add `/api` to these backend-base values.
Staging and production origins are public configuration, not secrets. Build and
sync an exact profile with one command:

```bash
npm run sync:native:development
npm run sync:native:staging
npm run sync:native:production
```

Each command builds the selected native profile, runs the native artifact policy,
then runs `npx cap sync` to copy that bundle to both generated projects. CI runs
the staging variant with a non-secret test URL and verifies the sync inputs; it
does not claim to compile or launch an iOS/Android app.

After a matching sync, use the native platform tools when available:

```bash
npx cap run ios
npx cap run android
```

Those commands need Xcode/simulator or Android SDK/emulator support respectively;
they are not substituted by a Linux CI sync check.

On macOS, the repository shortcut combines the development sync and iOS launch:

```bash
npm run startios
npm run stopios
```

`startios` requires Xcode, `frontend/.env.native-development.local`, and installed
frontend dependencies. Set `DUPERT_IOS_SIMULATOR` to a simulator UDID (recommended)
or an unambiguous simulator name. Without it, the shortcut reuses the simulator it
previously booted for this worktree, or selects exactly one already-booted iPhone
Simulator; it otherwise fails instead of guessing. A repository-wide atomic
reservation prevents another worktree from managing the same app and simulator.
`stopios` verifies that reservation, terminates only Dupert on the recorded
simulator, and never shuts down Simulator automatically.

## Backend CORS deployment

`ALLOWED_ORIGINS` remains the browser-origin list used by CORS, share links, and
email-link configuration. Native WebView origins are a separate comma-separated
`NATIVE_ALLOWED_ORIGINS` list. Set the following exact value on both the staging
and production Render backends:

```bash
NATIVE_ALLOWED_ORIGINS=capacitor://localhost,https://localhost
```

The CORS configuration deduplicates configured values but never expands native
origins or accepts `*`; a near-match such as `capacitor://localhost.evil` is
rejected. For production, use the canonical browser origin in both settings:

```bash
ALLOWED_ORIGINS=https://dupert.vercel.app
APP_PUBLIC_FRONTEND_URL=https://dupert.vercel.app
```

The staging browser origin is not inferred here: deployers must set it to the
actual staging web origin. Before release, use a packaged build and browser/dev
tools network inspection to record the actual `Origin` header for authentication
and API preflights on each platform. If a runtime reports a different origin,
change the deployed exact allowlist and tests—never broaden it with a wildcard.

## Target boundaries

Native entry aliases omit the browser AppAccessGate, Vercel Speed Insights, and
the browser Google Maps renderer/loader. Until issue #66 selects and verifies a
native renderer, the native target exposes an accessible map-evaluation state
and keeps the itinerary usable. Every `build:native:*` command runs an artifact
scan that rejects service-worker registration, browser Maps, AppAccessGate
configuration, analytics, and configured browser-value leakage.

The platform facade owns foreground/background lifecycle subscription. Native
builds subscribe through the Capacitor App plugin; callers must use this facade
rather than adding direct Capacitor globals.

## Android data exposure boundary

The committed Android manifest sets `android:allowBackup="false"` and contains
no `FileProvider`. `npm run check:android-data-exposure` fails if that backup
setting is missing, unsafe, or duplicated; if a `FileProvider` or
`file_paths.xml` returns; or if a broad `external-path` or `cache-path` is
introduced. This is a source policy, not device evidence: Android 12+ device-
to-device transfer behavior can vary by OEM, so `allowBackup="false"` is not a
universal D2D-prevention claim.

Any future file sharing must use a narrowly scoped provider in a separate
reviewed change that updates this policy and verifies the resulting native
behavior. Do not restore the old broad root paths.

## Deferred native qualification

This issue deliberately does not add Apple Team/distribution signing, Android
release signing fingerprints, Maps key restrictions, App/Universal Links,
association files, privacy/support/deletion URLs, permissions, native
HTTP/cookie/storage changes, or a native Maps renderer. iOS simulator/unsigned
build and Android compile/emulator qualification are manual checks when those
toolchains are available; physical-device qualification belongs to the later
issues named in the mobile-foundation sequence.
