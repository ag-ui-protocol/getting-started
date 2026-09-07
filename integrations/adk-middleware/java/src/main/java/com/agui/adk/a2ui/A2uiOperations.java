package com.agui.adk.a2ui;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.adk.events.Event;
import java.util.Map;

/**
 * Pure envelope-handling helpers for the A2UI operations tool, port of the static/classmethod
 * core of the Python {@code A2UISubAgentTool} in {@code a2ui_tool.py} that is independent of the
 * live ADK sub-agent/LLM invocation path:
 *
 * <ul>
 *   <li>{@link #extractEnvelope} — {@code _extract_envelope}: peel up to three layers of ADK
 *       string/result wrapping off a tool-result until an {@code a2ui_operations} envelope dict
 *       surfaces;</li>
 *   <li>{@link #coerceFreeformArgs} — {@code _coerce_freeform_args}: heal+parse Gemini's free-form
 *       JSON-string {@code components}/{@code data} args via {@link A2uiJsonHealer#healArg}, leaving
 *       a value untouched on hard parse failure (so a broken parse fails validation and the recovery
 *       loop retries rather than committing garbage).</li>
 * </ul>
 */
public final class A2uiOperations {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String A2UI_OPERATIONS_KEY = "a2ui_operations";
    private static final String RESULT_KEY = "result";
    private static final String RENDER_A2UI_NAME = "render_a2ui";
    private static final String GENERATE_A2UI_NAME = "generate_a2ui";
    private static final String A2UI_SCHEMA_CONTEXT_DESCRIPTION =
            "A2UI Component Schema — available components for generating UI surfaces. "
                    + "Use these component names and properties when creating A2UI operations.";

    private A2uiOperations() { }

    /**
     * Pulls an {@code a2ui_operations} envelope out of an ADK tool-result string, unwrapping the
     * layers ADK adds (Python {@code A2UISubAgentTool._extract_envelope}): a tool return may be
     * double-encoded and/or nested under {@code result}.
     *
     * @param content tool-result string
     * @return the envelope dict, or {@code null} when none surfaces after unwrapping
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> extractEnvelope(String content) {
        Object payload = content;
        for (int i = 0; i < 3; i++) {
            if (payload instanceof String s) {
                try {
                    payload = JSON.readValue(s, Object.class);
                } catch (Exception e) {
                    return null;
                }
            }
            if (payload instanceof Map<?, ?> m) {
                if (m.containsKey(A2UI_OPERATIONS_KEY)) {
                    return (Map<String, Object>) m;
                }
                Object inner = m.get(RESULT_KEY);
                if (inner instanceof String || inner instanceof Map<?, ?>) {
                    payload = inner;
                    continue;
                }
                return null;
            }
            return null;
        }
        return null;
    }

    /**
     * Heals + parses the free-form JSON-string {@code components}/{@code data} Gemini returns into
     * the structured list/dict the toolkit validates and emits; already-structured values pass
     * through untouched; a hard parse failure leaves the original string (Python
     * {@code A2UISubAgentTool._coerce_freeform_args}).
     *
     * @param args tool arguments
     * @return the same map with {@code components}/{@code data} healed
     */
    public static Map<String, Object> coerceFreeformArgs(Map<String, Object> args) {
        coerce("components", "list", args);
        coerce("data", "dict", args);
        return args;
    }

    /**
     * Returns the {@code render_a2ui} function-call part of a genai content, if any (Python
     * {@code A2UISubAgentTool._extract_render_fc}).
     *
     * @param content genai content (e.g. an LlmResponse content)
     * @return the {@code render_a2ui} function call, or {@code null}
     */
    public static com.google.genai.types.FunctionCall extractRenderFc(com.google.genai.types.Content content) {
        if (content == null) {
            return null;
        }
        for (com.google.genai.types.Part part : content.parts().orElse(java.util.List.of())) {
            if (part.functionCall().isPresent()) {
                com.google.genai.types.FunctionCall fc = part.functionCall().orElseThrow();
                if (RENDER_A2UI_NAME.equals(fc.name().orElse(null))) {
                    return fc;
                }
            }
        }
        return null;
    }

