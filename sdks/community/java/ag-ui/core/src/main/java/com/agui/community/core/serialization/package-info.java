/**
 * Serialization abstraction for the AG-UI protocol.
 *
 * <p>The {@link com.agui.community.core.serialization.Serializer} interface
 * decouples the {@code core} types from any concrete JSON library; integration
 * modules provide implementations (e.g. backed by Jackson or Spring). Failures
 * are surfaced as {@link com.agui.community.core.serialization.SerializationException}.
 */
package com.agui.community.core.serialization;
