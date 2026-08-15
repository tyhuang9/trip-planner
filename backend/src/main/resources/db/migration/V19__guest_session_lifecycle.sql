-- Guest credentials survive cold starts for the same lifetime as their browser
-- cookie. Claiming a guest session clears the opaque credential while retaining
-- this row so historical activity attribution remains intact.
ALTER TABLE guest_sessions
    ADD COLUMN expires_at TIMESTAMPTZ,
    ADD COLUMN claimed_at TIMESTAMPTZ;

UPDATE guest_sessions
SET expires_at = created_at + INTERVAL '14 days';

ALTER TABLE guest_sessions
    ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX guest_sessions_active_expiry_idx
    ON guest_sessions (expires_at)
    WHERE token_hash IS NOT NULL;
