package com.agui.adk.a2ui;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** P0 #1 — A2UI envelope helpers ({@code _extract_envelope}, {@code _coerce_freeform_args}). */
class A2uiOperationsTest {

    @Test
    void extractEnvelopeReturnsDirectEnvelope() {
        Map<String, Object> env = A2uiOperations.extractEnvelope(
                "{\"a2ui_operations\": [{\"type\":\"CREATE_SURFACE\"}]}");
        assertThat(env).isNotNull();
        assertThat(env.get("a2ui_operations")).isNotNull();
    }

    @Test
    void extractEnvelopeUnwrapsSingleResultLayer() {
        Map<String, Object> env = A2uiOperations.extractEnvelope(
                "{\"result\": \"{\\\"a2ui_operations\\\": [1]}\"}");
        assertThat(env).isNotNull();
        assertThat(env.get("a2ui_operations")).isInstanceOf(Iterable.class);
    }

    @Test
    void extractEnvelopeUnwrapsDeeplyNestedResult() {
        Map<String, Object> env = A2uiOperations.extractEnvelope(
                "{\"result\": {\"result\": \"{\\\"a2ui_operations\\\": [2]}\"}}");
        assertThat(env).isNotNull();
        assertThat(env.get("a2ui_operations")).isInstanceOf(Iterable.class);
    }

    @Test
    void extractEnvelopeReturnsNullForUnparseable() {
        assertThat(A2uiOperations.extractEnvelope("not json at all")).isNull();
    }

    @Test
    void extractEnvelopeReturnsNullForNonEnvelopeDict() {
        assertThat(A2uiOperations.extractEnvelope("{\"other\": 1}")).isNull();
        assertThat(A2uiOperations.extractEnvelope("{\"result\": 1}")).isNull();
    }

