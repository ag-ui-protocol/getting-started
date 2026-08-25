/**
 * Event types for the AG-UI protocol.
 *
 * <p>The {@link com.agui.community.core.event.Event} sealed interface models a
 * single event emitted by an agent; each permitted implementation corresponds to
 * one of the event types described in the AG-UI documentation, grouped into
 * lifecycle, text message, tool call, reasoning, state management, activity and
 * special categories. The {@link com.agui.community.core.event.EventType} enum is
 * the discriminator carried by every event.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
package com.agui.community.core.event;
