package com.agui.adk.a2ui;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Semantic validation of A2UI v0.9 component trees — behaviorally identical port of the toolkit's
 * {@code validate_a2ui_components} ({@code ag_ui_a2ui_toolkit/validate.py}, itself the Python twin
 * of {@code a2ui-toolkit/src/validate.ts}).
 *
 * <p>Structural checks always run: non-empty list, unique ids, string id/component, implicit
 * {@code child}/{@code children} reference resolution, binding-path resolution against the data
 * model, child-reference DAG (no cycles), and a {@code root} id. Catalog membership and required-prop
 * checks run only when a catalog is supplied. Errors are plain {@code {code, path, message}} maps —
 * JSON-friendly so they ride straight into the recovery prompt.
 */
public final class A2uiComponentsValidator {

    private A2uiComponentsValidator() {
    }

    /** A single validation error: {@code {code, path, message}}. */
    public record Error(String code, String path, String message) {

        /** @return the error as a {@code {code, path, message}} string map */
        public Map<String, String> asMap() {
            Map<String, String> map = new LinkedHashMap<>();
            map.put("code", code);
            map.put("path", path);
            map.put("message", message);
            return map;
        }
    }

    /**
     * Validates a flat A2UI v0.9 component array.
     *
     * @param components       the generated components value (untrusted; may be a non-list)
     * @param data             the generated data model (may be null)
     * @param catalog          normalized validation catalog, or null for structural-only checks
     * @return {@code {valid, errors}} verdict
     */
    public static Verdict validate(Object components, Object data, Map<String, Object> catalog) {
        return validate(components, data, catalog, true);
    }

    /**
     * Validates a flat A2UI v0.9 component array with an explicit binding-check toggle.
     *
     * @param components       the generated components value (untrusted; may be a non-list)
     * @param data             the generated data model (may be null)
     * @param catalog          normalized validation catalog, or null for structural-only checks
     * @param validateBindings whether absolute binding paths must resolve against {@code data}
     * @return {@code {valid, errors}} verdict
     */
    public static Verdict validate(Object components, Object data, Map<String, Object> catalog,
                                   boolean validateBindings) {
        List<Error> errors = new ArrayList<>();

        // Fail loud on a non-list / empty payload.
        if (!(components instanceof List<?> list) || list.isEmpty()) {
            return new Verdict(false, List.of(new Error("empty_components", "components",
                    "A2UI components must be a non-empty array")));
        }

        Set<String> seen = new LinkedHashSet<>();
        Set<String> ids = new LinkedHashSet<>();
        for (Object compObj : list) {
            Object cid = compObj instanceof Map<?, ?> comp ? comp.get("id") : null;
            if (cid instanceof String s) {
                if (!seen.add(s)) {
                    errors.add(new Error("duplicate_id", "components[id=" + s + "]",
                            "Duplicate component id '" + s + "'"));
                }
                ids.add(s);
            }
        }

        Map<?, ?> catalogComponents = Map.of();
        if (catalog != null) {
            Object comps = catalog.get("components");
            if (comps instanceof Map<?, ?>) {
                catalogComponents = (Map<?, ?>) comps;
            }
        }

        for (int i = 0; i < list.size(); i++) {
            Object compObj = list.get(i);
            Map<?, ?> comp = compObj instanceof Map<?, ?> m ? m : null;
            Object cid = comp == null ? null : comp.get("id");
            Object ctype = comp == null ? null : comp.get("component");

            if (!(cid instanceof String s) || s.isEmpty()) {
                errors.add(new Error("missing_id", "components[" + i + "].id",
                        "Component at index " + i + " is missing a string 'id'"));
            }
            if (!(ctype instanceof String t) || t.isEmpty()) {
                errors.add(new Error("missing_component_type", "components[" + i + "].component",
                        "Component at index " + i + " is missing a string 'component' type"));
            }

            if (catalog != null && ctype instanceof String t) {
                Object schema = catalogComponents.get(t);
                if (schema == null) {
                    errors.add(new Error("unknown_component", "components[" + i + "].component",
                            "Component type '" + t + "' is not in the catalog"));
                } else if (schema instanceof Map<?, ?> schemaMap) {
                    Object required = schemaMap.get("required");
                    if (required instanceof List<?> reqList) {
                        for (Object reqObj : reqList) {
                            if (!(reqObj instanceof String req) || comp == null || !comp.containsKey(req)) {
                                errors.add(new Error("missing_required_prop", "components[" + i + "]." + reqObj,
                                        "Component '" + t + "' (index " + i + ") is missing required prop '" + reqObj + "'"));
                            }
                        }
                    }
                }
            }

            if (comp != null) {
                Object schema = ctype instanceof String t ? catalogComponents.get(t) : null;
                for (Edge edge : collectComponentRefEdges(comp, schema instanceof Map<?, ?> sm ? sm : null)) {
                    if (!ids.contains(edge.ref())) {
                        errors.add(new Error("unresolved_child", "components[" + i + "]." + edge.path(),
                                "Child reference '" + edge.ref() + "' does not match any component id"));
                    }
                }
                if (validateBindings) {
                    Object dataModel = data == null ? Map.of() : data;
                    for (String path : collectAbsoluteBindingPaths(comp)) {
                        if (!absolutePathResolves(path, dataModel)) {
                            errors.add(new Error("unresolved_binding", "components[" + i + "]",
                                    "Binding path '" + path + "' does not resolve in the data model"));
                        }
                    }
                }
            }
        }

        // The child reference tree must be a DAG — report each cycle once.
        for (List<String> cycle : findChildCycles(list, catalogComponents)) {
            StringBuilder chain = new StringBuilder();
            for (String node : cycle) {
                chain.append(node).append(" -> ");
            }
            chain.append(cycle.get(0));
            errors.add(new Error("child_cycle", "components[id=" + cycle.get(0) + "]",
                    "Child reference cycle detected: " + chain));
        }

        boolean hasRoot = false;
        for (Object compObj : list) {
            if (compObj instanceof Map<?, ?> comp && "root".equals(comp.get("id"))) {
                hasRoot = true;
                break;
            }
        }
        if (!hasRoot) {
            errors.add(new Error("no_root", "components",
                    "No component has id 'root'"));
        }

        return new Verdict(errors.isEmpty(), errors);
    }

