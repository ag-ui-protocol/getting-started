"""Semantic validation of A2UI v0.9 component trees (OSS-162).

Python port of ``a2ui-toolkit/src/validate.ts`` — kept behaviorally identical so
the framework adapters and the middleware agree on what "valid" means. Adds the
semantic checks (catalog membership, required props, child refs, binding
resolution) whose failures otherwise blow up at render time, turning them into
machine-readable errors the recovery loop can feed back to the sub-agent.
"""

from __future__ import annotations

from typing import Any, Optional

# A validation error is a plain dict: {"code", "path", "message"} — JSON-friendly
# so it can ride straight into a prompt / event payload.
A2UIValidationError = dict[str, str]
ValidateA2UIResult = dict[str, Any]  # {"valid": bool, "errors": list[A2UIValidationError]}


def _is_object(v: Any) -> bool:
    return isinstance(v, dict)


def _absolute_path_resolves(path: str, data: Any) -> bool:
    segments = [s for s in path.split("/") if s]
    cursor: Any = data
    for seg in segments:
        if cursor is None or not isinstance(cursor, (dict, list)):
            return False
        if isinstance(cursor, list):
            try:
                idx = int(seg)
            except ValueError:
                return False
            if idx < 0 or idx >= len(cursor):
                return False
            cursor = cursor[idx]
        else:
            if seg not in cursor:
                return False
            cursor = cursor[seg]
    return True


def _collect_child_refs(children: Any) -> list[str]:
    refs: list[str] = []

    def push(v: Any) -> None:
        if isinstance(v, str):
            refs.append(v)
        elif _is_object(v) and isinstance(v.get("componentId"), str):
            refs.append(v["componentId"])

    if isinstance(children, list):
        for v in children:
            push(v)
    else:
        # A single ``{componentId,...}`` template or a bare string id (the singular
        # ``child`` shape Card/Button use); ``push`` ignores anything else.
        push(children)
    return refs


def _collect_component_ref_edges(comp: dict, schema: Optional[dict]) -> list[tuple[str, str]]:
    """Collect ``(path_suffix, ref_id)`` pairs for every child reference a component makes (#1948).

    The implicit ``child`` (single) and ``children`` (list) fields are ALWAYS ref
    fields, even with no catalog — this preserves the #1944 / catalog-free
    behaviour. Other fields are refs ONLY when the component's catalog schema
    marks the property ``"format": "componentRef"`` (single) or
    ``"componentRefList"`` (list). For an array-typed property whose ``items`` is
    an object schema, marked sub-properties are honoured per element (this finds
    Tabs ``tabItems[].child`` — derived, never hard-coded). An unmarked property
    is data, never a ref: a bare data string and a bare ref string are otherwise
    indistinguishable, so shape-based detection is unsafe.

    Path grammar (byte-aligned with the TS/.NET siblings):
      single-ref field             -> ``<field>``
      list-ref field (array)       -> ``<field>[k]``
      list-ref field (single tmpl) -> ``<field>``
      nested array-of-object ref   -> ``<arrayField>[k].<refField>`` (and ``[j]`` if that sub-field is a list)
    """
    edges: list[tuple[str, str]] = []

    def push_single(field: str, value: Any) -> None:
        for ref in _collect_child_refs(value):
            edges.append((field, ref))

    def push_list(field: str, value: Any) -> None:
        if isinstance(value, list):
            for k, item in enumerate(value):
                for ref in _collect_child_refs(item):
                    edges.append((f"{field}[{k}]", ref))
        else:
            for ref in _collect_child_refs(value):
                edges.append((field, ref))

    # Implicit refs — always, regardless of catalog.
    push_single("child", comp.get("child"))
    push_list("children", comp.get("children"))

    # Explicit catalog-marked refs.
    props = schema.get("properties") if _is_object(schema) else None
    if _is_object(props):
        for field, prop_schema in props.items():
            if field in ("child", "children") or not _is_object(prop_schema):
                continue
            fmt = prop_schema.get("format")
            if fmt == "componentRef":
                push_single(field, comp.get(field))
            elif fmt == "componentRefList":
                push_list(field, comp.get(field))
            elif prop_schema.get("type") == "array" and _is_object(prop_schema.get("items")):
                item_props = prop_schema["items"].get("properties")
                arr_val = comp.get(field)
                if _is_object(item_props) and isinstance(arr_val, list):
                    for k, item in enumerate(arr_val):
                        if not _is_object(item):
                            continue
                        for sub, sub_schema in item_props.items():
                            if not _is_object(sub_schema):
                                continue
                            sub_fmt = sub_schema.get("format")
                            if sub_fmt == "componentRef":
                                for ref in _collect_child_refs(item.get(sub)):
                                    edges.append((f"{field}[{k}].{sub}", ref))
                            elif sub_fmt == "componentRefList":
                                sub_val = item.get(sub)
                                if isinstance(sub_val, list):
                                    for j, sv in enumerate(sub_val):
                                        for ref in _collect_child_refs(sv):
                                            edges.append((f"{field}[{k}].{sub}[{j}]", ref))
                                else:
                                    for ref in _collect_child_refs(sub_val):
                                        edges.append((f"{field}[{k}].{sub}", ref))
    return edges


