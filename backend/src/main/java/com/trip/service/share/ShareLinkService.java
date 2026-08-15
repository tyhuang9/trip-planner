package com.trip.service.share;

import java.time.OffsetDateTime;
import java.util.List;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.trip.config.AppProperties;
import com.trip.domain.ShareLink;
import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.repo.ShareLinkRepository;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.service.realtime.TripEvent;
import com.trip.service.realtime.TripEventPublisher;
import com.trip.service.trip.ResolvedTrip;
import com.trip.service.trip.TripAccessGuard;
import com.trip.web.dto.share.AcceptShareLinkResponse;
import com.trip.web.dto.share.AcceptGuestShareLinkResponse;
import com.trip.web.dto.share.CreateShareLinkRequest;
import com.trip.web.dto.share.CreateShareLinkResponse;
import com.trip.web.dto.share.ShareLinkResponse;
import com.trip.web.dto.trip.TripResponse;
import com.trip.web.exception.NotFoundException;
import com.trip.web.exception.ValidationException;
import com.trip.web.auth.DisplayNameSanitizer;

/**
 * Share-link write/read operations for Piece 5.
 *
 * <p>Authenticated trip members with at least EDITOR privileges can manage links.
 * Public acceptance supports either direct member enrollment or an anonymous guest
 * credential that can later be claimed by an authenticated account.
 */
@Service
public class ShareLinkService {

    static final int TOKEN_GENERATION_ATTEMPTS = 5;

    private final ShareLinkRepository shareLinkRepository;
    private final TripRepository tripRepository;
    private final TripMemberRepository tripMemberRepository;
    private final TripAccessGuard tripAccessGuard;
    private final ShareTokenService shareTokenService;
    private final TripEventPublisher tripEventPublisher;
    private final GuestSessionAccessService guestSessionAccessService;
    private final String shareUrlOrigin;

    public ShareLinkService(ShareLinkRepository shareLinkRepository,
                            TripRepository tripRepository,
                            TripMemberRepository tripMemberRepository,
                            TripAccessGuard tripAccessGuard,
                            ShareTokenService shareTokenService,
                            TripEventPublisher tripEventPublisher,
                            GuestSessionAccessService guestSessionAccessService,
                            AppProperties appProperties) {
        this.shareLinkRepository = shareLinkRepository;
        this.tripRepository = tripRepository;
        this.tripMemberRepository = tripMemberRepository;
        this.tripAccessGuard = tripAccessGuard;
        this.shareTokenService = shareTokenService;
        this.tripEventPublisher = tripEventPublisher;
        this.guestSessionAccessService = guestSessionAccessService;
        this.shareUrlOrigin = shareUrlOrigin(appProperties);
    }

    @Transactional
    public CreateShareLinkResponse create(String publicId, Long userId, CreateShareLinkRequest request) {
        validateRequestedLink(request);
        ResolvedTrip resolved = tripAccessGuard.resolveForUserAtLeast(publicId, userId, TripRole.EDITOR);

        GeneratedToken token = generateUniqueToken();
        ShareLink link = new ShareLink(
            resolved.trip().getId(),
            token.hash(),
            request.role(),
            normalizeLinkNameOrDefault(request.name()),
            request.allowAnonymous(),
            userId,
            request.expiresAt());
        ShareLink saved = shareLinkRepository.save(link);
        tripEventPublisher.publishAfterCommit(
            resolved.trip().getId(), TripEvent.shareLinksChanged(publicId));
        return CreateShareLinkResponse.of(saved, shareUrl(token.raw()));
    }

    @Transactional(readOnly = true)
    public List<ShareLinkResponse> list(String publicId, Long userId) {
        ResolvedTrip resolved = tripAccessGuard.resolveForUserAtLeast(publicId, userId, TripRole.EDITOR);
        return shareLinkRepository.findSummariesByTripId(resolved.trip().getId()).stream()
            .map(ShareLinkResponse::of)
            .toList();
    }

    @Transactional
    public void revoke(String publicId, Long userId, Long linkId) {
        ResolvedTrip resolved = tripAccessGuard.resolveForUserAtLeast(publicId, userId, TripRole.EDITOR);
        ShareLink link = findLinkOnTrip(linkId, resolved.trip().getId());
        shareLinkRepository.delete(link);
        tripEventPublisher.publishAndDisconnectAfterCommit(
            resolved.trip().getId(), TripEvent.shareLinksChanged(publicId));
    }

    @Transactional
    public ShareLinkResponse rename(String publicId, Long userId, Long linkId, String name) {
        ResolvedTrip resolved = tripAccessGuard.resolveForUserAtLeast(publicId, userId, TripRole.EDITOR);
        ShareLink link = findLinkOnTrip(linkId, resolved.trip().getId());
        link.setName(normalizeRequiredLinkName(name));
        ShareLink saved = shareLinkRepository.save(link);
        tripEventPublisher.publishAfterCommit(
            resolved.trip().getId(), TripEvent.shareLinksChanged(publicId));
        return ShareLinkResponse.of(saved);
    }

    @Transactional
    public AcceptShareLinkResponse acceptForUser(String rawToken, Long userId) {
        ShareLink link = findUsableLink(rawToken);
        Trip trip = tripRepository.findById(link.getTripId())
            .orElseThrow(() -> new NotFoundException("trip not found for share link: id=" + link.getId()));

        TripRole effectiveRole = upsertMembership(trip.getId(), userId, link.getRole());
        return new AcceptShareLinkResponse(trip.getPublicId(), effectiveRole);
    }