    /**
     * Returns the toolkit envelope in the shape the A2UI middleware can read: the parsed dict when
     * the string is a JSON object, otherwise the original string (Python
     * {@code A2UISubAgentTool._as_tool_return}).
     *
     * @param envelope the envelope JSON string
     * @return the parsed dict, or the original string
     */
    public static Object asToolReturn(String envelope) {
        try {
            Object parsed = JSON.readValue(envelope, Object.class);
            return (parsed instanceof Map<?, ?>) ? parsed : envelope;
        } catch (Exception e) {
            return envelope;
        }
    }

    /**
     * Builds the AG-UI toolkit tool declaration with the fixed parameter schema, mirroring the
     * Python {@code A2UISubAgentTool._get_declaration} (the declaration half of the A2UI subagent
     * tool; the live invocation run-loop requires an ADK sub-agent runtime the bridge does not own).
     *
     * @param name configured tool name (e.g. "render_a2ui")
     * @param description configured tool description
     * @return the genai function declaration describing the A2UI tool
     */
    public static com.google.genai.types.FunctionDeclaration a2uiDeclaration(String name, String description) {
        return com.google.genai.types.FunctionDeclaration.builder()
                .name(name)
                .description(description)
                .parameters(intentSchema())
                .build();
    }

    /**
     * The model-facing free-form {@code render_a2ui} declaration used to build the forced
     * sub-agent request (Python {@code A2UISubAgentTool._build_llm_request}). Unlike the shared
     * typed {@code RENDER_A2UI_TOOL_DEF}, {@code components} and {@code data} are declared as
     * STRING so Gemini fills the full A2UI JSON free-form (a typed array-of-object would be
     * emitted as an empty {@code {}}); {@code _coerce_freeform_args} parses it back into the
     * structured dict the toolkit validates.
     *
     * @return the free-form {@code render_a2ui} function declaration
     */
    public static com.google.genai.types.FunctionDeclaration renderA2uiFreeformDeclaration() {
        com.google.genai.types.Schema surfaceId = com.google.genai.types.Schema.builder()
                .type(new com.google.genai.types.Type(com.google.genai.types.Type.Known.STRING))
                .description("Unique surface identifier.")
                .build();
        com.google.genai.types.Schema components = com.google.genai.types.Schema.builder()
                .type(new com.google.genai.types.Type(com.google.genai.types.Type.Known.STRING))
                .description("The A2UI v0.9 component array as a JSON string, e.g. "
                        + "'[{\"id\":\"root\",\"component\":\"Text\",\"text\":\"Hi\"}]'. "
                        + "The root component must have id 'root'.")
                .build();
        com.google.genai.types.Schema data = com.google.genai.types.Schema.builder()
                .type(new com.google.genai.types.Type(com.google.genai.types.Type.Known.STRING))
                .description("Optional surface data model as a JSON string, e.g. "
                        + "'{\"items\":[...]}'. Use '{}' when there is none.")
                .build();
        java.util.Map<String, com.google.genai.types.Schema> properties = new java.util.LinkedHashMap<>();
        properties.put("surfaceId", surfaceId);
        properties.put("components", components);
        properties.put("data", data);
        com.google.genai.types.Schema parameters = com.google.genai.types.Schema.builder()
                .type(new com.google.genai.types.Type(com.google.genai.types.Type.Known.OBJECT))
                .properties(properties)
                .required(java.util.List.of("surfaceId", "components"))
                .build();
        return com.google.genai.types.FunctionDeclaration.builder()
                .name("render_a2ui")
                .description("Render a dynamic A2UI v0.9 surface. The root component must have id "
                        + "'root'. Use components from the available catalog only.")
                .parameters(parameters)
                .build();
    }

