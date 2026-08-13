package com.agui.adk.session;

/**
 * Internal session-state keys owned by the AG-UI to ADK bridge.
 *
 * <p>Values with this prefix must never be accepted from, or exposed to, an AG-UI client.
 */
public final class SessionStateKeys {

    public static final String PREFIX = "_ag_ui_";
    public static final String THREAD_ID = PREFIX + "thread_id";
    public static final String APP_NAME = PREFIX + "app_name";
    public static final String USER_ID = PREFIX + "user_id";
    public static final String CLIENT_STATE = PREFIX + "client_state";
    public static final String REQUEST_CONTEXT = PREFIX + "request_context";

    private SessionStateKeys() {
    }

    /**
     * Determines whether a state key is reserved for bridge internals.
     *
     * @param key candidate state key
     * @return whether the key is protected
     */
    public static boolean isProtected(String key) {
        return key != null && key.startsWith(PREFIX);
    }
}