    @Transactional
    public AcceptedGuestSession acceptForGuest(String rawToken, String requestedDisplayName) {
        ShareLink link = findUsableLink(rawToken);
        if (!link.isAllowAnonymous()) {
            throw new NotFoundException("share link does not allow anonymous guests: id=" + link.getId());
        }
        Trip trip = tripRepository.findById(link.getTripId())
            .orElseThrow(() -> new NotFoundException("trip not found for share link: id=" + link.getId()));
        String displayName = sanitizeGuestDisplayName(requestedDisplayName);
        GuestSessionAccessService.IssuedGuestSession guestSession =
            guestSessionAccessService.issue(link.getId(), displayName);
        return new AcceptedGuestSession(
            guestSession.rawGuestToken(),
            new AcceptGuestShareLinkResponse(trip.getPublicId(), link.getRole(), displayName));
    }

    @Transactional
    public TripResponse claimGuestSession(String rawGuestToken, Long userId) {
        GuestSessionAccessService.ClaimedGuestSession claimed =
            guestSessionAccessService.claim(rawGuestToken, userId);
        tripEventPublisher.publishAndDisconnectAfterCommit(
            claimed.trip().getId(), TripEvent.membersChanged(claimed.trip().getPublicId()));
        return TripResponse.of(claimed.trip(), claimed.effectiveRole());
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

    private ShareLink findUsableLink(String rawToken) {
        String hash = shareTokenService.sha256Hex(rawToken);
        ShareLink link = shareLinkRepository.findByTokenHash(hash)
            .orElseThrow(() -> new NotFoundException("share link not found"));
        requireUsableLink(link);
        return link;
    }

    private static void requireUsableLink(ShareLink link) {
        OffsetDateTime now = OffsetDateTime.now();
        if (link.getRevokedAt() != null) {
            throw new NotFoundException("share link revoked: id=" + link.getId());
        }
        if (link.getExpiresAt() != null && !link.getExpiresAt().isAfter(now)) {
            throw new NotFoundException("share link expired: id=" + link.getId());
        }
    }

    private ShareLink findLinkOnTrip(Long linkId, Long tripId) {
        ShareLink link = shareLinkRepository.findById(linkId)
            .orElseThrow(() -> new NotFoundException("share link not found: id=" + linkId));
        if (!link.getTripId().equals(tripId)) {
            throw new NotFoundException("share link trip mismatch: id=" + linkId);
        }
        return link;
    }

    private void validateRequestedLink(CreateShareLinkRequest request) {
        if (request.role() == TripRole.OWNER) {
            throw new ValidationException("invalid_share_role", "share links cannot grant OWNER");
        }
        if (request.expiresAt() != null && !request.expiresAt().isAfter(OffsetDateTime.now())) {
            throw new ValidationException("invalid_expiration", "expiresAt must be in the future");
        }
    }

    private GeneratedToken generateUniqueToken() {
        for (int attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt++) {
            String raw = shareTokenService.generateRawToken();
            String hash = shareTokenService.sha256Hex(raw);
            if (shareLinkRepository.findByTokenHash(hash).isEmpty()) {
                return new GeneratedToken(raw, hash);
            }
        }
        throw new IllegalStateException("exhausted share token generation retries");
    }

    private static String sanitizeGuestDisplayName(String displayName) {
        String sanitized = DisplayNameSanitizer.sanitize(displayName);
        if (sanitized == null || sanitized.isBlank()) {
            throw new ValidationException("invalid_display_name", "displayName cannot be blank");
        }
        return sanitized;
    }

    private static String normalizeLinkNameOrDefault(String name) {
        String sanitized = DisplayNameSanitizer.sanitize(name);
        if (sanitized == null || sanitized.isBlank()) {
            return ShareLink.DEFAULT_NAME;
        }
        return sanitized;
    }

    private static String normalizeRequiredLinkName(String name) {
        String sanitized = DisplayNameSanitizer.sanitize(name);
        if (sanitized == null || sanitized.isBlank()) {
            throw new ValidationException("invalid_share_link_name", "name cannot be blank");
        }
        return sanitized;
    }

    private String shareUrl(String rawToken) {
        String trimmedOrigin = shareUrlOrigin == null ? "" : shareUrlOrigin.strip();
        if (trimmedOrigin.isEmpty()) {
            return "/share/" + rawToken;
        }
        while (trimmedOrigin.endsWith("/")) {
            trimmedOrigin = trimmedOrigin.substring(0, trimmedOrigin.length() - 1);
        }
        return trimmedOrigin + "/share/" + rawToken;
    }

    private static String shareUrlOrigin(AppProperties appProperties) {
        String publicFrontendUrl = appProperties.getPublicFrontendUrl();
        if (publicFrontendUrl != null && !publicFrontendUrl.isBlank()) {
            return publicFrontendUrl;
        }
        String frontendOrigin = appProperties.getFrontendOrigin();
        if (frontendOrigin == null || frontendOrigin.isBlank()) {
            return "";
        }
        int comma = frontendOrigin.indexOf(',');
        return comma < 0 ? frontendOrigin : frontendOrigin.substring(0, comma);
    }

    private record GeneratedToken(String raw, String hash) {
    }

    public record AcceptedGuestSession(String rawGuestToken, AcceptGuestShareLinkResponse response) {
    }
}
