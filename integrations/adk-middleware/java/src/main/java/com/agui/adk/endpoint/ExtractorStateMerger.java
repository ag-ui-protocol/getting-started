package com.agui.adk.endpoint;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Pure port of the Python {@code endpoint.py} request-state extraction merge semantics:
 * {@code _merge_extractor_state} ({@code {**existing, **extracted}}) and
 * {@code make_extract_headers} (header extraction into {@code state.headers}, with client
 * headers taking precedence over extracted headers).
 *
 * <p>These mirrors of Python's {@code {**a, **b}} dict-merge preserve insertion order
 * (LinkedHashMap) and let later maps' values win while keeping earlier key positions. The
 * HTTP request/fastapi hosting glue is hosting-app territory; these are the pure,
 * offline-testable merge cores.
 */
public final class ExtractorStateMerger {

    private ExtractorStateMerger() {
    }

    /**
     * Merges {@code extracted} over {@code existing} (Python {@code {**existing, **extracted}}),
     * treating null maps as empty. Extraction wins on conflicts; existing keys keep position.
     *
     * @param existing  the existing state (may be null / non-dict)
     * @param extracted the extracted state (may be null / empty)
     * @return the merged state map (never null)
     */
    public static Map<String, Object> mergeState(Map<String, Object> existing,
                                                 Map<String, Object> extracted) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (existing != null) {
            out.putAll(existing);
        }
        if (extracted != null) {
            out.putAll(extracted);
        }
        return out;
    }

    /**
     * Port of the Python {@code make_extract_headers} core: build {@code state.headers} from the
     * given request-header values, then merge client headers over extracted ones.
     *
     * <p>Returns an empty map when no header is extracted (the {@code extract_headers} extractor
     * returns {@code {}} there, signalling "no change"); otherwise returns {@code {**existing,
     * "headers": {**headersDict, **existingHeaders}}}.
     *
     * @param headersToExtract the header names to extract (may be null/empty)
     * @param requestHeaderValues resolved header values keyed by header name (may be null)
     * @param inputState        the input {@code state} (may be null)
     * @return the merged state map, or an empty map when nothing was extracted
     */
    public static Map<String, Object> extractHeadersState(
            List<String> headersToExtract,
            Map<String, String> requestHeaderValues,
            Map<String, Object> inputState) {
        if (headersToExtract == null || headersToExtract.isEmpty()
                || requestHeaderValues == null) {
            return new LinkedHashMap<>();
        }
        Map<String, Object> headersDict = new LinkedHashMap<>();
        for (String headerName : headersToExtract) {
            String value = requestHeaderValues.get(headerName);
            if (value != null) {
                headersDict.put(HeaderExtraction.headerToKey(headerName), value);
            }
        }
        if (headersDict.isEmpty()) {
            return new LinkedHashMap<>();
        }
        Map<String, Object> existing = inputState == null ? new LinkedHashMap<>() : inputState;
        Map<String, Object> existingHeaders = new LinkedHashMap<>();
        Object existingHeadersObj = existing.get("headers");
        if (existingHeadersObj instanceof Map) {
            existingHeaders.putAll((Map<String, Object>) existingHeadersObj);
        }
        Map<String, Object> mergedHeaders = new LinkedHashMap<>();
        mergedHeaders.putAll(headersDict);
        mergedHeaders.putAll(existingHeaders); // client headers take precedence
        Map<String, Object> mergedState = new LinkedHashMap<>();
        mergedState.putAll(existing);
        mergedState.put("headers", mergedHeaders);
        return mergedState;
    }
}
