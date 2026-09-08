package com.agui.community.spring.server.core.jackson;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonSubTypes.Type;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.agui.community.core.interrupt.InterruptOutcome;
import com.agui.community.core.interrupt.SuccessOutcome;

/**
 * Jackson mix-in that maps the {@link com.agui.community.core.interrupt.RunOutcome}
 * sealed hierarchy to its {@code type} discriminator on the wire
 * ({@code "success"} / {@code "interrupt"}), matching
 * {@link com.agui.community.core.interrupt.OutcomeType}. Applied to {@code RunOutcome}
 * via {@code ObjectMapper#addMixIn} so the {@code core} module stays free of Jackson
 * annotations.
 *
 * <p>The concrete outcomes are records whose {@code type()} is an interface method
 * (not a record component), so Jackson does not expose it as a property and writes
 * the {@code type} discriminator itself.
 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
        @Type(value = SuccessOutcome.class, name = "success"),
        @Type(value = InterruptOutcome.class, name = "interrupt"),
})
public interface RunOutcomeMixin {
}
