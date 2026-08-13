# AG-UI middleware for Google ADK (Java)

This standalone module connects Google Agent Development Kit (ADK) agents to AG-UI clients. It translates ADK events into the AG-UI event stream and supports shared state, tool calls, human-in-the-loop workflows, authentication requests, message history, and A2UI payloads.

## Requirements

- Java 21 or newer
- Maven 3.9 or newer
- Node.js is downloaded locally by Maven for the protocol client tests

All Maven dependencies are available from Maven Central. No repository configuration is required.

## Add the middleware

Until a release is published, build and install the snapshot locally:

```bash
mvn install
```

Then depend on:

```xml
<dependency>
  <groupId>com.agui.community</groupId>
  <artifactId>adk-middleware</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

The main entry point is `com.agui.adk.GoogleAdkAgent`. Use its builder to provide the ADK runner or agent services needed by your application, then expose the resulting AG-UI agent through the Java server integration.

## Test

```bash
mvn test
```

The Maven test lifecycle runs both the Java test suite and the Node.js AG-UI client protocol tests. Live integration tests are excluded by default; enable them explicitly with:

```bash
mvn -Plive-tests test
```

Build the standalone JAR with:

```bash
mvn package
```

## Source layout

- `src/main/java/com/agui/adk`: middleware implementation
- `src/main/resources/a2ui`: bundled A2UI schemas
- `src/test/java/com/agui/adk`: Java tests
- `src/test/node`: AG-UI client and protocol tests