def _child_adjacency(components: list, catalog: Optional[dict] = None) -> dict[str, list[str]]:
    """id -> ordered child-id references, derived per component via ``_collect_component_ref_edges``."""
    catalog_components = (catalog or {}).get("components", {}) if catalog else {}
    adj: dict[str, list[str]] = {}
    for comp in components:
        if _is_object(comp) and isinstance(comp.get("id"), str):
            ctype = comp.get("component")
            schema = catalog_components.get(ctype) if isinstance(ctype, str) else None
            adj[comp["id"]] = [ref for _, ref in _collect_component_ref_edges(comp, schema)]
    return adj


def _find_child_cycles(components: list, catalog: Optional[dict] = None) -> list[list[str]]:
    """Find unique child-reference cycles (self-references and longer loops) via DFS.

    Each cycle is canonicalised — rotated so the lexicographically smallest id
    leads — so the same loop reached from different entry points collapses to one
    finding, and the reported chain stays byte-identical across the sibling
    toolkits.

    The DFS is iterative (explicit frame stack, not call recursion): the validator
    runs on untrusted model output, so a pathologically deep child chain must not
    raise ``RecursionError`` (and the .NET sibling must not overflow its stack).
    """
    adj = _child_adjacency(components, catalog)
    color: dict[str, int] = {}  # absent/0 = unvisited, 1 = on stack, 2 = done
    cycles: dict[str, list[str]] = {}

    def canonical(nodes: list[str]) -> list[str]:
        m = min(range(len(nodes)), key=lambda i: nodes[i])
        return nodes[m:] + nodes[:m]

    for root in adj:
        if color.get(root, 0) != 0:
            continue
        # ``frames`` is the explicit DFS stack ([node, next-neighbor-index]);
        # ``path`` mirrors the on-stack (gray) nodes in entry order, so
        # ``path.index(v)`` recovers the cycle slice on a back edge.
        frames: list[list] = [[root, 0]]
        path: list[str] = [root]
        color[root] = 1
        while frames:
            node, i = frames[-1][0], frames[-1][1]
            neighbors = adj.get(node, [])
            if i >= len(neighbors):
                color[node] = 2
                frames.pop()
                path.pop()
                continue
            frames[-1][1] += 1
            v = neighbors[i]
            c = color.get(v, 0)
            if c == 0:
                color[v] = 1
                path.append(v)
                frames.append([v, 0])
            elif c == 1:
                cyc = canonical(path[path.index(v):])
                key = " ".join(cyc)
                if key not in cycles:
                    cycles[key] = cyc
    return list(cycles.values())


def _collect_absolute_binding_paths(node: Any, acc: list[str]) -> list[str]:
    if isinstance(node, list):
        for v in node:
            _collect_absolute_binding_paths(v, acc)
    elif _is_object(node):
        p = node.get("path")
        if isinstance(p, str) and p.startswith("/"):
            acc.append(p)
        for k, v in node.items():
            if k == "path":
                continue
            _collect_absolute_binding_paths(v, acc)
    return acc