    @Test
    void coerceFreeformArgsParsesComponentsListAndDataDict() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("components", "[{\"type\":\"Dialog\"}]");
        args.put("data", "{\"x\":1}");
        A2uiOperations.coerceFreeformArgs(args);
        assertThat(args.get("components")).isInstanceOf(Iterable.class); // healed to list
        assertThat(args.get("data")).isInstanceOf(Map.class); // unwrapped to object
    }

    @Test
    void coerceFreeformArgsLeavesNonStringValuesUntouched() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("components", java.util.List.of("already", "list"));
        args.put("data", Map.of("x", 1));
        Map<String, Object> before = new LinkedHashMap<>(args);
        A2uiOperations.coerceFreeformArgs(args);
        assertThat(args.get("components")).isEqualTo(before.get("components"));
        assertThat(args.get("data")).isEqualTo(before.get("data"));
    }

    @Test
    void coerceFreeformArgsLeavesGarbageStringAsIs() {
        Map<String, Object> args = new LinkedHashMap<>();
        args.put("components", "%%%garbage%%%");
        A2uiOperations.coerceFreeformArgs(args);
        assertThat(args.get("components")).isEqualTo("%%%garbage%%%");
    }

    @Test
    void extractRenderFcFindsRenderA2uiCall() {
        com.google.genai.types.FunctionCall fc = com.google.genai.types.FunctionCall.builder()
                .name("render_a2ui").args(Map.of("components", Map.of())).build();
        com.google.genai.types.Content content = com.google.genai.types.Content.builder().role("model")
                .parts(java.util.List.of(com.google.genai.types.Part.builder().functionCall(fc).build()))
                .build();
        assertThat(A2uiOperations.extractRenderFc(content)).isSameAs(fc);
    }

    @Test
    void extractRenderFcReturnsNullWhenNoRenderCall() {
        com.google.genai.types.FunctionCall other = com.google.genai.types.FunctionCall.builder()
                .name("something_else").build();
        com.google.genai.types.Content content = com.google.genai.types.Content.builder().role("model")
                .parts(java.util.List.of(com.google.genai.types.Part.builder().functionCall(other).build()))
                .build();
        assertThat(A2uiOperations.extractRenderFc(content)).isNull();
        assertThat(A2uiOperations.extractRenderFc((com.google.genai.types.Content) null)).isNull();
        assertThat(A2uiOperations.extractRenderFc(com.google.genai.types.Content.builder()
                .role("model").parts(java.util.List.of()).build())).isNull();
    }

    @Test
    void asToolReturnParsesEnvelopeDictAndUnwrapsOnFailure() {
        Object parsed = A2uiOperations.asToolReturn("{\"a2ui_operations\": [1]}");
        assertThat(parsed).isInstanceOf(Map.class);
        assertThat(((java.util.Map<?, ?>) parsed).containsKey("a2ui_operations")).isTrue();
        assertThat(((java.util.Map<?, ?>) parsed).size()).isEqualTo(1);
        // Non-dict JSON or unparseable -> the original string comes back.
        assertThat(A2uiOperations.asToolReturn("[1,2]")).isEqualTo("[1,2]");
        assertThat(A2uiOperations.asToolReturn("not json")).isEqualTo("not json");
    }

    @Test
    void a2uiDeclarationNamesToolAndDescribesIntentParameters() {
        com.google.genai.types.FunctionDeclaration decl = A2uiOperations.a2uiDeclaration("render_a2ui", "Generate or edit an A2UI surface.");
        assertThat(decl.name().orElseThrow()).isEqualTo("render_a2ui");
        assertThat(decl.description().orElseThrow()).isEqualTo("Generate or edit an A2UI surface.");
        com.google.genai.types.Schema params = decl.parameters().orElseThrow();
        assertThat(params.type().orElseThrow().knownEnum()).isEqualTo(com.google.genai.types.Type.Known.OBJECT);
        Map<String, com.google.genai.types.Schema> props = params.properties().orElseThrow();
        assertThat(props.keySet()).containsExactly("intent", "target_surface_id", "changes");
        assertThat(props.get("intent").type().orElseThrow().knownEnum()).isEqualTo(com.google.genai.types.Type.Known.STRING);
        assertThat(props.get("intent").description().orElse("")).contains("'create' to render a new surface");
        assertThat(props.get("target_surface_id").description().orElse("")).contains("intent='update'");
        assertThat(props.get("changes").description().orElse("")).contains("Natural-language changes");
    }

    @Test
    void conversationContentsKeepsOnlyTextOnlyNonPartialTurns() {
        com.google.adk.events.Event userText = com.google.adk.events.Event.builder().author("user").partial(false)
                .content(com.google.genai.types.Content.builder().role("user").parts(java.util.List.of(
                        com.google.genai.types.Part.builder().text("hi").build())).build()).build();
        com.google.adk.events.Event partial = com.google.adk.events.Event.builder().author("model").partial(true)
                .content(com.google.genai.types.Content.builder().role("model").parts(java.util.List.of(
                        com.google.genai.types.Part.builder().text("chunk").build())).build()).build();
        com.google.adk.events.Event toolCall = com.google.adk.events.Event.builder().author("model").partial(false)
                .content(com.google.genai.types.Content.builder().role("model").parts(java.util.List.of(
                        com.google.genai.types.Part.builder().functionCall(com.google.genai.types.FunctionCall.builder()
                                .name("render_a2ui").build()).build())).build()).build();
        var out = A2uiOperations.conversationContents(java.util.List.of(userText, partial, toolCall));
        assertThat(out).hasSize(1);
        assertThat(out.get(0).parts().orElseThrow().get(0).text().orElse("")).isEqualTo("hi");
    }

    @Test
    void stateViewRoutesSchemaEntryToA2uiSchemaAndKeepsOthersInContext() {
        String schemaDesc = "A2UI Component Schema — available components for generating UI surfaces. "
                + "Use these component names and properties when creating A2UI operations.";
        java.util.List<Map<String, Object>> entries = java.util.List.of(
                Map.of("description", "user note", "value", "hi"),
                Map.of("description", schemaDesc, "value", "{\"components\":[]}"));
        A2uiOperations.AgUiState state = A2uiOperations.stateView(entries);
        assertThat(state.schemaValue()).isEqualTo("{\"components\":[]}");
        assertThat(state.hasSchema()).isTrue();
        assertThat(state.context()).hasSize(1);
        assertThat(((Map<?, ?>) state.context().get(0)).get("description")).isEqualTo("user note");
    }

    @Test
    void resolveCatalogFromContextParsesSchemaJsonStringAndObject() {
        String schemaDesc = "A2UI Component Schema \u2014 available components for generating UI surfaces. "
                + "Use these component names and properties when creating A2UI operations.";
        // JSON-string value parses to a catalog object.
        Map<String, Object> catalog = A2uiOperations.resolveCatalogFromContext(java.util.List.of(
                Map.of("description", schemaDesc, "value", "{\"components\":[{\"type\":\"Button\"}]}")));
        assertThat(catalog).isNotNull();
        assertThat(catalog.get("components")).isInstanceOf(Iterable.class);
        // Map value returned directly.
        Map<String, Object> direct = A2uiOperations.resolveCatalogFromContext(java.util.List.of(
                Map.of("description", schemaDesc, "value", Map.of("x", 1))));
        assertThat(direct).containsEntry("x", 1);
        // Wrong description / unparseable / missing -> null.
        assertThat(A2uiOperations.resolveCatalogFromContext(java.util.List.of(
                Map.of("description", "other", "value", "{\"components\":[]}")))).isNull();
        assertThat(A2uiOperations.resolveCatalogFromContext(java.util.List.of(
                Map.of("description", schemaDesc, "value", "%%%unparseable%%%")))).isNull();
        assertThat(A2uiOperations.resolveCatalogFromContext(java.util.List.of(
                Map.of("description", schemaDesc, "value", "")))).isNull();
    }

    @Test
    void normalizeA2uiToolResultsRewritesEnvelopeAndLeavesOthersUnchanged() {
        com.agui.community.core.message.ToolMessage a2ui = new com.agui.community.core.message.ToolMessage(
                "m1", "{\"result\":\"{\\\"a2ui_operations\\\": [1]}\"}", "c1", null);
        com.agui.community.core.message.ToolMessage plain = new com.agui.community.core.message.ToolMessage(
                "m2", "not an envelope", "c2", null);
        var out = A2uiOperations.normalizeA2uiToolResults(java.util.List.of(a2ui, plain));
        assertThat(out).hasSize(2);
        // A2UI envelope rewritten to canonical {"a2ui_operations": [...]} JSON.
        com.agui.community.core.message.ToolMessage rewritten = (com.agui.community.core.message.ToolMessage) out.get(0);
        assertThat(rewritten.content()).contains("a2ui_operations");
        // Non-A2UI tool result passes through unchanged (same instance).
        assertThat(out.get(1)).isSameAs(plain);
    }

    @Test
    void planA2uiInjectionDecisionMatrix() {
        String schemaDesc = "A2UI Component Schema \u2014 available components for generating UI surfaces. "
                + "Use these component names and properties when creating A2UI operations.";
        var ctx = java.util.List.of(Map.of("description", schemaDesc, "value", "{\"components\":[]}"));
        String gen = "generate_a2ui";
        // Off when not requested.
        var off = A2uiOperations.planA2uiInjection(Map.of(), Map.of(), java.util.List.of(), new Object(), ctx);
        assertThat(off.inject()).isFalse();
        assertThat(off.reason()).isEqualTo("not requested");
        // Forwarded false disables even when config opts in.
        var fwdFalse = A2uiOperations.planA2uiInjection(Map.of("injectA2UITool", false),
                Map.of("inject_a2ui_tool", true), java.util.List.of(), new Object(), ctx);
        assertThat(fwdFalse.inject()).isFalse();
        // USER PREVAILS: existing generate_a2ui is never double-injected.
        var userWired = A2uiOperations.planA2uiInjection(Map.of("injectA2UITool", true), Map.of(),
                java.util.List.of(gen), new Object(), ctx);
        assertThat(userWired.inject()).isFalse();
        assertThat(userWired.reason()).isEqualTo("user wired");
        // No model -> skip with modelRequired.
        var noModel = A2uiOperations.planA2uiInjection(Map.of("injectA2UITool", true), Map.of(),
                java.util.List.of(), null, ctx);
        assertThat(noModel.inject()).isFalse();
        assertThat(noModel.modelRequired()).isTrue();
        assertThat(noModel.reason()).isEqualTo("no model");
        // Inject: forwarded True -> drop render_a2ui; catalog recovered from context.
        var yes = A2uiOperations.planA2uiInjection(Map.of("injectA2UITool", true), Map.of(),
                java.util.List.of(), new Object(), ctx);
        assertThat(yes.inject()).isTrue();
        assertThat(yes.toolName()).isEqualTo(gen);
        assertThat(yes.dropToolNames()).containsExactly("render_a2ui");
        assertThat(yes.catalog()).isNotNull();
        // String flag names the drop proxy; config fallback via `??` when forwarded absent.
        var strFlag = A2uiOperations.planA2uiInjection(Map.of("injectA2UITool", "my_rend"),
                Map.of(), java.util.List.of(), new Object(), ctx);
        assertThat(strFlag.dropToolNames()).containsExactly("my_rend");
        var cfgFallback = A2uiOperations.planA2uiInjection(null, Map.of("inject_a2ui_tool", true),
                java.util.List.of(), new Object(), java.util.List.of());
        assertThat(cfgFallback.inject()).isTrue();
    }

    @Test
    void stateViewKeepsDictShapedSchemaValueIntact() {
        String schemaDesc = "A2UI Component Schema \u2014 available components for generating UI surfaces. "
                + "Use these component names and properties when creating A2UI operations.";
        Map<String, Object> dictCatalog = new LinkedHashMap<>();
        dictCatalog.put("components", java.util.List.of(
                Map.of("name", "Text", "schema", Map.of("type", "object", "required", java.util.List.of("text")))));
        A2uiOperations.AgUiState state = A2uiOperations.stateView(java.util.List.of(
                Map.of("description", schemaDesc, "value", dictCatalog)));
        // The dict-shaped catalog is preserved AS-IS (never stringified) so render + validation
        // see the object, not a quoted string (M-23).
        assertThat(state.schemaValue()).isSameAs(dictCatalog);
        assertThat(state.schemaValue()).isInstanceOf(Map.class);
        assertThat(state.hasSchema()).isTrue();
    }

    @Test
    void dictShapedCatalogRendersAndAppliesIntoState() {
        String schemaDesc = "A2UI Component Schema \u2014 available components for generating UI surfaces. "
                + "Use these component names and properties when creating A2UI operations.";
        Map<String, Object> dictCatalog = new LinkedHashMap<>();
        dictCatalog.put("catalogId", "demo");
        dictCatalog.put("components", Map.of(
                "Text", Map.of("type", "object", "required", java.util.List.of("text"))));
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("ag-ui", new LinkedHashMap<String, Object>());

        String instructions = A2uiOperations.applyRenderedCatalog(state, dictCatalog, "demo");

        assertThat(instructions).isNotNull();
        Map<?, ?> agUi = (Map<?, ?>) state.get("ag-ui");
        assertThat(agUi.get("a2ui_schema")).isEqualTo(instructions);
        assertThat(instructions).contains("### Catalog Schema:");
    }

    @Test
    void truthyFollowsPythonTruthinessForCatalogSelection() {
        assertThat(A2uiOperations.truthy(null)).isFalse();
        assertThat(A2uiOperations.truthy("")).isFalse();
        assertThat(A2uiOperations.truthy(Map.of())).isFalse();
        assertThat(A2uiOperations.truthy(java.util.List.of())).isFalse();
        assertThat(A2uiOperations.truthy(0)).isFalse();
        assertThat(A2uiOperations.truthy(false)).isFalse();
        assertThat(A2uiOperations.truthy("catalog")).isTrue();
        assertThat(A2uiOperations.truthy(Map.of("components", Map.of()))).isTrue();
        assertThat(A2uiOperations.truthy(java.util.List.of("x"))).isTrue();
        assertThat(A2uiOperations.truthy(1)).isTrue();
        assertThat(A2uiOperations.truthy(true)).isTrue();
    }

    @Test
    void renderA2uiFreeformDeclarationUsesStringComponentsAndRequiredSurface() {
        com.google.genai.types.FunctionDeclaration decl = A2uiOperations.renderA2uiFreeformDeclaration();
        assertThat(decl.name().orElse("")).isEqualTo("render_a2ui");
        assertThat(decl.description().orElse("")).startsWith("Render a dynamic A2UI v0.9 surface");
        com.google.genai.types.Schema params = decl.parameters().orElseThrow();
        assertThat(params.type().orElseThrow()).isEqualTo(new com.google.genai.types.Type(
                com.google.genai.types.Type.Known.OBJECT));
        // components and data declared as STRING (free-form JSON), required surfaceId+components
        assertThat(params.required().orElseThrow()).containsExactly("surfaceId", "components");
        com.google.genai.types.Schema components = params.properties().orElseThrow().get("components");
        assertThat(components.type().orElseThrow()).isEqualTo(new com.google.genai.types.Type(
                com.google.genai.types.Type.Known.STRING));
        com.google.genai.types.Schema data = params.properties().orElseThrow().get("data");
        assertThat(data.type().orElseThrow()).isEqualTo(new com.google.genai.types.Type(
                com.google.genai.types.Type.Known.STRING));
        assertThat(components.description().orElse("")).contains("[{\"id\":\"root\"");
    }

    @Test
    void renderRequestConfigForcesAnyCallToOneAllowedRenderFunction() {
        var decl = A2uiOperations.renderA2uiFreeformDeclaration();
        com.google.genai.types.GenerateContentConfig cfg = A2uiOperations.renderRequestConfig("you are a designer", decl);
        assertThat(cfg.systemInstruction().orElseThrow().parts().orElseThrow().get(0).text().orElse(""))
                .isEqualTo("you are a designer");
        assertThat(cfg.tools().orElseThrow()).hasSize(1);
        assertThat(cfg.tools().orElseThrow().get(0).functionDeclarations().orElseThrow()).hasSize(1);
        com.google.genai.types.FunctionCallingConfig fcc = cfg.toolConfig().orElseThrow()
                .functionCallingConfig().orElseThrow();
        assertThat(fcc.mode().orElseThrow()).isEqualTo(new com.google.genai.types.FunctionCallingConfigMode(
                com.google.genai.types.FunctionCallingConfigMode.Known.ANY));
        assertThat(fcc.allowedFunctionNames().orElseThrow()).containsExactly("render_a2ui");
    }

    @Test
    void subagentContentsUsesConversationOrFallsBackToPromptTurn() {
        com.google.genai.types.Content turn = com.google.genai.types.Content.builder().role("user")
                .parts(java.util.List.of(com.google.genai.types.Part.builder().text("hi").build())).build();
        assertThat(A2uiOperations.subagentContents("p", java.util.List.of(turn))).hasSize(1);
        var fallback = A2uiOperations.subagentContents("prompt", java.util.List.of());
        assertThat(fallback).hasSize(1);
        assertThat(fallback.get(0).parts().orElseThrow().get(0).text().orElse("")).isEqualTo("prompt");
        assertThat(fallback.get(0).role().orElse("")).isEqualTo("user");
    }

    @Test
    @SuppressWarnings("unchecked")
    void applyRenderedCatalogRoutesSchemaIntoAgUiAndLeavesOnRenderFailure() throws Exception {
        String catalogJson;
        try (java.io.InputStream in = getClass().getClassLoader().getResourceAsStream("a2ui/sample_catalog.json")) {
            catalogJson = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
        Map<String, Object> catalog = new com.fasterxml.jackson.databind.ObjectMapper().readValue(catalogJson, Map.class);
        Map<String, Object> state = new java.util.LinkedHashMap<>();
        state.put("context", java.util.List.of(Map.of("description", "note", "value", "x")));
        String instructions = A2uiOperations.applyRenderedCatalog(state, catalog, "demo");
        assertThat(instructions).isNotNull();
        assertThat(((Map<String, Object>) state.get("ag-ui"))).containsKey("a2ui_schema");
        assertThat(((Map<String, Object>) state.get("ag-ui")).get("a2ui_schema")).isEqualTo(instructions);
        // Render failure leaves state unchanged and returns null.
        Map<String, Object> emptyState = new java.util.LinkedHashMap<>();
        assertThat(A2uiOperations.applyRenderedCatalog(emptyState, Map.of(), "demo")).isNull();
        assertThat(emptyState).doesNotContainKey("ag-ui");
    }
}