    /**
     * Builds the fixed intent-argument schema for the A2UI tools.
     *
     * @return the intent parameter schema
     */
    private static com.google.genai.types.Schema intentSchema() {
        com.google.genai.types.Schema intent = com.google.genai.types.Schema.builder()
                .type(new com.google.genai.types.Type(com.google.genai.types.Type.Known.STRING))
                .description("'create' to render a new surface, or 'update' to modify a surface already rendered in this conversation.")
                .build();
        com.google.genai.types.Schema target = com.google.genai.types.Schema.builder()
                .type(new com.google.genai.types.Type(com.google.genai.types.Type.Known.STRING))
                .description("Surface id to modify when intent='update'.")
                .build();
        com.google.genai.types.Schema changes = com.google.genai.types.Schema.builder()
                .type(new com.google.genai.types.Type(com.google.genai.types.Type.Known.STRING))
                .description("Natural-language changes to apply on update.")
                .build();
        java.util.Map<String, com.google.genai.types.Schema> properties = new java.util.LinkedHashMap<>();
        properties.put("intent", intent);
        properties.put("target_surface_id", target);
        properties.put("changes", changes);
        return com.google.genai.types.Schema.builder()
                .type(new com.google.genai.types.Type(com.google.genai.types.Type.Known.OBJECT))
                .properties(properties)
                .build();
    }

    /**
     * Returns the conversational genai {@code Content} turns to forward to the A2UI sub-agent
     * (Python {@code A2UISubAgentTool._conversation_contents}): user/model text turns in order,
     * skipping partial chunks and the tool-call/function-response machinery, so the sub-agent
     * sees the request rather than the plumbing.
     *
     * @param events ADK session events
     * @return text-only (no tool call/response) content turns
     */
    public static java.util.List<com.google.genai.types.Content> conversationContents(java.util.List<Event> events) {
        java.util.List<com.google.genai.types.Content> contents = new java.util.ArrayList<>();
        for (Event event : events) {
            if (event.partial().orElse(false)) {
                continue;
            }
            if (event.content().isEmpty()) {
                continue;
            }
            com.google.genai.types.Content content = event.content().orElseThrow();
            java.util.List<com.google.genai.types.Part> parts = content.parts().orElse(java.util.List.of());
            if (parts.isEmpty()) {
                continue;
            }
            boolean hasText = false;
            boolean hasCalls = false;
            boolean hasResponses = false;
            for (com.google.genai.types.Part part : parts) {
                if (part.text().isPresent()) {
                    hasText = true;
                }
                if (part.functionCall().isPresent()) {
                    hasCalls = true;
                }
                if (part.functionResponse().isPresent()) {
                    hasResponses = true;
                }
            }
            if (hasText && !hasCalls && !hasResponses) {
                contents.add(content);
            }
        }
        return contents;
    }

    /** Result of the AG-UI context remap, mirroring Python {@code A2UISubAgentTool._state_view}. */
    public record AgUiState(java.util.List<Object> context, Object schemaValue, boolean hasSchema) {
    }

    /**
     * Remaps the flat {@code {description, value}} context list into the toolkit's
     * {@code ag-ui} state shape (Python {@code A2UISubAgentTool._state_view}): the A2UI schema
     * entry (matched by its exact description) is routed to {@code a2ui_schema} so it renders as
     * the "Available Components" section rather than generic context; every other entry stays in
     * {@code context}.
     *
     * <p>The schema value is preserved AS-IS (a JSON string, or a dict-shaped value the middleware
     * stamped directly) — never stringified, so a dict-shaped catalog reaches the renderer and
     * validator intact (Python keeps the raw value).
     *
     * @param contextEntries flat tool context entries (each a map of description/value)
     * @return the remapped {@code ag-ui} state and the raw schema value (if any)
     */
    public static AgUiState stateView(java.util.List<? extends Map<String, Object>> contextEntries) {
        java.util.List<Object> regularContext = new java.util.ArrayList<>();
        Object schemaValue = null;
        for (Map<String, ?> entry : contextEntries) {
            Object description = entry.get("description");
            Object value = entry.get("value");
            if (A2UI_SCHEMA_CONTEXT_DESCRIPTION.equals(description)) {
                schemaValue = value;
            } else {
                regularContext.add(entry);
            }
        }
        return new AgUiState(regularContext, schemaValue, schemaValue != null);
    }

