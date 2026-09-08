using System.Text.Json.Nodes;

namespace AGUI.A2UI;

/// <summary>
/// Semantic validator for A2UI v0.9 component trees, mirroring
/// <c>validateA2UIComponents</c> / <c>validate_a2ui_components</c> in the sibling toolkits.
/// </summary>
/// <remarks>
/// Structural checks (ids, component types, root presence, child references) always run.
/// Catalog checks (component existence, required props) run only when a catalog is supplied.
/// Absolute data-binding checks run unless <c>validateBindings</c> is <see langword="false"/>;
/// relative binding paths are never validated globally because they resolve per item inside
/// repeated templates.
/// </remarks>
public static class A2UIComponentValidator
{
    // Schema format marker tagging a property whose value is a single child reference.
    private const string ComponentRefFormat = "componentRef";

    // Schema format marker tagging a property whose value is a list of child references.
    private const string ComponentRefListFormat = "componentRefList";

    /// <summary>
    /// Validates a flat A2UI component array against structural rules and, optionally,
    /// a component catalog and a data model.
    /// </summary>
    /// <param name="components">The flat component array. <see langword="null"/> or empty fails validation.</param>
    /// <param name="data">The surface data model used to resolve absolute binding paths.</param>
    /// <param name="catalog">The component catalog enabling semantic checks.</param>
    /// <param name="validateBindings">
    /// When <see langword="false"/>, absolute binding checks are deferred (used while the data
    /// model has not finished streaming).
    /// </param>
    /// <returns>The validation outcome.</returns>
    public static A2UIValidationResult Validate(
        JsonArray? components,
        JsonObject? data = null,
        A2UIValidationCatalog? catalog = null,
        bool validateBindings = true)
    {
        // Fail loud on a missing/empty payload.
        if (components is null || components.Count == 0)
        {
            return new A2UIValidationResult(false,
            [
                new A2UIValidationError(
                    A2UIValidationErrorCodes.EmptyComponents,
                    "components",
                    "A2UI components must be a non-empty array"),
            ]);
        }

        List<A2UIValidationError> errors = [];

        // First pass: collect ids and flag duplicates. Empty ids are skipped here so they
        // are reported once as a missing id in the next pass rather than as spurious
        // duplicates of each other.
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonNode? node in components)
        {
            if (node is JsonObject component && component["id"] is JsonValue idValue &&
                idValue.TryGetValue(out string? id) && !string.IsNullOrEmpty(id) && !ids.Add(id))
            {
                errors.Add(new A2UIValidationError(
                    A2UIValidationErrorCodes.DuplicateId,
                    $"components[id={id}]",
                    $"Duplicate component id '{id}'"));
            }
        }

