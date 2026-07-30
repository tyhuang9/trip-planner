package com.trip.service.trip;

import java.util.Optional;

import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.AuthenticationCredentialsNotFoundException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.trip.domain.Trip;
import com.trip.domain.TripMember;
import com.trip.domain.TripRole;
import com.trip.repo.TripMemberRepository;
import com.trip.repo.TripRepository;
import com.trip.service.share.GuestSessionAccessService;
import com.trip.web.exception.NotFoundException;

/**
 * The single chokepoint that gates every {@code /api/trips/**} request — see PROJECT.md
 * §5: "Possession of a URL is never enough to view or edit a trip." Every miss collapses
 * to {@link NotFoundException}: a non-member must not be able to distinguish "trip
 * doesn't exist" from "trip exists but I'm not on it" — that distinction would make
 * {@code publicId} an enumerable existence oracle.
 *
 * <p>Both member JWTs and anonymous guest credentials converge here. Guest access is
 * revalidated against the persisted session and share-link lifecycle on every request.
 */
@Service
public class TripAccessGuard {

    private final TripRepository tripRepository;
    private final TripMemberRepository tripMemberRepository;
    private final GuestSessionAccessService guestSessionAccessService;

    public TripAccessGuard(TripRepository tripRepository,
                           TripMemberRepository tripMemberRepository,
                           GuestSessionAccessService guestSessionAccessService) {
        this.tripRepository = tripRepository;
        this.tripMemberRepository = tripMemberRepository;
        this.guestSessionAccessService = guestSessionAccessService;
    }

    /**
     * Resolves the trip if {@code userId} is a member, otherwise throws
     * {@link NotFoundException}. The 404 (not 403) is deliberate per PROJECT.md §5.
     */
    @Transactional(readOnly = true)
    public ResolvedTrip resolveForUser(String publicId, Long userId) {
        Trip trip = tripRepository.findByPublicId(publicId)
            .orElseThrow(() -> new NotFoundException("trip not found: publicId=" + publicId));

        Optional<TripMember> membership =
            tripMemberRepository.findByIdTripIdAndIdUserId(trip.getId(), userId);

        return membership
            .map(m -> new ResolvedTrip(trip, m.getRole()))
            .orElseThrow(() -> new NotFoundException(
                "user is not a member: userId=" + userId + " tripId=" + trip.getId()));
    }

    /**
     * Like {@link #resolveForUser}, but additionally requires the caller's role be at
     * least {@code minimumRole} (OWNER &gt; EDITOR &gt; VIEWER, by {@link TripRole#rank()}).
     * A member with too low a role gets the same {@link NotFoundException} as a
     * non-member — no information leak about the privilege tier.
     */
    @Transactional(readOnly = true)
    public ResolvedTrip resolveForUserAtLeast(String publicId, Long userId, TripRole minimumRole) {
        ResolvedTrip resolved = resolveForUser(publicId, userId);
        if (resolved.role().rank() < minimumRole.rank()) {
            throw new NotFoundException(
                "role too low: userId=" + userId
                    + " tripId=" + resolved.trip().getId()
                    + " has=" + resolved.role()
                    + " needs=" + minimumRole);
        }
        return resolved;
    }

    @Transactional(readOnly = true)
    public ResolvedTrip resolveForActor(String publicId, TripActor actor) {
        if (actor.isUser()) {
            return resolveForUser(publicId, actor.userId());
        }
        if (actor.isGuest()) {
            return resolveForGuest(publicId, actor.guestSessionToken());
        }
        throw new AuthenticationCredentialsNotFoundException("no trip actor");
    }

    @Transactional(readOnly = true)
    public ResolvedTrip resolveForActorAtLeast(String publicId, TripActor actor, TripRole minimumRole) {
        if (actor.isUser()) {
            return resolveForUserAtLeast(publicId, actor.userId(), minimumRole);
        }
        if (actor.isGuest()) {
            ResolvedTrip resolved = resolveForGuest(publicId, actor.guestSessionToken());
            if (resolved.role().rank() < minimumRole.rank()) {
                throw new AccessDeniedException("guest role too low");
            }
            return resolved;
        }
        throw new AuthenticationCredentialsNotFoundException("no trip actor");
    }

    @Transactional(readOnly = true)
    public ResolvedTrip resolveForGuest(String publicId, String rawGuestToken) {
        GuestSessionAccessService.ResolvedGuestSession guest;
        try {
            guest = guestSessionAccessService.resolve(rawGuestToken);
        } catch (NotFoundException missingLifecycle) {
            throw new AuthenticationCredentialsNotFoundException(
                "invalid guest session", missingLifecycle);
        }
        if (!publicId.equals(guest.publicId())) {
            throw new NotFoundException("guest token does not grant this trip");
        }
        Trip trip = tripRepository.findByPublicId(publicId)
            .orElseThrow(() -> new NotFoundException("trip not found: publicId=" + publicId));
        if (!trip.getId().equals(guest.tripId())) {
            throw new NotFoundException("guest token does not grant this trip");
        }
        return new ResolvedTrip(trip, guest.role(), guest.guestSessionId());
    }
}
