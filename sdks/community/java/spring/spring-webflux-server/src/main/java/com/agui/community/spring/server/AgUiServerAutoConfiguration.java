package com.agui.community.spring.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.AgentRegistry;
import com.agui.community.spring.server.core.JacksonSerializer;
import java.util.Map;
import java.util.Objects;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication.Type;
import org.springframework.context.annotation.Bean;

/**
 * Auto-configuration that exposes the application's {@link Agent} beans as a
 * reactive (WebFlux) AG-UI endpoint. Activated only in a reactive web
 * application; the Servlet counterpart lives in
 * {@code ag-ui-spring-webmvc-server}. It contributes:
 *
 * <ul>
 *   <li>a {@link JacksonSerializer} (reusing the application's
 *       {@link ObjectMapper} if one is present) when no {@link Serializer} bean
 *       exists;</li>
 *   <li>a default {@link AgentRegistry} keyed by <em>bean name</em> from all
 *       {@link Agent} beans, unless the application defines its own
 *       {@link AgentRegistry} bean (for friendly ids); and</li>
 *   <li>an {@link AgUiController} when an {@link AgentRegistry} is available.</li>
 * </ul>
 *
 * <p>So defining a single {@code Agent} bean named {@code chat} yields a working
 * {@code /agent/chat} endpoint (and {@code /agent} as the single-agent alias),
 * while several {@code Agent} beans are each reachable at {@code /agent/{beanName}}.
 * To use ids other than bean names, define an {@code AgentRegistry} bean.
 */
@AutoConfiguration
@ConditionalOnWebApplication(type = Type.REACTIVE)
public class AgUiServerAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean(Serializer.class)
    public Serializer agUiSerializer(ObjectProvider<ObjectMapper> objectMapper) {
        ObjectMapper mapper = objectMapper.getIfAvailable();
        return Objects.nonNull(mapper) ? new JacksonSerializer(mapper) : new JacksonSerializer();
    }

    @Bean
    @ConditionalOnBean(Agent.class)
    @ConditionalOnMissingBean(AgentRegistry.class)
    public AgentRegistry agUiAgentRegistry(Map<String, Agent> agents) {
        return AgentRegistry.of(agents);
    }

    @Bean
    @ConditionalOnBean(AgentRegistry.class)
    @ConditionalOnMissingBean(AgUiController.class)
    public AgUiController agUiController(AgentRegistry registry, Serializer serializer) {
        return new AgUiController(registry, serializer);
    }
}
