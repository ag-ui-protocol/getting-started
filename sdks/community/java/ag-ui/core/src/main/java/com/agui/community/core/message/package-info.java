/**
 * Message types for the AG-UI protocol.
 *
 * <p>The {@link com.agui.community.core.message.Message} sealed interface models a
 * single conversation message; its permitted implementations
 * ({@link com.agui.community.core.message.DeveloperMessage},
 * {@link com.agui.community.core.message.SystemMessage},
 * {@link com.agui.community.core.message.AssistantMessage},
 * {@link com.agui.community.core.message.UserMessage} and
 * {@link com.agui.community.core.message.ToolMessage}) correspond to the message
 * types described in the AG-UI documentation.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/messages">AG-UI Messages</a>
 */
package com.agui.community.core.message;
