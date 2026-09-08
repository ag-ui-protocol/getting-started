/**
 * Spring WebMVC (Servlet) integration for the AG-UI protocol: a controller that
 * streams an {@link com.agui.community.core.agent.Agent}'s events as Server-Sent
 * Events via an {@code SseEmitter}, a Jackson-backed
 * {@link com.agui.community.core.serialization.Serializer} configured for the
 * AG-UI sealed hierarchies, and Spring Boot auto-configuration to wire them
 * together. It is the Servlet counterpart to {@code ag-ui-spring-webflux-server}.
 */
package com.agui.community.spring.webmvc;
