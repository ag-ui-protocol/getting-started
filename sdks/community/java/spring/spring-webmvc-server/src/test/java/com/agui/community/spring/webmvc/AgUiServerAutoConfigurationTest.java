package com.agui.community.spring.webmvc;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.community.core.agent.Agent;
import com.agui.community.core.serialization.Serializer;
import com.agui.community.server.AgentRegistry;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;

class AgUiServerAutoConfigurationTest {

    private static final Agent NOOP = input -> subscriber -> { };

    private final WebApplicationContextRunner runner = new WebApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(AgUiServerAutoConfiguration.class));

    @Test
    void wiresSerializerRegistryAndControllerForAgentBeans() {
        runner.withBean("weather", Agent.class, () -> NOOP)
                .withBean("support", Agent.class, () -> NOOP)
                .run(context -> {
                    assertThat(context).hasSingleBean(AgUiController.class);
                    assertThat(context).hasSingleBean(Serializer.class);
                    assertThat(context.getBean(AgentRegistry.class).ids())
                            .containsExactlyInAnyOrder("weather", "support");
                });
    }

    @Test
    void noControllerWithoutAnyAgent() {
        runner.run(context -> assertThat(context).doesNotHaveBean(AgUiController.class));
    }

    @Test
    void reusesApplicationObjectMapperWhenPresent() {
        runner.withBean(ObjectMapper.class, ObjectMapper::new)
                .withBean("weather", Agent.class, () -> NOOP)
                .run(context -> assertThat(context).hasSingleBean(Serializer.class));
    }

    @Test
    void customAgentRegistryOverridesTheBeanNameDefault() {
        runner.withBean("ignoredBeanName", Agent.class, () -> NOOP)
                .withBean(AgentRegistry.class, () -> AgentRegistry.of(Map.of("friendly", NOOP)))
                .run(context -> {
                    assertThat(context.getBean(AgentRegistry.class).ids()).containsExactly("friendly");
                    assertThat(context).hasSingleBean(AgUiController.class);
                });
    }
}
