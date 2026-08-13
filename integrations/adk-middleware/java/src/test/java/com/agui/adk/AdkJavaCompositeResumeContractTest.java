package com.agui.adk;

import com.google.adk.runner.Runner;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

/** Protects the ADK Java 1.7 public runtime seam used for composite HITL continuation. */
class AdkJavaCompositeResumeContractTest {

    @Test
    void officialRunnerExposesNoInvocationIdResumeParameter() throws Exception {
        assertThat(Arrays.stream(Runner.class.getMethods())
                .filter(method -> method.getName().equals("runAsync")))
                .allSatisfy(method -> assertThat(method.getParameterCount())
                        .as(method.toGenericString())
                        .isLessThanOrEqualTo(5));
        assertThat(Runner.class.getMethod(
                "runAsync",
                String.class,
                String.class,
                com.google.genai.types.Content.class,
                com.google.adk.agents.RunConfig.class,
                java.util.Map.class)).isNotNull();
    }

    @Test
    void adapterRunnerSeamExactlyMatchesOfficialStateDeltaResumeContract() throws Exception {
        Method method = AdkRunnerClient.class.getMethod(
                "runAsync",
                String.class,
                String.class,
                com.google.genai.types.Content.class,
                com.google.adk.agents.RunConfig.class,
                java.util.Map.class);

        assertThat(method.getParameterCount()).isEqualTo(5);
        assertThat(method.getParameterTypes()).containsExactly(
                String.class,
                String.class,
                com.google.genai.types.Content.class,
                com.google.adk.agents.RunConfig.class,
                java.util.Map.class);
    }
}
