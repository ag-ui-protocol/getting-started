package com.agui.community.client;

/**
 * Signals that an {@link HttpAgent} run failed, for example because the remote
 * endpoint returned an error status. Delivered to subscribers via
 * {@code onError}.
 */
public class HttpAgentException extends RuntimeException {

    public HttpAgentException(String message) {
        super(message);
    }

    public HttpAgentException(String message, Throwable cause) {
        super(message, cause);
    }
}
