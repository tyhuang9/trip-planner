package com.trip.config;

import java.time.Duration;
import java.util.Locale;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Strongly-typed view of the {@code app.*} tree in application.yml. Everything here
 * is pulled from environment variables; hard-coded defaults would be a security
 * smell. Missing values are validated at boot by {@link AppPropertiesValidator}.
 */
@ConfigurationProperties(prefix = "app")
public class AppProperties {

    /** Comma-separated list of exact origins allowed by CORS. */
    private String frontendOrigin = "";

    /** Comma-separated native WebView origins allowed by CORS. */
    private String nativeAllowedOrigins = "";

    /** Public frontend origin used to build links sent in transactional emails. */
    private String publicFrontendUrl = "";

    /** Hex-encoded HS256 secret; must decode to at least 32 bytes. */
    private String jwtSecret = "";

    /** Hex pepper used when hashing emails for log lines. */
    private String logEmailPepper = "";

    /** Cookie-related toggles. */
    private Cookies cookies = new Cookies();

    /** Anonymous guest-session credential lifecycle. */
    private GuestSession guestSession = new GuestSession();

    /** Enables open signup. Prod should keep this true only when email is configured. */
    private boolean signupEnabled = true;

    /** Transactional auth email configuration. */
    private Email email = new Email();

    /** Backend-only Google Maps API key for server-side Google Maps web service calls. */
    private String googleMapsServerApiKey = "";

    /** Server-side Places details cache configuration. */
    private PlaceDetails placeDetails = new PlaceDetails();

    /** Server-side Google Maps cache configuration. */
    private GoogleMapsCache googleMapsCache = new GoogleMapsCache();

    /** Realtime stream lifecycle configuration. */
    private Realtime realtime = new Realtime();

    /**
     * If {@code true}, trust {@code X-Forwarded-For} for client-IP resolution. Default
     * {@code false}: when the app is exposed directly (no reverse proxy in front), an
     * attacker can otherwise spoof their rate-limit key by sending the header. Set to
     * {@code true} only behind a proxy that overwrites (not appends) the header — Fly
     * and Vercel both do this; nginx by default does not.
     */
    private boolean trustProxy = false;

    public String getFrontendOrigin() {
        return frontendOrigin;
    }

    public void setFrontendOrigin(String frontendOrigin) {
        this.frontendOrigin = frontendOrigin == null ? "" : frontendOrigin;
    }

    public String getNativeAllowedOrigins() {
        return nativeAllowedOrigins;
    }

    public void setNativeAllowedOrigins(String nativeAllowedOrigins) {
        this.nativeAllowedOrigins = nativeAllowedOrigins == null ? "" : nativeAllowedOrigins;
    }

    public String getPublicFrontendUrl() {
        return publicFrontendUrl;
    }

    public void setPublicFrontendUrl(String publicFrontendUrl) {
        this.publicFrontendUrl = publicFrontendUrl == null ? "" : publicFrontendUrl;
    }

    public String getJwtSecret() {
        return jwtSecret;
    }

    public void setJwtSecret(String jwtSecret) {
        this.jwtSecret = jwtSecret == null ? "" : jwtSecret;
    }

    public String getLogEmailPepper() {
        return logEmailPepper;
    }

    public void setLogEmailPepper(String logEmailPepper) {
        this.logEmailPepper = logEmailPepper == null ? "" : logEmailPepper;
    }

    public Cookies getCookies() {
        return cookies;
    }

    public void setCookies(Cookies cookies) {
        this.cookies = cookies == null ? new Cookies() : cookies;
    }

    public GuestSession getGuestSession() {
        return guestSession;
    }

    public void setGuestSession(GuestSession guestSession) {
        this.guestSession = guestSession == null ? new GuestSession() : guestSession;
    }

    public boolean isSignupEnabled() {
        return signupEnabled;
    }

    public void setSignupEnabled(boolean signupEnabled) {
        this.signupEnabled = signupEnabled;
    }

    public Email getEmail() {
        return email;
    }

    public void setEmail(Email email) {
        this.email = email == null ? new Email() : email;
    }

    public String getGoogleMapsServerApiKey() {
        return googleMapsServerApiKey;
    }

    public void setGoogleMapsServerApiKey(String googleMapsServerApiKey) {
        this.googleMapsServerApiKey = googleMapsServerApiKey == null ? "" : googleMapsServerApiKey;
    }

    public PlaceDetails getPlaceDetails() {
        return placeDetails;
    }

    public void setPlaceDetails(PlaceDetails placeDetails) {
        this.placeDetails = placeDetails == null ? new PlaceDetails() : placeDetails;
    }

    public GoogleMapsCache getGoogleMapsCache() {
        return googleMapsCache;
    }

    public void setGoogleMapsCache(GoogleMapsCache googleMapsCache) {
        this.googleMapsCache = googleMapsCache == null ? new GoogleMapsCache() : googleMapsCache;
    }

    public Realtime getRealtime() {
        return realtime;
    }

    public void setRealtime(Realtime realtime) {
        this.realtime = realtime == null ? new Realtime() : realtime;
    }

    public boolean isTrustProxy() {
        return trustProxy;
    }