        for (int i = 0; i < components.Count; i++)
        {
            JsonObject? component = components[i] as JsonObject;
            string? id = TryGetString(component?["id"]);
            string? componentType = TryGetString(component?["component"]);

            if (string.IsNullOrEmpty(id))
            {
                errors.Add(new A2UIValidationError(
                    A2UIValidationErrorCodes.MissingId,
                    $"components[{i}].id",
                    $"Component at index {i} is missing a string 'id'"));
            }

            if (string.IsNullOrEmpty(componentType))
            {
                errors.Add(new A2UIValidationError(
                    A2UIValidationErrorCodes.MissingComponentType,
                    $"components[{i}].component",
                    $"Component at index {i} is missing a string 'component' type"));
            }

            // The component's catalog schema (when a catalog is supplied) drives both the
            // required-prop check and the catalog-derived child-reference fields below.
            JsonObject? componentSchema = null;
            if (catalog is not null && componentType is not null)
            {
                if (catalog.Components[componentType] is not JsonObject schema)
                {
                    errors.Add(new A2UIValidationError(
                        A2UIValidationErrorCodes.UnknownComponent,
                        $"components[{i}].component",
                        $"Component type '{componentType}' is not in the catalog"));
                }
                else
                {
                    componentSchema = schema;
                    if (schema["required"] is JsonArray required)
                    {
                        foreach (JsonNode? requiredNode in required)
                        {
                            if (TryGetString(requiredNode) is string requiredProp &&
                                component?.ContainsKey(requiredProp) != true)
                            {
                                errors.Add(new A2UIValidationError(
                                    A2UIValidationErrorCodes.MissingRequiredProp,
                                    $"components[{i}].{requiredProp}",
                                    $"Component '{componentType}' (index {i}) is missing required prop '{requiredProp}'"));
                            }
                        }
                    }
                }
            }

            if (component is not null)
            {
                // Resolve every child reference the component carries: the structural
                // `child`/`children` containers plus any catalog-marked ref-fields (including
                // nested array-of-object refs). A dangling reference in any of them is caught
                // here with a field-specific path and fed back to the recovery loop.
                foreach ((string pathSuffix, string reference) in CollectComponentRefEdges(component, componentSchema))
                {
                    if (!ids.Contains(reference))
                    {
                        errors.Add(new A2UIValidationError(
                            A2UIValidationErrorCodes.UnresolvedChild,
                            $"components[{i}].{pathSuffix}",
                            $"Child reference '{reference}' does not match any component id"));
                    }
                }

                if (validateBindings)
                {
                    List<string> bindingPaths = [];
                    CollectAbsoluteBindingPaths(component, bindingPaths);
                    foreach (string path in bindingPaths)
                    {
                        if (!AbsolutePathResolves(path, data))
                        {
                            errors.Add(new A2UIValidationError(
                                A2UIValidationErrorCodes.UnresolvedBinding,
                                $"components[{i}]",
                                $"Binding path '{path}' does not resolve in the data model"));
                        }
                    }
                }
            }
        }

        // The child/children tree must be a DAG — a component that (transitively)
        // references itself never terminates at render time. Report each cycle once.
        foreach (List<string> cycle in FindChildCycles(components, catalog))
        {
            errors.Add(new A2UIValidationError(
                A2UIValidationErrorCodes.ChildCycle,
                $"components[id={cycle[0]}]",
                $"Child reference cycle detected: {string.Join(" -> ", cycle)} -> {cycle[0]}"));
        }

        bool hasRoot = false;
        foreach (JsonNode? node in components)
        {
            if (node is JsonObject component && TryGetString(component["id"]) == "root")
            {
                hasRoot = true;
                break;
            }
        }

        if (!hasRoot)
        {
            errors.Add(new A2UIValidationError(
                A2UIValidationErrorCodes.NoRoot,
                "components",
                "No component has id 'root'"));
        }