    /**
     * Pulls the A2UI catalog stamped into the run context (Python
     * {@code A2UISubAgentTool._resolve_catalog_from_context}): finds the context entry whose
     * description matches {@code A2UI_SCHEMA_CONTEXT_DESCRIPTION} byte-exactly, returning its
     * value when it is already an object or a JSON object string; otherwise {@code null}.
     *
     * @param contextEntries run input context entries (each a map of description/value)
     * @return the parsed catalog object, or {@code null} when absent/unparseable
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> resolveCatalogFromContext(java.util.List<? extends Map<String, ?>> contextEntries) {
        for (Map<String, ?> entry : contextEntries) {
            Object description = entry.get("description");
            Object value = entry.get("value");
            if (!A2UI_SCHEMA_CONTEXT_DESCRIPTION.equals(description)) {
                continue;
            }
            if (value == null || (value instanceof String stringValue && stringValue.isEmpty())) {
                continue;
            }
            if (value instanceof Map<?, ?>) {
                return (Map<String, Object>) value;
            }
            if (value instanceof String) {
                try {
                    Object parsed = JSON.readValue((String) value, Object.class);
                    if (parsed instanceof Map<?, ?>) {
                        return (Map<String, Object>) parsed;
                    }
                } catch (Exception e) {
                    // fall through: absent/unparseable catalog disables catalog-aware recovery
                }
            }
        }
        return null;
    }

    /**
     * Rewrites A2UI tool-result messages so their content is the canonical envelope JSON string
     * the toolkit's {@code find_prior_surface} expects (it {@code json.loads(content)} and looks
     * for {@code a2ui_operations}); non-A2UI tool results pass through unchanged. Python
     * {@code A2UISubAgentTool._normalize_a2ui_tool_results} over {@code extractEnvelope}.
     *
     * @param messages AG-UI messages
     * @return messages with A2UI tool results normalized to the canonical envelope JSON
     */
    public static java.util.List<com.agui.community.core.message.Message> normalizeA2uiToolResults(
            java.util.List<com.agui.community.core.message.Message> messages) {
        java.util.List<com.agui.community.core.message.Message> out = new java.util.ArrayList<>();
        for (com.agui.community.core.message.Message message : messages) {
            if (message instanceof com.agui.community.core.message.ToolMessage tool
                    && tool.content() instanceof String contentString) {
                Map<String, Object> envelope = extractEnvelope(contentString);
                if (envelope != null) {
                    String id = tool.id() != null ? tool.id() : java.util.UUID.randomUUID().toString();
                    String callId = tool.toolCallId() != null ? tool.toolCallId() : "";
                    out.add(new com.agui.community.core.message.ToolMessage(
                            id, PythonJson.stringifySpaced(envelope), callId, null));
                    continue;
                }
            }
            out.add(message);
        }
        return out;
    }

    /**
     * Serializes a map to compact JSON (Python {@code json.dumps}).
     *
     * @param value the map to serialize
     * @return the compact JSON string, or {@code "{}"} on failure
     */


    /**
     * Assembles the {@code GenerateContentConfig} for the forced {@code render_a2ui} sub-agent
     * request (Python {@code A2UISubAgentTool._build_llm_request}): the prompt rides as
     * {@code system_instruction}, the single tool is the given declaration, and function calling
     * is forced to ANY with only {@code render_a2ui} allowed.
     *
     * @param prompt     the assembled sub-agent prompt (system instruction)
     * @param declaration the free-form {@code render_a2ui} function declaration
     * @return the generate-content config
     */
    public static com.google.genai.types.GenerateContentConfig renderRequestConfig(
            String prompt, com.google.genai.types.FunctionDeclaration declaration) {
        com.google.genai.types.Tool tool = com.google.genai.types.Tool.builder()
                .functionDeclarations(java.util.List.of(declaration)).build();
        com.google.genai.types.ToolConfig toolConfig = com.google.genai.types.ToolConfig.builder()
                .functionCallingConfig(com.google.genai.types.FunctionCallingConfig.builder()
                        .mode(new com.google.genai.types.FunctionCallingConfigMode(
                                com.google.genai.types.FunctionCallingConfigMode.Known.ANY))
                        .allowedFunctionNames(java.util.List.of("render_a2ui"))
                        .build())
                .build();
        return com.google.genai.types.GenerateContentConfig.builder()
                .systemInstruction(com.google.genai.types.Content.builder().role("user")
                        .parts(java.util.List.of(com.google.genai.types.Part.builder().text(prompt).build()))
                        .build())
                .tools(java.util.List.of(tool))
                .toolConfig(toolConfig)
                .build();
    }

