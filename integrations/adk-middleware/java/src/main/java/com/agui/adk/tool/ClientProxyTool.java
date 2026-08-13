package com.agui.adk.tool;

import com.google.adk.tools.BaseTool;
import com.google.adk.tools.ToolContext;
import com.google.genai.types.FunctionDeclaration;
import com.google.genai.types.Schema;
import io.reactivex.rxjava3.core.Single;

import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * A long-running declaration for work performed exclusively by the AG-UI frontend.
 */
public final class ClientProxyTool extends BaseTool {

    private final FunctionDeclaration declaration;
    private final Schema parameters;

    /**
     * Creates a request-owned frontend proxy declaration.
     *
     * @param name frontend tool name
     * @param description frontend tool description
     * @param parameters normalized Gemini parameters schema
     */
    public ClientProxyTool(String name, String description, Schema parameters) {
        super(name, description == null ? "" : description, true);
        this.parameters = Objects.requireNonNull(parameters, "parameters");
        declaration = FunctionDeclaration.builder()
                .name(name)
                .description(description == null ? "" : description)
                .parameters(this.parameters)
                .build();
    }

    ClientProxyTool withName(String name) {
        return new ClientProxyTool(name, description(), parameters);
    }

    @Override
    public Optional<FunctionDeclaration> declaration() {
        return Optional.of(declaration);
    }

    /**
     * Returns an empty acknowledgement so ADK keeps the long-running call pending.
     *
     * <p>No browser or application handler is invoked in this process.
     *
     * @param args frontend-provided call arguments
     * @param toolContext ADK tool invocation context
     * @return minimum non-result acknowledgement
     */
    @Override
    public Single<Map<String, Object>> runAsync(Map<String, Object> args, ToolContext toolContext) {
        return Single.just(Map.of());
    }
}
