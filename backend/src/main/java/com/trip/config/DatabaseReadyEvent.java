package com.trip.config;

/** Published after connectivity and migrations have completed. */
public record DatabaseReadyEvent(Object source) {
}