    public void setTrustProxy(boolean trustProxy) {
        this.trustProxy = trustProxy;
    }

    /** Transactional auth email provider configuration. */
    public static class Email {
        private String brevoApiKey = "";
        private String fromEmail = "";
        private String fromName = "Dupert";

        public String getBrevoApiKey() {
            return brevoApiKey;
        }

        public void setBrevoApiKey(String brevoApiKey) {
            this.brevoApiKey = brevoApiKey == null ? "" : brevoApiKey;
        }

        public String getFromEmail() {
            return fromEmail;
        }

        public void setFromEmail(String fromEmail) {
            this.fromEmail = fromEmail == null ? "" : fromEmail;
        }

        public String getFromName() {
            return fromName;
        }

        public void setFromName(String fromName) {
            this.fromName = fromName == null || fromName.isBlank() ? "Dupert" : fromName;
        }
    }

    /** Places details cache TTLs. */
    public static class PlaceDetails {
        private Duration basicTtl = Duration.ofDays(7);
        private Duration expandedTtl = Duration.ofDays(1);

        public Duration getBasicTtl() {
            return basicTtl;
        }

        public void setBasicTtl(Duration basicTtl) {
            this.basicTtl = basicTtl == null ? Duration.ofDays(7) : basicTtl;
        }

        public Duration getExpandedTtl() {
            return expandedTtl;
        }

        public void setExpandedTtl(Duration expandedTtl) {
            this.expandedTtl = expandedTtl == null ? Duration.ofDays(1) : expandedTtl;
        }
    }

    /** Cache TTLs for non-details Google Maps requests proxied through the backend. */
    public static class GoogleMapsCache {
        private Duration searchTtl = Duration.ofMinutes(15);
        private Duration geocodeTtl = Duration.ofDays(30);
        private Duration routeTtl = Duration.ofHours(1);
        private Duration photoTtl = Duration.ofDays(1);

        public Duration getSearchTtl() {
            return searchTtl;
        }

        public void setSearchTtl(Duration searchTtl) {
            this.searchTtl = searchTtl == null ? Duration.ofMinutes(15) : searchTtl;
        }

        public Duration getGeocodeTtl() {
            return geocodeTtl;
        }

        public void setGeocodeTtl(Duration geocodeTtl) {
            this.geocodeTtl = geocodeTtl == null ? Duration.ofDays(30) : geocodeTtl;
        }

        public Duration getRouteTtl() {
            return routeTtl;
        }

        public void setRouteTtl(Duration routeTtl) {
            this.routeTtl = routeTtl == null ? Duration.ofHours(1) : routeTtl;
        }

        public Duration getPhotoTtl() {
            return photoTtl;
        }

        public void setPhotoTtl(Duration photoTtl) {
            this.photoTtl = photoTtl == null ? Duration.ofDays(1) : photoTtl;
        }
    }

    /** Heartbeat, stale-detection, and forced-renewal intervals for SSE streams. */
    public static class Realtime {
        private Duration heartbeatInterval = Duration.ofSeconds(15);
        private Duration staleAfter = Duration.ofSeconds(30);
        private Duration maxLifetime = Duration.ofMinutes(2);

        public Duration getHeartbeatInterval() {
            return heartbeatInterval;
        }

        public void setHeartbeatInterval(Duration heartbeatInterval) {
            this.heartbeatInterval = heartbeatInterval == null
                ? Duration.ofSeconds(15)
                : heartbeatInterval;
        }

        public Duration getStaleAfter() {
            return staleAfter;
        }

        public void setStaleAfter(Duration staleAfter) {
            this.staleAfter = staleAfter == null ? Duration.ofSeconds(30) : staleAfter;
        }

        public Duration getMaxLifetime() {
            return maxLifetime;
        }

        public void setMaxLifetime(Duration maxLifetime) {
            this.maxLifetime = maxLifetime == null ? Duration.ofMinutes(2) : maxLifetime;
        }
    }

    /** Lifetime shared by persisted guest credentials and their browser cookie. */
    public static class GuestSession {
        private Duration ttl = Duration.ofDays(14);

        public Duration getTtl() {
            return ttl;
        }

        public void setTtl(Duration ttl) {
            this.ttl = ttl == null || ttl.isZero() || ttl.isNegative()
                ? Duration.ofDays(14)
                : ttl;
        }
    }

    /**
     * Cookie attribute toggles. {@code secure} is {@code false} in dev (HTTP localhost)
     * and {@code true} in prod via the active profile.
     */
    public static class Cookies {
        private boolean secure = false;
        private String sameSite = "Strict";

        public boolean isSecure() {
            return secure;
        }

        public void setSecure(boolean secure) {
            this.secure = secure;
        }

        public String getSameSite() {
            return sameSite;
        }

        public void setSameSite(String sameSite) {
            if (sameSite == null || sameSite.isBlank()) {
                this.sameSite = "Strict";
                return;
            }
            this.sameSite = switch (sameSite.trim().toLowerCase(Locale.ROOT)) {
                case "strict" -> "Strict";
                case "lax" -> "Lax";
                case "none" -> "None";
                default -> sameSite.trim();
            };
        }
    }
}