        return new A2UIValidationResult(errors.Count == 0, errors);
    }

    private static string? TryGetString(JsonNode? node)
        => node is JsonValue value && value.TryGetValue(out string? text) ? text : null;

    private static bool AbsolutePathResolves(string path, JsonNode? data)
    {
        JsonNode? cursor = data;
        foreach (string segment in path.Split('/'))
        {
            if (segment.Length == 0)
            {
                continue;
            }

            switch (cursor)
            {
                case JsonArray array:
                    if (!int.TryParse(segment, out int index) || index < 0 || index >= array.Count)
                    {
                        return false;
                    }

                    cursor = array[index];
                    break;

                case JsonObject obj:
                    if (!obj.TryGetPropertyValue(segment, out JsonNode? next))
                    {
                        return false;
                    }

                    cursor = next;
                    break;

                default:
                    return false;
            }
        }

        return true;
    }

    // Collects every child reference a component carries, paired with the field-specific path
    // suffix that locates it (e.g. child, children[2], tabItems[0].child).
    // The singular child and plural children containers are always traversed — they
    // are the structural child fields every catalog shares. Extended ref-fields are catalog-derived:
    // a property contributes references only when its schema carries the componentRef /
    // componentRefList format marker, and array-of-object properties are introspected so
    // nested refs (e.g. Tabs tabItems[].child) are caught. Without a catalog only the
    // structural fields are returned. A reference value is a bare id string or a
    // { componentId, ... } template object.
    private static List<(string Path, string RefId)> CollectComponentRefEdges(JsonObject component, JsonObject? schema)
    {
        List<(string Path, string RefId)> edges = [];

        static string? RefId(JsonNode? node)
            => TryGetString(node) ?? (node is JsonObject obj ? TryGetString(obj["componentId"]) : null);

        void AddSingle(string path, JsonNode? value)
        {
            if (RefId(value) is string id)
            {
                edges.Add((path, id));
            }
        }

        void AddList(string path, JsonNode? value)
        {
            if (value is JsonArray array)
            {
                for (int k = 0; k < array.Count; k++)
                {
                    if (RefId(array[k]) is string id)
                    {
                        edges.Add(($"{path}[{k}]", id));
                    }
                }
            }
            else if (RefId(value) is string single)
            {
                // A single template object ({ componentId, ... }) or a bare id, with no index.
                edges.Add((path, single));
            }
        }

        AddSingle("child", component["child"]);
        AddList("children", component["children"]);

        if (schema?["properties"] is JsonObject properties)
        {
            foreach (KeyValuePair<string, JsonNode?> property in properties)
            {
                string name = property.Key;
                if (name is "child" or "children")
                {
                    continue; // covered structurally above
                }

                if (property.Value is not JsonObject propertySchema)
                {
                    continue;
                }

                switch (TryGetString(propertySchema["format"]))
                {
                    case ComponentRefFormat:
                        AddSingle(name, component[name]);
                        continue;
                    case ComponentRefListFormat:
                        AddList(name, component[name]);
                        continue;
                }

                // An array-of-object property: introspect each item sub-property for the same
                // markers so a nested ref (e.g. Tabs `tabItems[k].child`) is traversed.
                if (TryGetString(propertySchema["type"]) == "array" &&
                    propertySchema["items"] is JsonObject items &&
                    items["properties"] is JsonObject itemProperties &&
                    component[name] is JsonArray elements)
                {
                    for (int k = 0; k < elements.Count; k++)
                    {
                        if (elements[k] is not JsonObject element)
                        {
                            continue;
                        }

                        foreach (KeyValuePair<string, JsonNode?> subProperty in itemProperties)
                        {
                            if (subProperty.Value is not JsonObject subSchema)
                            {
                                continue;
                            }

                            switch (TryGetString(subSchema["format"]))
                            {
                                case ComponentRefFormat:
                                    AddSingle($"{name}[{k}].{subProperty.Key}", element[subProperty.Key]);
                                    break;
                                case ComponentRefListFormat:
                                    AddList($"{name}[{k}].{subProperty.Key}", element[subProperty.Key]);
                                    break;
                            }
                        }
                    }
                }
            }
        }

        return edges;
    }

    // id -> ordered child-id references for the cycle graph, drawn from the same
    // CollectComponentRefEdges edge set the dangling-ref check uses so both views of
    // the child graph stay consistent.
    private static Dictionary<string, List<string>> BuildChildAdjacency(JsonArray components, A2UIValidationCatalog? catalog)
    {
        var adjacency = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (JsonNode? node in components)
        {
            if (node is JsonObject component && TryGetString(component["id"]) is string id)
            {
                JsonObject? schema = null;
                if (catalog is not null &&
                    TryGetString(component["component"]) is string componentType &&
                    catalog.Components[componentType] is JsonObject componentSchema)
                {
                    schema = componentSchema;
                }

                List<string> references = [];
                foreach ((_, string refId) in CollectComponentRefEdges(component, schema))
                {
                    references.Add(refId);
                }

                adjacency[id] = references;
            }
        }

        return adjacency;
    }

    // Finds unique child-reference cycles (self-references and longer loops) over the child graph
    // via an iterative depth-first search. The traversal is explicit-stack rather than recursive
    // so a pathologically deep child chain in untrusted model output cannot overflow the call
    // stack (an uncatchable failure on .NET). Each cycle is canonicalised — rotated so the
    // lexicographically smallest id leads — so the same loop reached from different entry points
    // collapses to one finding, and the reported chain stays byte-identical across the sibling
    // toolkits.
    private static List<List<string>> FindChildCycles(JsonArray components, A2UIValidationCatalog? catalog)
    {
        Dictionary<string, List<string>> adjacency = BuildChildAdjacency(components, catalog);
        var color = new Dictionary<string, int>(StringComparer.Ordinal); // absent/0 = unvisited, 1 = on path, 2 = done
        var seenKeys = new HashSet<string>(StringComparer.Ordinal);
        var cycles = new List<List<string>>();

        // path = the ids currently on the DFS path (the "on path"/grey set, in order).
        // frames = a resumable DFS frame per path node: which neighbor index to visit next.
        var path = new List<string>();
        var frames = new Stack<(string Node, int NextNeighbor)>();

        foreach (string id in adjacency.Keys)
        {
            if (color.TryGetValue(id, out int rootState) && rootState != 0)
            {
                continue;
            }

            color[id] = 1;
            path.Add(id);
            frames.Push((id, 0));

            while (frames.Count > 0)
            {
                (string u, int next) = frames.Pop();
                List<string> neighbors = adjacency.TryGetValue(u, out List<string>? n) ? n : [];

                bool descended = false;
                for (int i = next; i < neighbors.Count; i++)
                {
                    string v = neighbors[i];
                    int state = color.TryGetValue(v, out int c) ? c : 0;
                    if (state == 1)
                    {
                        // Back-edge to a node still on the path: extract the loop.
                        int start = path.IndexOf(v);
                        List<string> cycle = Canonicalize(path.GetRange(start, path.Count - start));
                        if (seenKeys.Add(string.Join(" ", cycle)))
                        {
                            cycles.Add(cycle);
                        }
                    }
                    else if (state == 0)
                    {
                        // Descend into v, resuming u after this neighbor on the way back up.
                        frames.Push((u, i + 1));
                        color[v] = 1;
                        path.Add(v);
                        frames.Push((v, 0));
                        descended = true;
                        break;
                    }
                }

                if (!descended)
                {
                    // u is fully explored; it is the top of the path.
                    color[u] = 2;
                    path.RemoveAt(path.Count - 1);
                }
            }
        }

        return cycles;
    }

    // Rotates a cycle's node list so the lexicographically smallest (ordinal) id leads.
    private static List<string> Canonicalize(List<string> nodes)
    {
        int m = 0;
        for (int i = 1; i < nodes.Count; i++)
        {
            if (string.CompareOrdinal(nodes[i], nodes[m]) < 0)
            {
                m = i;
            }
        }

        var rotated = new List<string>(nodes.Count);
        rotated.AddRange(nodes.GetRange(m, nodes.Count - m));
        rotated.AddRange(nodes.GetRange(0, m));
        return rotated;
    }

    private static void CollectAbsoluteBindingPaths(JsonNode? node, List<string> accumulator)
    {
        switch (node)
        {
            case JsonArray array:
                foreach (JsonNode? item in array)
                {
                    CollectAbsoluteBindingPaths(item, accumulator);
                }

                break;

            case JsonObject obj:
                if (TryGetString(obj["path"]) is string path && path.Length > 0 && path[0] == '/')
                {
                    accumulator.Add(path);
                }

                foreach (KeyValuePair<string, JsonNode?> property in obj)
                {
                    if (!string.Equals(property.Key, "path", StringComparison.Ordinal))
                    {
                        CollectAbsoluteBindingPaths(property.Value, accumulator);
                    }
                }

                break;

            default:
                break;
        }
    }
}
