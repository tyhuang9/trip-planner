package com.trip.domain;

import java.time.Duration;
import java.time.OffsetDateTime;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

@Entity
@Table(name = "guest_sessions")
public class GuestSession {

    private static final Duration LEGACY_CONSTRUCTOR_TTL = Duration.ofDays(14);

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "share_link_id", nullable = false)
    private Long shareLinkId;

    @Column(name = "token_hash", length = 64)
    private String tokenHash;

    @Column(name = "display_name", nullable = false, length = 200)
    private String displayName;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @Column(name = "last_seen_at", nullable = false)
    private OffsetDateTime lastSeenAt;

    @Column(name = "expires_at", nullable = false)
    private OffsetDateTime expiresAt;

    @Column(name = "claimed_at")
    private OffsetDateTime claimedAt;

    protected GuestSession() {
        // JPA
    }

    public GuestSession(Long shareLinkId, String displayName) {
        this(shareLinkId, null, displayName);
    }

    public GuestSession(Long shareLinkId, String tokenHash, String displayName) {
        this(shareLinkId, tokenHash, displayName,
            OffsetDateTime.now().plus(LEGACY_CONSTRUCTOR_TTL));
    }

    public GuestSession(Long shareLinkId, String tokenHash, String displayName,
                        OffsetDateTime expiresAt) {
        this.shareLinkId = shareLinkId;
        this.tokenHash = tokenHash;
        this.displayName = displayName;
        this.expiresAt = expiresAt;
    }

    public Long getId() {
        return id;
    }

    public Long getShareLinkId() {
        return shareLinkId;
    }

    public String getTokenHash() {
        return tokenHash;
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public OffsetDateTime getLastSeenAt() {
        return lastSeenAt;
    }

    public OffsetDateTime getExpiresAt() {
        return expiresAt;
    }

    public OffsetDateTime getClaimedAt() {
        return claimedAt;
    }

    public boolean isExpiredAt(OffsetDateTime when) {
        return expiresAt == null || !expiresAt.isAfter(when);
    }

    public boolean isClaimed() {
        return claimedAt != null || tokenHash == null;
    }

    public void invalidateCredential(OffsetDateTime when) {
        tokenHash = null;
        claimedAt = when;
    }

    public void touch(OffsetDateTime when) {
        this.lastSeenAt = when;
    }

    @PrePersist
    void onCreate() {
        OffsetDateTime now = OffsetDateTime.now();
        if (createdAt == null) {
            createdAt = now;
        }
        if (lastSeenAt == null) {
            lastSeenAt = now;
        }
    }
}
