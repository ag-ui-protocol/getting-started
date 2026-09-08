/**
 * Framework-agnostic support shared by the AG-UI Spring server modules
 * (WebFlux and WebMVC): a Jackson-backed
 * {@link com.agui.community.core.serialization.Serializer} configured for the
 * AG-UI sealed hierarchies, and the {@link
 * com.agui.community.spring.server.core.AgentNotFoundException} each controller
 * maps to {@code 404}. This module has no Spring dependency.
 */
package com.agui.community.spring.server.core;