    /**
     * The request contents for the sub-agent invocation (Python {@code _build_llm_request}):
     * the real conversation turns when present, else a defensive single user turn carrying the
     * prompt.
     *
     * @param prompt       the assembled sub-agent prompt
     * @param conversation the conversation turns (may be empty)
     * @return the contents to send
     */
    public static java.util.List<com.google.genai.types.Content> subagentContents(
            String prompt, java.util.List<com.google.genai.types.Content> conversation) {
        if (conversation != null && !conversation.isEmpty()) {
            return conversation;
        }
        return java.util.List.of(com.google.genai.types.Content.builder().role("user")
                .parts(java.util.List.of(com.google.genai.types.Part.builder().text(prompt).build()))
                .build());
    }

    /**
     * Routes the rendered catalog instructions into the {@code ag-ui} state shape (Python
     * {@code A2UISubAgentTool.run_async}): renders {@code catalogSource} with
     * {@code defaultCatalogId} and, on success, overwrites {@code ag-ui.a2ui_schema} so the
     * sub-agent sees the rendered schema block rather than the raw catalog. Renders is
     * best-effort; on failure the state is left unchanged and {@code null} is returned.
     *
     * @param state            the {@code ag-ui} state map to mutate
     * @param catalogSource    the host catalog or raw schema value
     * @param defaultCatalogId the default catalog id (may be null)
     * @return the rendered instructions, or {@code null} when rendering failed
     */
    @SuppressWarnings("unchecked")
    public static String applyRenderedCatalog(Map<String, Object> state, Object catalogSource, String defaultCatalogId) {
        String instructions = A2uiCatalogRenderer.renderCatalogInstructions(catalogSource, defaultCatalogId);
        if (instructions != null) {
            Object agUi = state.computeIfAbsent("ag-ui", k -> new java.util.LinkedHashMap<String, Object>());
            ((Map<String, Object>) agUi).put("a2ui_schema", instructions);
        }
        return instructions;
    }

    /**
     * Decision result of A2UI auto-injection (Python
     * {@code plan_a2ui_injection}): whether to inject {@code generate_a2ui}, which render proxy
     * to drop from the frontend tools, the resolved catalog, and whether a model was required.
     * The live {@code tool} object is the framework-bound sub-agent half (NO_JAVA_EQUIVALENT);
     * this is the pure decision.
     */
    public record A2uiInjectionPlan(boolean inject, String toolName, java.util.List<String> dropToolNames,
                                    Object catalog, boolean modelRequired, String reason) {
    }

