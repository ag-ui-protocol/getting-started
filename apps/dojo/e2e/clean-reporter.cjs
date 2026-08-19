function getTimestamp() {
  return process.env.CI || process.env.VERBOSE
    ? new Date().toLocaleTimeString("en-US", { hour12: false })
    : "";
}

function logStamp(...args) {
  console.log(getTimestamp(), ...args);
}

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return error.message || error.stack || "";
}

function eventTraceMismatchText(result) {
  const candidates = [result.error, ...(result.errors || [])]
    .flatMap((error) => {
      if (!error || typeof error === "string") return [errorText(error)];
      return [error.message, error.stack].filter(Boolean);
    })
    .filter((text) => text?.includes("Event trace mismatch:"));

  const mismatch = candidates.toSorted(
    (left, right) => right.length - left.length,
  )[0];
  if (!mismatch) return undefined;

  const withoutName = mismatch.replace(/^EventTraceAssertionError:\s*/, "");
  const endMarker = "Full traces are attached to the Playwright test result.";
  const end = withoutName.indexOf(endMarker);
  return end === -1
    ? withoutName
    : withoutName.slice(0, end + endMarker.length);
}

class CleanReporter {
  onBegin(config, suite) {
    console.log(`\n🎭 Running ${suite.allTests().length} tests...\n`);
  }

  onTestEnd(test, result) {
    const suiteName = test.parent?.title || "Unknown";
    const testName = test.title;

    // Clean up suite name
    const cleanSuite = suiteName
      .replace(/Tests?$/i, "")
      .replace(/Page$/i, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim();

    if (result.status === "passed") {
      logStamp(`✅ PASS ${cleanSuite}: ${testName}`);
      return;
    }

    if (result.status === "skipped") {
      console.log(`⚠️ SKIP ${cleanSuite}: ${testName} (skipped)`);
      return;
    }

    // Handle all failure modes: "failed", "timedOut", "interrupted"
    const icon = result.status === "timedOut" ? "⏰ TIMEOUT" : "❌ FAIL";
    logStamp(`${icon} ${cleanSuite}: ${testName}`);

    // Extract the most relevant error info
    const error = result.error || result.errors?.[0];
    if (error) {
      const semanticEventTraceMismatch = eventTraceMismatchText(result);
      let errorMsg = errorText(error) || "Unknown error";
      const isEventTraceMismatch = semanticEventTraceMismatch !== undefined;

      // Clean up common error patterns to make them more readable
      if (errorMsg.includes("None of the expected patterns matched")) {
        const patterns = errorMsg.match(/patterns matched[^:]*: ([^`]+)/);
        errorMsg = `AI response timeout - Expected: ${
          patterns?.[1] || "AI response"
        }`;
      } else if (
        errorMsg.includes("Timed out") &&
        errorMsg.includes("toBeVisible")
      ) {
        const element = errorMsg.match(/locator\('([^']+)'\)/);
        errorMsg = `Element not found: ${element?.[1] || "UI element"}`;
      } else if (errorMsg.includes("Test timeout of")) {
        errorMsg = errorMsg.split("\n")[0];
      } else if (errorMsg.includes("toBeGreaterThan")) {
        errorMsg = "Expected content not generated (count was 0)";
      }

      if (isEventTraceMismatch) {
        const semanticDiff = semanticEventTraceMismatch
          .split("\n")
          .map((line) => `   ${line}`)
          .join("\n");
        console.log(`💥   ERROR:\n${semanticDiff}`);
      } else {
        // Show just the key error info
        console.log(`💥   ERROR: ${errorMsg.split("\n")[0]}`);
      }

      // If it's an AI/API issue, make it clear
      if (
        !isEventTraceMismatch &&
        (errorMsg.includes("AI") ||
          errorMsg.includes("patterns") ||
          errorMsg.includes("timeout"))
      ) {
        console.log(`   HINT: Likely cause: AI service down or API key issue`);
      }
    }

    // Surface diagnostic output from test-isolation-helper on failure.
    // This includes AI State Dump, NetworkError, PageError, and
    // BrowserConsole lines that would otherwise be hidden by this reporter.
    const diagnosticPrefixes = [
      "[AI State Dump]",
      "[NetworkError]",
      "[PageError]",
      "[BrowserConsole]",
      "[Test Cleanup]",
      "[User]",
      "[Assistant]",
    ];
    const stdout = (result.stdout || [])
      .map((chunk) =>
        typeof chunk === "string" ? chunk : chunk.toString("utf-8"),
      )
      .join("");
    const diagnosticLines = stdout
      .split("\n")
      .filter((line) => diagnosticPrefixes.some((p) => line.includes(p)));
    if (diagnosticLines.length > 0) {
      console.log("   --- Diagnostics ---");
      for (const line of diagnosticLines) {
        console.log(`   ${line.trim()}`);
      }
    }

    console.log(""); // Extra spacing after failures
  }

  onEnd(result) {
    console.log("\n" + "=".repeat(60));
    logStamp(`📊 TEST SUMMARY`);
    console.log("=".repeat(60));

    if (!process.env.CI) {
      console.log(
        `Run 'pnpm exec playwright show-report' for detailed HTML report`,
      );
    }

    console.log("=".repeat(60) + "\n");
  }
}

module.exports = CleanReporter;
