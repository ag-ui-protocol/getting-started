package com.agui.community.spring.server.core.jackson;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonSubTypes.Type;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.DeveloperMessage;
import com.agui.community.core.message.SystemMessage;
import com.agui.community.core.message.ToolMessage;
import com.agui.community.core.message.UserMessage;

/**
 * Jackson mix-in that maps the {@link com.agui.community.core.message.Message}
 * sealed hierarchy to its {@code role} discriminator on the wire. The subtype
 * names match the wire values of {@link com.agui.community.core.message.Role}.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "role")
@JsonSubTypes({
        @Type(value = DeveloperMessage.class, name = "developer"),
        @Type(value = SystemMessage.class, name = "system"),
        @Type(value = AssistantMessage.class, name = "assistant"),
        @Type(value = UserMessage.class, name = "user"),
        @Type(value = ToolMessage.class, name = "tool"),
})
public interface MessageMixin {
}
