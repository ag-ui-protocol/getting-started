package com.agui.adk.error;

import java.util.Objects;

/** Exception retaining the stable public error code for a bridge failure. */
public final class AdkAgUiException extends RuntimeException {
    private final AdkAgUiErrorCode code;

    public AdkAgUiException(AdkAgUiErrorCode code, String message) {
        super(message);
        this.code = Objects.requireNonNull(code, "code");
    }

    public AdkAgUiException(AdkAgUiErrorCode code, String message, Throwable cause) {
        super(message, cause);
        this.code = Objects.requireNonNull(code, "code");
    }

    public AdkAgUiErrorCode code() {
        return code;
    }
}
