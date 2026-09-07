# Logging

The middleware logs through SLF4J 2.0 API. It does not bundle an SLF4J provider and does not read log-level environment variables.

## Add a provider in the application

For a small command-line application:

```xml
<dependency>
  <groupId>org.slf4j</groupId>
  <artifactId>slf4j-simple</artifactId>
  <version>2.0.17</version>
  <scope>runtime</scope>
</dependency>
```

Applications already using Logback, Log4j 2, or a framework logging starter should use that existing provider instead. Do not add multiple providers.

## Logger names

Loggers use class names, so the useful namespaces are:

- `com.agui.adk.GoogleAdkAgent`
- `com.agui.adk.SessionManager`
- `com.agui.adk.tool.AgUiToolset`
- broader namespace: `com.agui.adk`

There are no documented custom logging categories such as `adk_agent` or `event_translator`; those names belong to the Python implementation and will not configure Java logs.

Example `simplelogger.properties`:

```properties
org.slf4j.simpleLogger.defaultLogLevel=warn
org.slf4j.simpleLogger.log.com.agui.adk=info
org.slf4j.simpleLogger.log.com.agui.adk.SessionManager=debug
org.slf4j.simpleLogger.showDateTime=true
org.slf4j.simpleLogger.dateTimeFormat=yyyy-MM-dd'T'HH:mm:ss.SSSXXX
```

Place it on the runtime classpath. Provider-specific configuration belongs to the provider documentation.

## What is logged

Current implementation messages include session creation/reuse/deletion, cleanup completion/failure, pending-call verification, skipped invalid frontend tool schemas, lifecycle preparation/finalization failures, and some close/persistence warnings. Identifiers such as app, user, session, thread, and tool name may appear. Stack traces originate from the bridge and downstream ADK/service exceptions.

The bridge does not intentionally log complete HTTP headers or a general dump of `RunAgentInput`, but a downstream exception can include provider/request details. Treat logs as sensitive operational data.

## Production guidance

- Default `com.agui.adk` to `INFO` or `WARN`; enable `DEBUG` temporarily for a scoped incident.
- Restrict log access and retention because session/user/thread identifiers may be personal or tenant data.
- Do not forward authorization headers, cookies, tokens, or API keys into state; preventing sensitive data from entering the bridge is safer than log redaction.
- Redact exceptions and structured fields in the hosting provider if organizational policy requires it.
- Correlate requests with a host-generated opaque request/run ID, not credentials or raw personal data.
- Avoid logging tool arguments/results, A2UI data models, full messages, or schemas in application adapters.
- Monitor counts and latency for `RUN_ERROR`, admission rejections, session-service errors, cleanup failures, and HITL resume conflicts without recording payload contents.

SLF4J configuration does not control Google ADK, Google GenAI, HTTP-server, or cloud-client logger namespaces; configure those libraries separately.
