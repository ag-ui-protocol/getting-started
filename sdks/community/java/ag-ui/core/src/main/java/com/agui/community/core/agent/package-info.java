/**
 * Agent run types for the AG-UI protocol.
 *
 * <p>{@link com.agui.community.core.agent.RunAgentInput} is the payload an agent
 * receives for a single run, bundling the conversation
 * {@link com.agui.community.core.message.Message messages},
 * available {@link com.agui.community.core.tool.Tool tools},
 * {@link com.agui.community.core.agent.Context} entries and state. An agent
 * responds by emitting a stream of {@link com.agui.community.core.event.Event}s.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/agents">AG-UI Agents</a>
 */
package com.agui.community.core.agent;