def validate_a2ui_components(
    *,
    components: Any,
    data: Optional[dict[str, Any]] = None,
    catalog: Optional[dict[str, Any]] = None,
    validate_bindings: bool = True,
) -> ValidateA2UIResult:
    """Validate a flat A2UI v0.9 component array.

    Structural checks always run. Catalog membership + required-prop checks run
    only when ``catalog`` is supplied. Absolute binding paths (``/foo``) resolve
    against ``data``; relative template paths (``name``) are left alone — they
    resolve per-item inside a repeated template and flagging them would produce
    false positives (and spurious retries).
    """
    errors: list[A2UIValidationError] = []

    # Fail loud on a non-list / empty payload.
    if not isinstance(components, list) or len(components) == 0:
        return {
            "valid": False,
            "errors": [{"code": "empty_components", "path": "components", "message": "A2UI components must be a non-empty array"}],
        }

    ids: set[str] = set()
    seen: set[str] = set()
    for comp in components:
        cid = comp.get("id") if _is_object(comp) else None
        if isinstance(cid, str):
            if cid in seen:
                errors.append({"code": "duplicate_id", "path": f"components[id={cid}]", "message": f"Duplicate component id '{cid}'"})
            seen.add(cid)
            ids.add(cid)

    catalog_components = (catalog or {}).get("components", {}) if catalog else {}

    for i, comp in enumerate(components):
        cid = comp.get("id") if _is_object(comp) else None
        ctype = comp.get("component") if _is_object(comp) else None

        if not isinstance(cid, str) or len(cid) == 0:
            errors.append({"code": "missing_id", "path": f"components[{i}].id", "message": f"Component at index {i} is missing a string 'id'"})
        if not isinstance(ctype, str) or len(ctype) == 0:
            errors.append({"code": "missing_component_type", "path": f"components[{i}].component", "message": f"Component at index {i} is missing a string 'component' type"})

        if catalog and isinstance(ctype, str):
            schema = catalog_components.get(ctype)
            if schema is None:
                errors.append({"code": "unknown_component", "path": f"components[{i}].component", "message": f"Component type '{ctype}' is not in the catalog"})
            else:
                for req in schema.get("required", []) or []:
                    if not _is_object(comp) or req not in comp:
                        errors.append({"code": "missing_required_prop", "path": f"components[{i}].{req}", "message": f"Component '{ctype}' (index {i}) is missing required prop '{req}'"})

        if _is_object(comp):
            # Implicit ``child``/``children`` are always checked; catalog-marked
            # ref-fields (Modal ``trigger``/``content``, Tabs ``tabItems[].child``,
            # ...) are checked too when a catalog is supplied. A dangling reference
            # in any of them feeds the recovery loop. See ``_collect_component_ref_edges``.
            schema = catalog_components.get(ctype) if isinstance(ctype, str) else None
            for ref_path, ref in _collect_component_ref_edges(comp, schema):
                if ref not in ids:
                    errors.append({"code": "unresolved_child", "path": f"components[{i}].{ref_path}", "message": f"Child reference '{ref}' does not match any component id"})
            for p in (_collect_absolute_binding_paths(comp, []) if validate_bindings else []):
                if not _absolute_path_resolves(p, data or {}):
                    errors.append({"code": "unresolved_binding", "path": f"components[{i}]", "message": f"Binding path '{p}' does not resolve in the data model"})

    # The child reference tree must be a DAG — a component that (transitively)
    # references itself never terminates at render time. Report each cycle once.
    for cycle in _find_child_cycles(components, catalog):
        chain = " -> ".join(cycle + [cycle[0]])
        errors.append({"code": "child_cycle", "path": f"components[id={cycle[0]}]", "message": f"Child reference cycle detected: {chain}"})

    if not any(_is_object(c) and c.get("id") == "root" for c in components):
        errors.append({"code": "no_root", "path": "components", "message": "No component has id 'root'"})

    return {"valid": len(errors) == 0, "errors": errors}
