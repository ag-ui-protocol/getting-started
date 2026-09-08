package com.agui.community.spring.ai.boot;

import static org.assertj.core.api.Assertions.assertThat;

import com.agui.community.core.agent.Agent;
import com.agui.community.spring.ai.SpringAiAgent;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import reactor.core.publisher.Flux;

class AgUiSpringAiAutoConfigurationTest {

    private static final Agent USER_AGENT = input -> subscriber -> { };

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(AgUiSpringAiAutoConfiguration.class));

    @Test
    void registersSpringAiAgentFromTheChatClientBuilder() {
        runner.withUserConfiguration(ChatClientBuilderConfig.class)
                .run(context -> {
                    assertThat(context).hasSingleBean(Agent.class);
                    assertThat(context.getBean(Agent.class)).isInstanceOf(SpringAiAgent.class);
                });
    }

    @Test
    void backsOffWhenAnAgentIsAlreadyDefined() {
        runner.withUserConfiguration(ChatClientBuilderConfig.class, UserAgentConfig.class)
                .run(context -> {
                    assertThat(context).hasSingleBean(Agent.class);
                    assertThat(context.getBean(Agent.class)).isSameAs(USER_AGENT);
                });
    }

    @Test
    void registersNoAgentWithoutAChatClientBuilder() {
        runner.run(context -> assertThat(context).doesNotHaveBean(Agent.class));
    }

    @Configuration
    static class ChatClientBuilderConfig {
        @Bean
        ChatClient.Builder chatClientBuilder() {
            return ChatClient.builder(stubChatModel());
        }
    }

    @Configuration
    static class UserAgentConfig {
        @Bean
        Agent agent() {
            return USER_AGENT;
        }
    }

    private static ChatModel stubChatModel() {
        return new ChatModel() {
            @Override
            public ChatResponse call(Prompt prompt) {
                return new ChatResponse(List.of());
            }

            @Override
            public Flux<ChatResponse> stream(Prompt prompt) {
                return Flux.empty();
            }
        };
    }
}