    /** Validation verdict ({@code valid} + structured {@code errors}). */
    public record Verdict(boolean valid, List<Error> errors) {

        /** @return the errors as {@code {code, path, message}} string maps */
        public List<Map<String, String>> errorMaps() {
            List<Map<String, String>> out = new ArrayList<>();
            for (Error error : errors) {
                out.add(error.asMap());
            }
            return out;
        }
    }

    /** One child-reference edge: {@code (path suffix, ref id)}. */
    private record Edge(String path, String ref) {
    }

    /**
     * Collects {@code (path_suffix, ref_id)} pairs for every child reference a component makes: the
     * implicit {@code child} (single) and {@code children} (list) fields are ALWAYS ref fields; other
     * fields only when the catalog schema marks the property {@code "format": "componentRef"} /
     * {@code "componentRefList"} (including nested array-of-object refs like Tabs {@code tabItems[].child}).
     *
     * @param comp   the component map
     * @param schema the component's catalog schema, or null
     * @return the ordered reference edges
     */
    private static List<Edge> collectComponentRefEdges(Map<?, ?> comp, Map<?, ?> schema) {
        List<Edge> edges = new ArrayList<>();

        pushSingle(edges, "child", comp.get("child"));
        pushList(edges, "children", comp.get("children"));

        Map<?, ?> props = schema == null ? null
                : schema.get("properties") instanceof Map<?, ?> p ? p : null;
        if (props != null) {
            for (Map.Entry<?, ?> entry : props.entrySet()) {
                Object field = entry.getKey();
                Object propSchema = entry.getValue();
                if ("child".equals(field) || "children".equals(field)) {
                    continue;
                }
                if (!(propSchema instanceof Map<?, ?> ps)) {
                    continue;
                }
                Object format = ps.get("format");
                if ("componentRef".equals(format)) {
                    pushSingle(edges, String.valueOf(field), comp.get(field));
                } else if ("componentRefList".equals(format)) {
                    pushList(edges, String.valueOf(field), comp.get(field));
                } else if ("array".equals(ps.get("type"))
                        && ps.get("items") instanceof Map<?, ?> items
                        && items.get("properties") instanceof Map<?, ?> itemProps
                        && comp.get(field) instanceof List<?> arrVal) {
                    for (int k = 0; k < arrVal.size(); k++) {
                        Object item = arrVal.get(k);
                        if (!(item instanceof Map<?, ?> itemMap)) {
                            continue;
                        }
                        for (Map.Entry<?, ?> subEntry : itemProps.entrySet()) {
                            Object sub = subEntry.getKey();
                            Object subSchema = subEntry.getValue();
                            if (!(subSchema instanceof Map<?, ?> ss)) {
                                continue;
                            }
                            Object subFormat = ss.get("format");
                            if ("componentRef".equals(subFormat)) {
                                for (String ref : collectChildRefs(itemMap.get(sub))) {
                                    edges.add(new Edge(field + "[" + k + "]." + sub, ref));
                                }
                            } else if ("componentRefList".equals(subFormat)) {
                                Object subVal = itemMap.get(sub);
                                if (subVal instanceof List<?> subList) {
                                    for (int j = 0; j < subList.size(); j++) {
                                        for (String ref : collectChildRefs(subList.get(j))) {
                                            edges.add(new Edge(field + "[" + k + "]." + sub + "[" + j + "]", ref));
                                        }
                                    }
                                } else {
                                    for (String ref : collectChildRefs(subVal)) {
                                        edges.add(new Edge(field + "[" + k + "]." + sub, ref));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return edges;
    }

    /**
     * Appends the single-ref edges for a field.
     *
     * @param edges accumulator
     * @param field the path suffix
     * @param value the field value
     */
    private static void pushSingle(List<Edge> edges, String field, Object value) {
        for (String ref : collectChildRefs(value)) {
            edges.add(new Edge(field, ref));
        }
    }

    /**
     * Appends the list-ref edges for a field: {@code field[k]} per list element, or {@code field}
     * for a single template value.
     *
     * @param edges accumulator
     * @param field the path suffix
     * @param value the field value
     */
    private static void pushList(List<Edge> edges, String field, Object value) {
        if (value instanceof List<?> list) {
            for (int k = 0; k < list.size(); k++) {
                for (String ref : collectChildRefs(list.get(k))) {
                    edges.add(new Edge(field + "[" + k + "]", ref));
                }
            }
        } else {
            for (String ref : collectChildRefs(value)) {
                edges.add(new Edge(field, ref));
            }
        }
    }

    /**
     * Collects child-id references from a value: a bare string id, or an object carrying a string
     * {@code componentId} (a single template).
     *
     * @param value the value to scan
     * @return the referenced ids
     */
    private static List<String> collectChildRefs(Object value) {
        List<String> refs = new ArrayList<>();
        if (value instanceof String s) {
            refs.add(s);
        } else if (value instanceof Map<?, ?> m && m.get("componentId") instanceof String s) {
            refs.add(s);
        }
        return refs;
    }

    /**
     * Builds the id → ordered child-id adjacency per component.
     *
     * @param components         the component list
     * @param catalogComponents  the catalog components map (may be empty)
     * @return the adjacency map
     */
    private static Map<String, List<String>> childAdjacency(List<?> components, Map<?, ?> catalogComponents) {
        Map<String, List<String>> adj = new LinkedHashMap<>();
        for (Object compObj : components) {
            if (compObj instanceof Map<?, ?> comp && comp.get("id") instanceof String id) {
                Object ctype = comp.get("component");
                Map<?, ?> schema = ctype instanceof String t && catalogComponents.get(t) instanceof Map<?, ?> sm
                        ? sm : null;
                List<String> refs = new ArrayList<>();
                for (Edge edge : collectComponentRefEdges(comp, schema)) {
                    refs.add(edge.ref());
                }
                adj.put(id, refs);
            }
        }
        return adj;
    }

    /**
     * Finds unique child-reference cycles (self-references and longer loops) via iterative DFS. Each
     * cycle is canonicalized — rotated so the lexicographically smallest id leads — so the same loop
     * reached from different entry points collapses to one finding. Iterative (explicit stack) so
     * pathological depth on untrusted model output cannot raise a stack overflow.
     *
     * @param components        the component list
     * @param catalogComponents the catalog components map
     * @return the canonicalized cycles
     */
    private static List<List<String>> findChildCycles(List<?> components, Map<?, ?> catalogComponents) {
        Map<String, List<String>> adj = childAdjacency(components, catalogComponents);
        Map<String, Integer> color = new HashMap<>(); // absent/0 unvisited, 1 on stack, 2 done
        Map<String, List<String>> cycles = new LinkedHashMap<>();

        for (String root : adj.keySet()) {
            if (color.getOrDefault(root, 0) != 0) {
                continue;
            }
            // Explicit DFS: `nodes` holds the frame node names, `nextIdx` the per-frame next
            // neighbor index, and `path` mirrors the on-stack (gray) nodes in entry order so
            // path.indexOf(v) recovers the cycle slice on a back edge (Python port).
            List<String> nodes = new ArrayList<>();
            List<Integer> nextIdx = new ArrayList<>();
            List<String> path = new ArrayList<>();
            nodes.add(root);
            nextIdx.add(0);
            path.add(root);
            color.put(root, 1);
            while (!nodes.isEmpty()) {
                String node = nodes.get(nodes.size() - 1);
                int i = nextIdx.get(nextIdx.size() - 1);
                List<String> neighbors = adj.getOrDefault(node, List.of());
                if (i >= neighbors.size()) {
                    color.put(node, 2);
                    nodes.remove(nodes.size() - 1);
                    nextIdx.remove(nextIdx.size() - 1);
                    path.remove(path.size() - 1);
                    continue;
                }
                nextIdx.set(nextIdx.size() - 1, i + 1);
                String v = neighbors.get(i);
                int c = color.getOrDefault(v, 0);
                if (c == 0) {
                    color.put(v, 1);
                    nodes.add(v);
                    nextIdx.add(0);
                    path.add(v);
                } else if (c == 1) {
                    List<String> cycle = new ArrayList<>(path.subList(path.indexOf(v), path.size()));
                    List<String> canonical = canonicalize(cycle);
                    String key = String.join(" ", canonical);
                    cycles.putIfAbsent(key, canonical);
                }
            }
        }
        return new ArrayList<>(cycles.values());
    }

    /**
     * Rotates a cycle so the lexicographically smallest id leads.
     *
     * @param nodes the cycle nodes in discovery order
     * @return the canonical rotation
     */
    private static List<String> canonicalize(List<String> nodes) {
        if (nodes.isEmpty()) {
            return nodes;
        }
        int min = 0;
        for (int i = 1; i < nodes.size(); i++) {
            if (nodes.get(i).compareTo(nodes.get(min)) < 0) {
                min = i;
            }
        }
        List<String> out = new ArrayList<>(nodes.size());
        for (int i = 0; i < nodes.size(); i++) {
            out.add(nodes.get((min + i) % nodes.size()));
        }
        return out;
    }

    /**
     * Collects every absolute binding path ({@code "/foo"}) in a value tree.
     *
     * @param node the value to scan
     * @return the collected paths
     */
    private static List<String> collectAbsoluteBindingPaths(Object node) {
        List<String> acc = new ArrayList<>();
        collectAbsoluteBindingPaths(node, acc);
        return acc;
    }

    /**
     * Recursively collects absolute binding paths, mutating {@code acc}.
     *
     * @param node the value to scan
     * @param acc  the accumulator
     */
    private static void collectAbsoluteBindingPaths(Object node, List<String> acc) {
        if (node instanceof List<?> list) {
            for (Object item : list) {
                collectAbsoluteBindingPaths(item, acc);
            }
        } else if (node instanceof Map<?, ?> map) {
            Object p = map.get("path");
            if (p instanceof String s && s.startsWith("/")) {
                acc.add(s);
            }
            for (Map.Entry<?, ?> e : map.entrySet()) {
                if ("path".equals(e.getKey())) {
                    continue;
                }
                collectAbsoluteBindingPaths(e.getValue(), acc);
            }
        }
    }

    /**
     * Resolves an absolute JSON-pointer-ish path against the data model (Python {@code _absolute_path_resolves}).
     *
     * @param path the absolute path
     * @param data the data model
     * @return whether every segment resolves
     */
    private static boolean absolutePathResolves(String path, Object data) {
        String[] segments = path.split("/");
        Object cursor = data;
        for (String seg : segments) {
            if (seg.isEmpty()) {
                continue;
            }
            if (cursor == null || !(cursor instanceof Map<?, ?> || cursor instanceof List<?>)) {
                return false;
            }
            if (cursor instanceof List<?> list) {
                int idx;
                try {
                    idx = Integer.parseInt(seg);
                } catch (NumberFormatException e) {
                    return false;
                }
                if (idx < 0 || idx >= list.size()) {
                    return false;
                }
                cursor = list.get(idx);
            } else {
                Map<?, ?> map = (Map<?, ?>) cursor;
                if (!map.containsKey(seg)) {
                    return false;
                }
                cursor = map.get(seg);
            }
        }
        return true;
    }
}
