package com.agui.adk.error;

/**
 * Pure port of the Python {@code utils/converters.py create_error_message}: formats a
 * user-friendly error string from a throwable and an optional context.
 */
public final class UserMessageFormatter {

    private UserMessageFormatter() {
    }

    /**
     * Formats {@code "context: Type - message"} when a context is given, else
     * {@code "Type: message"} (Python {@code create_error_message}).
     *
     * @param error   the throwable
     * @param context optional context prefix (may be null/empty)
     * @return the formatted message
     */
    public static String createErrorMessage(Throwable error, String context) {
        String errorType = error.getClass().getSimpleName();
        String errorMsg = error.getMessage() == null ? "" : error.getMessage();
        if (context != null && !context.isEmpty()) {
            return context + ": " + errorType + " - " + errorMsg;
        }
        return errorType + ": " + errorMsg;
    }
}
