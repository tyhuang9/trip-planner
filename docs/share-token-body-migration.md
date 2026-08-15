# Share token body transport rollout

Share acceptance credentials move from URL paths to JSON request bodies:

- Member: `POST /api/share/accept` with `{ "token": "..." }`
- Guest: `POST /api/share/guest` with `{ "token": "...", "displayName": "..." }`

The legacy `POST /api/share/{token}/accept` and
`POST /api/share/{token}/guest` routes remain compatibility-only endpoints
during the migration window. They use the same authorization, validation,
rate-limit bucket, service logic, guest cookie, and response contracts as the
body routes. Request timing logs normalize them to
`/api/share/{token}/accept` or `/api/share/{token}/guest`; raw token values must
not be logged.

## Rollout

1. Deploy the backend that supports both route forms and redacts legacy paths.
2. Confirm both new routes work and that legacy requests appear only under the
   normalized timing-log paths above.
3. Deploy web and native clients that use the body routes.
4. Observe normalized legacy-route usage through the full supported client
   aging window. Do not infer individual credentials or add raw-path logging.
5. Remove the legacy routes and their redaction only in a later release after
   legacy usage has aged out.

## Rollback

- A client rollback is safe while this dual-route backend remains deployed;
  keep the legacy endpoints, rate limiting, and path redaction active.
- Do not roll the backend back to a version without the body routes while new
  clients are active. If that is unavoidable, roll clients back first and
  verify they use the compatibility routes before rolling back the backend.
- There is no database migration, data rollback, or credential rewrite for
  this change.
