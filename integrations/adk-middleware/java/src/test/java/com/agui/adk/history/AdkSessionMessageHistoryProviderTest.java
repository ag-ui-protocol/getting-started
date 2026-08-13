package com.agui.adk.history;

import com.google.adk.events.Event;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import com.agui.community.core.message.AssistantMessage;
import com.agui.community.core.message.Message;
import com.agui.community.core.message.UserMessage;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Row 1.3 delta/message snapshots — the default ADK-session provider replays the full
 * assistant history from its own session memory (ADK session events), like Python's
 * {@code adk_events_to_messages(session.events)} snapshot, instead of being conservative.
 */
class AdkSessionMessageHistoryProviderTest {

    @Test
    void replaysRepresentableSessionEventsAsACompleteHistory() {
        Event user = Event.builder().author("user")
                .content(Content.builder().role("user")
                        .parts(List.of(Part.builder().text("Earlier question").build())).build())
                .build();
        Event assistant = Event.builder().author("model")
                .content(Content.builder().role("model")
                        .parts(List.of(Part.builder().text("Earlier answer").build())).build())
                .build();
        Session session = Session.builder("session").appName("app").userId("user")
                .state(Map.of())
                .events(List.of(user, assistant))
                .build();

        MessageHistoryProvider provider = new AdkSessionMessageHistoryProvider();
        assertThat(provider.providesCompleteHistory()).isTrue();
        MessageHistoryProvider.Result result = provider.history(session).blockingGet();

        assertThat(result.complete()).isTrue();
        assertThat(result.messages()).hasSize(2);
        assertThat(result.messages().get(0)).isInstanceOf(UserMessage.class);
        assertThat(result.messages().get(0).content()).isEqualTo("Earlier question");
        assertThat(result.messages().get(1)).isInstanceOf(AssistantMessage.class);
        assertThat(result.messages().get(1).content()).isEqualTo("Earlier answer");
    }

    @Test
    void emptySessionHistoryIsUnavailableRatherThanAFalseSnapshot() {
        Session session = Session.builder("session").appName("app").userId("user")
                .state(Map.of()).events(List.of()).build();

        MessageHistoryProvider.Result result =
                new AdkSessionMessageHistoryProvider().history(session).blockingGet();

        assertThat(result.complete()).isFalse();
        assertThat(result.messages()).isEmpty();
    }
}
