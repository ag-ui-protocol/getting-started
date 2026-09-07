package com.agui.adk.a2ui;

import com.agui.community.core.event.Event;
import com.agui.community.core.event.TextMessageContentEvent;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.Test;

import java.util.concurrent.LinkedBlockingQueue;

import static org.assertj.core.api.Assertions.assertThat;

class A2uiQueueDrainBackpressureTest {

    @Test
    void removesOnlyRequestedEventsFromTheNestedQueue() {
        LinkedBlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        queue.add(new TextMessageContentEvent("message-1", "one"));
        queue.add(new TextMessageContentEvent("message-1", "two"));
        queue.add(A2uiQueueDrain.terminal());
        TestSubscriber<Event> subscriber = A2uiQueueDrain.drain(queue).test(0L);

        assertThat(queue).hasSize(3);
        subscriber.request(1);
        assertThat(subscriber.values()).hasSize(1);
        assertThat(queue).hasSize(2);
        subscriber.request(1);
        assertThat(subscriber.values()).hasSize(2);
        assertThat(queue).hasSize(1);
        subscriber.request(1);
        subscriber.assertComplete();
        assertThat(queue).isEmpty();
    }
}