    /**
     * Decides whether to auto-inject {@code generate_a2ui} for a run (Python
     * {@code plan_a2ui_injection}, mirroring the Strands/LangGraph "no injectA2UITool, no
     * injection" contract):
     * <ol>
     * <li>off unless the runtime forwarded {@code injectA2UITool} (True, or a string naming the
     * injected render tool to drop) OR a backend {@code config["inject_a2ui_tool"]} override — the
     * forwarded flag wins (a false disables even when config opts in); </li>
     * <li>USER PREVAILS — a dev-wired {@code generate_a2ui} is never double-injected;</li>
     * <li>no model ({@code model == null}, e.g. a non-LlmAgent root) -&gt; skip;</li>
     * <li>otherwise the render proxy to drop is the forwarded string or {@code render_a2ui}, and
     * the catalog is {@code config["catalog"]} (nullish) or recovered from the run context.</li>
     * </ol>
     *
     * @param forwardedProps   run-agent-input forwarded props (may be null)
     * @param config           backend config (may be null)
     * @param existingToolNames tools already present on the agent (may be null)
     * @param model            resolved framework model, or null when none could be inferred
     * @param contextEntries   run context entries for catalog recovery
     * @return the A2UI injection decision (on/off, tool names, catalog, and routing plan)
     */
    public static A2uiInjectionPlan planA2uiInjection(Map<String, Object> forwardedProps,
                                                      Map<String, Object> config,
                                                      java.util.List<String> existingToolNames,
                                                      Object model,
                                                      java.util.List<? extends Map<String, ?>> contextEntries) {
        Map<String, Object> cfg = config == null ? Map.of() : config;
        Map<String, Object> fwd = forwardedProps == null ? Map.of() : forwardedProps;
        String toolName = GENERATE_A2UI_NAME;
        // Nullish (not falsy) fallback mirroring the TS adapter's `??`.
        Object flag = fwd.get("injectA2UITool");
        if (flag == null) {
            flag = cfg.get("inject_a2ui_tool");
        }
        if (!truthy(flag)) {
            return new A2uiInjectionPlan(false, toolName, java.util.List.of(), null, false, "not requested");
        }
        // USER PREVAILS: an explicitly wired generate_a2ui wins - never double-inject.
        if (existingToolNames != null && existingToolNames.contains(toolName)) {
            return new A2uiInjectionPlan(false, toolName, java.util.List.of(), null, false, "user wired");
        }
        if (model == null) {
            return new A2uiInjectionPlan(false, toolName, java.util.List.of(), null, true, "no model");
        }
        String renderToolName = flag instanceof String stringFlag ? stringFlag : RENDER_A2UI_NAME;
        Object catalog = cfg.containsKey("catalog") ? cfg.get("catalog") : resolveCatalogFromContext(contextEntries);
        return new A2uiInjectionPlan(true, toolName, java.util.List.of(renderToolName), catalog, false, "inject");
    }

    /**
     * Applies Python truthiness to a value (non-null scalar or non-empty iterable/map).
     *
     * @param value the value to test
     * @return whether the value is truthy per Python semantics
     */
    static boolean truthy(Object value) {
        if (value == null) {
            return false;
        }
        if (value instanceof Boolean b) {
            return b;
        }
        if (value instanceof String s) {
            return !s.isEmpty();
        }
        if (value instanceof Number n) {
            return n.doubleValue() != 0;
        }
        if (value instanceof Iterable<?> || value instanceof Map<?, ?>) {
            return !isEmpty(value);
        }
        return true;
    }

    /**
     * Tests whether a value is empty (null, or an empty iterable/map, or blank string).
     *
     * @param value the value to test
     * @return whether the value is empty
     */
    private static boolean isEmpty(Object value) {
        if (value instanceof Iterable<?> it) {
            return !it.iterator().hasNext();
        }
        if (value instanceof Map<?, ?> m) {
            return m.isEmpty();
        }
        return false;
    }

    /**
     * Coerces a free-form JSON-string argument ({@code components}/{@code data}) into the expected
     * shape (list or dict), healing smart quotes/trailing commas (A2UI {@code parse_and_fix}).
     *
     * @param key the argument key
     * @param expect the expected shape ({@code list} or {@code dict})
     * @param args the argument map to mutate
     */
    private static void coerce(String key, String expect, Map<String, Object> args) {
        Object value = args.get(key);
        if (value instanceof String s) {
            try {
                JsonNode healed = A2uiJsonHealer.healArg(s, expect);
                // Python stores the healed dict/list; convert the JsonNode to Java Map/List.
                args.put(key, JSON.convertValue(healed, Object.class));
            } catch (IllegalArgumentException e) {
                // leave the value as-is so the toolkit validator rejects it and the recovery retries
            }
        }
    }
}
