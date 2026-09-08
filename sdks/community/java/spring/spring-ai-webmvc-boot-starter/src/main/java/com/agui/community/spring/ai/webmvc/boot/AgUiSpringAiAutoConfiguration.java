package com.agui.community.spring.ai.webmvc.boot;

import com.agui.community.core.agent.Agent;
import com.agui.community.spring.ai.SpringAiAgent;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * Auto-configuration that adapts a Spring AI {@link ChatClient} into an AG-UI
 * {@link Agent}, for the Servlet (WebMVC) server. This is the WebMVC counterpart of
 * {@code com.agui.community.spring.ai.boot.AgUiSpringAiAutoConfiguration} (WebFlux);
 * the only difference is that it is ordered before the Servlet server
 * auto-configuration. When a {@link ChatClient.Builder} bean is present (Spring AI
 * auto-configures one whenever a chat model is on the classpath) and the application
 * has not defined its own {@code Agent}, it builds a default {@link ChatClient} and
 * registers a {@link SpringAiAgent}.
 *
 * <p>Ordering matters: it runs <em>after</em> Spring AI's
 * {@code ChatClientAutoConfiguration} (which registers the {@code ChatClient.Builder}
 * this configuration consumes) and <em>before</em> the WebMVC
 * {@code AgUiServerAutoConfiguration} (so the contributed agent exists when the
 * server wires the AG-UI endpoint). Together they expose a Spring AI model over
 * AG-UI with no application code. To customise the client (advisors, memory, default
 * prompts, tools), define your own {@code Agent} bean from a {@code ChatClient.Builder}.
 *
 * <p>Set {@code ag-ui.spring-ai.share-state=true} to enable AG-UI shared state
 * (the {@code update_state} tool and state events). With
 * {@code ag-ui.spring-ai.state-updates=DELTA}, state changes are emitted as a
 * {@code STATE_DELTA} (RFC 6902 JSON Patch) instead of a full {@code STATE_SNAPSHOT}.
 */
@AutoConfiguration(
        afterName = "org.springframework.ai.model.chat.client.autoconfigure.ChatClientAutoConfiguration",
        beforeName = "com.agui.community.spring.webmvc.AgUiServerAutoConfiguration")
@ConditionalOnClass({ChatClient.class, SpringAiAgent.class})
public class AgUiSpringAiAutoConfiguration {

    @Bean
    @ConditionalOnBean(ChatClient.Builder.class)
    @ConditionalOnMissingBean(Agent.class)
    public Agent springAiAgent(ChatClient.Builder chatClientBuilder,
            @Value("${ag-ui.spring-ai.share-state:false}") boolean shareState,
            @Value("${ag-ui.spring-ai.state-updates:SNAPSHOT}") SpringAiAgent.StateUpdates stateUpdates) {
        return SpringAiAgent.builder(chatClientBuilder.build())
                .shareState(shareState)
                .stateUpdates(stateUpdates)
                .build();
    }
}
