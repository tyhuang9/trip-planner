package com.trip.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;

class RequestTimingFilterTest {

    private static final String MALFORMED_TOKEN = "malformed.token";
    private static final String OVERSIZED_TOKEN = "a".repeat(201);

    @Test
    void redactsLegacyTokenFromFastDebugLog() throws Exception {
        List<ILoggingEvent> events = capture(new FixedTimingFilter(0L, 10_000_000L),
            "/api/share/" + MALFORMED_TOKEN + "/accept", Level.DEBUG);

        assertThat(events).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.DEBUG);
            assertThat(event.getFormattedMessage())
                .contains("path=/api/share/{token}/accept")
                .doesNotContain(MALFORMED_TOKEN);
        });
    }

    @Test
    void redactsLegacyTokenFromSlowInfoLogWithoutSleeping() throws Exception {
        List<ILoggingEvent> events = capture(new FixedTimingFilter(0L, 500_000_000L),
            "/api/share/" + OVERSIZED_TOKEN + "/guest", Level.INFO);

        assertThat(events).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.INFO);
            assertThat(event.getFormattedMessage())
                .contains("path=/api/share/{token}/guest")
                .doesNotContain(OVERSIZED_TOKEN);
        });
    }

    @Test
    void doesNotRedactUnrelatedOrMalformedPaths() {
        assertThat(RequestTimingFilter.observablePath("/api/trips/abc/accept"))
            .isEqualTo("/api/trips/abc/accept");
        assertThat(RequestTimingFilter.observablePath("/api/share//accept"))
            .isEqualTo("/api/share//accept");
        assertThat(RequestTimingFilter.observablePath("/api/share/accept"))
            .isEqualTo("/api/share/accept");
    }

    private static List<ILoggingEvent> capture(RequestTimingFilter filter, String path, Level level)
            throws Exception {
        Logger logger = (Logger) LoggerFactory.getLogger(RequestTimingFilter.class);
        Level previousLevel = logger.getLevel();
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.setLevel(level);
        logger.addAppender(appender);
        try {
            filter.doFilter(
                new MockHttpServletRequest("POST", path),
                new MockHttpServletResponse(),
                (_request, _response) -> { });
            return List.copyOf(appender.list);
        } finally {
            logger.detachAppender(appender);
            logger.setLevel(previousLevel);
            appender.stop();
        }
    }

    private static final class FixedTimingFilter extends RequestTimingFilter {
        private final long[] times;
        private final AtomicInteger index = new AtomicInteger();

        private FixedTimingFilter(long... times) {
            this.times = times;
        }

        @Override
        protected long nanoTime() {
            return times[index.getAndIncrement()];
        }
    }
}
