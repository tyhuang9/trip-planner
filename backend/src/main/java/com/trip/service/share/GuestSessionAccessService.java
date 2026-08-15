package com.trip.service.share;

import java.time.OffsetDateTime;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.trip.config.AppProperties;
import com.trip.domain.GuestSession;
import com.trip.domain.ShareLink;
import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.repo.GuestSessionRepository;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.web.exception.NotFoundException;

/**
 * Canonical lifecycle boundary for anonymous guest credentials.
 *
 * <p>Every presented raw guest token is hashed and validated here so bootstrap,
 * claim, and trip authorization agree on expiry, claim, and share-link revocation.
 * Public resolution records deliberately exclude the raw token and its hash.
 */
@Service
public class GuestSessionAccessService {

    static final int TOKEN_GENERATION_ATTEMPTS = 5;

    private final GuestSessionRepository guestSessionRepository;
    private final ShareLinkRepository shareLinkRepository;
    private final TripRepository tripRepository;
    private final TripMemberRepository tripMemberRepository;
    private final ShareTokenService shareTokenService;
    private final AppProperties appProperties;

    public GuestSessionAccessService(GuestSessionRepository guestSessionRepository,
                                     ShareLinkRepository shareLinkRepository,
                                     TripRepository tripRepository,
                                     TripMemberRepository tripMemberRepository,
                                     ShareTokenService shareTokenService,
                                     AppProperties appProperties) {
        this.guestSessionRepository = guestSessionRepository;
        this.shareLinkRepository = shareLinkRepository;
        this.tripRepository = tripRepository;
        this.tripMemberRepository = tripMemberRepository;
        this.shareTokenService = shareTokenService;
        this.appProperties = appProperties;
    }

    @Transactional
    public IssuedGuestSession issue(Long shareLinkId, String displayName) {
        GeneratedToken token = generateUniqueToken();
        OffsetDateTime expiresAt = OffsetDateTime.now()
            .plus(appProperties.getGuestSession().getTtl());
        guestSessionRepository.save(
            new GuestSession(shareLinkId, token.hash(), displayName, expiresAt));
        return new IssuedGuestSession(token.raw());
    }

    @Transactional(readOnly = true)
    public RestoredGuestSession restore(String rawGuestToken) {
        ResolvedGuestSession resolved = resolve(rawGuestToken);
        return new RestoredGuestSession(
            resolved.publicId(), resolved.role(), resolved.displayName());
    }

    @Transactional(readOnly = true)
    public ResolvedGuestSession resolve(String rawGuestToken) {
        String hash = hashPresentedToken(rawGuestToken);
        GuestSession guestSession = guestSessionRepository.findByTokenHash(hash)
            .orElseThrow(GuestSessionAccessService::guestSessionNotFound);
        return validate(guestSession, OffsetDateTime.now()).publicView();
    }

    @Transactional
    public ClaimedGuestSession claim(String rawGuestToken, Long userId) {
        String hash = hashPresentedToken(rawGuestToken);
        GuestSession guestSession = guestSessionRepository.findByTokenHashForUpdate(hash)
            .orElseThrow(GuestSessionAccessService::guestSessionNotFound);
        OffsetDateTime now = OffsetDateTime.now();
        ValidatedSession validated = validate(guestSession, now);

        TripRole effectiveRole = upsertMembership(
            validated.trip().getId(), userId, validated.shareLink().getRole());
        guestSession.invalidateCredential(now);
        guestSessionRepository.save(guestSession);
        return new ClaimedGuestSession(validated.trip(), effectiveRole);
    }

    private ValidatedSession validate(GuestSession guestSession, OffsetDateTime now) {
        if (guestSession.isClaimed() || guestSession.isExpiredAt(now)) {
            throw guestSessionNotFound();
        }
        ShareLink shareLink = shareLinkRepository.findById(guestSession.getShareLinkId())
            .orElseThrow(GuestSessionAccessService::guestSessionNotFound);
        if (!shareLink.isAllowAnonymous()
                || shareLink.getRevokedAt() != null
                || shareLink.getExpiresAt() != null && !shareLink.getExpiresAt().isAfter(now)) {
            throw guestSessionNotFound();
        }
        Trip trip = tripRepository.findById(shareLink.getTripId())
            .orElseThrow(GuestSessionAccessService::guestSessionNotFound);
        return new ValidatedSession(guestSession, shareLink, trip);
    }

    private TripRole upsertMembership(Long tripId, Long userId, TripRole invitedRole) {
        return tripMemberRepository.findByIdTripIdAndIdUserId(tripId, userId)
            .map(existing -> {
                if (existing.getRole().rank() < invitedRole.rank()) {
                    existing.setRole(invitedRole);
                    tripMemberRepository.save(existing);
                }
                return existing.getRole();
            })
            .orElseGet(() -> {
                tripMemberRepository.save(new TripMember(tripId, userId, invitedRole));
                return invitedRole;
            });
    }

    private GeneratedToken generateUniqueToken() {
        for (int attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt++) {
            String raw = shareTokenService.generateRawToken();
            String hash = shareTokenService.sha256Hex(raw);
            if (guestSessionRepository.findByTokenHash(hash).isEmpty()) {
                return new GeneratedToken(raw, hash);
            }
        }
        throw new IllegalStateException("exhausted guest token generation retries");
    }

    private String hashPresentedToken(String rawGuestToken) {
        if (rawGuestToken == null || rawGuestToken.isBlank()) {
            throw guestSessionNotFound();
        }
        return shareTokenService.sha256Hex(rawGuestToken.trim());
    }

    private static NotFoundException guestSessionNotFound() {
        return new NotFoundException("guest session not found");
    }

    private record GeneratedToken(String raw, String hash) {
    }

    private record ValidatedSession(GuestSession guestSession, ShareLink shareLink, Trip trip) {
        private ResolvedGuestSession publicView() {
            return new ResolvedGuestSession(
                guestSession.getId(),
                trip.getId(),
                trip.getPublicId(),
                shareLink.getRole(),
                guestSession.getDisplayName());
        }
    }

    public record IssuedGuestSession(String rawGuestToken) {
    }

    public record RestoredGuestSession(String publicId, TripRole role, String displayName) {
    }

    public record ResolvedGuestSession(Long guestSessionId, Long tripId, String publicId,
                                       TripRole role, String displayName) {
    }

    public record ClaimedGuestSession(Trip trip, TripRole effectiveRole) {
    }
}
