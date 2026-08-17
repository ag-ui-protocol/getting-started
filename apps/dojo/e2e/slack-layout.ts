import { Block, KnownBlock } from "@slack/types";
import { SummaryResults } from "playwright-slack-report/dist/src";
import { readFileSync, existsSync } from "fs";

/**
 * The subset of playwright-slack-report's per-test summary entry that this
 * layout reads. Declared locally rather than imported: the fields below are all
 * this file touches, and typing them keeps the reporter's shape explicit.
 */
interface SummaryTest {
  name: string;
  status?: string;
  suiteName?: string;
  file?: string;
  error?: { message?: string };
  errors?: Array<{ message?: string }>;
}

interface VideoInfo {
  url: string;
  testName: string;
  suiteName?: string;
  category?: string;
}

function getVideosByCategory(): Map<string, VideoInfo[]> {
  const categoryMap = new Map<string, VideoInfo[]>();

  // Read from the JSON file that S3 reporter creates
  const videoFilePath = "test-results/video-urls.json";
  if (!existsSync(videoFilePath)) {
    console.log("📹 No video URLs file found yet");
    return categoryMap;
  }

  try {
    const videoData = JSON.parse(readFileSync(videoFilePath, "utf8"));
    const videos: VideoInfo[] = videoData.videos || [];

    for (const video of videos) {
      const category = video.category || "❓ Other Issues";
      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }
      categoryMap.get(category)!.push(video);
    }

    console.log(`📹 Loaded ${videos.length} videos from file for Slack`);
  } catch (error) {
    console.error("📹 Failed to read video URLs file:", error);
  }

  return categoryMap;
}

function getTestDisplayName(test: SummaryTest): string {
  // Create a cleaner test name
  const suiteName =
    test.suiteName ||
    test.file?.replace(/\.spec\.ts$/, "").replace(/Tests?/g, "");
  const testName = test.name;

  // Remove redundant words and clean up
  const cleanSuite = suiteName
    ?.replace(/Tests?$/i, "")
    ?.replace(/Page$/i, "")
    ?.replace(/Spec$/i, "")
    ?.replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase to spaces
    ?.trim();

  return `${cleanSuite}: ${testName}`;
}

function categorizeAndCleanError(test: SummaryTest): {
  category: string;
  cleanError: string;
  action: string;
} {
  const error =
    test.error?.message || test.errors?.[0]?.message || "Unknown error";

  // Debug logging to see what error data we're getting
  console.log(`🐛 DEBUG: Categorizing test "${test.name}"`);
  console.log(
    `🐛 DEBUG: Error object:`,
    JSON.stringify(
      {
        hasError: !!test.error,
        hasErrors: !!test.errors,
        errorMessage: test.error?.message,
        errorsLength: test.errors?.length,
        firstErrorMessage: test.errors?.[0]?.message,
      },
      null,
      2
    )
  );

  // AI Response Timeouts
  if (error.includes("None of the expected patterns matched")) {
    const patterns = error.match(/patterns matched[^:]*: ([^`]+)/);
    return {
      category: "🤖 AI Response Issues",
      cleanError: `No AI response - Expected: ${
        patterns?.[1] || "AI response"
      }`,
      action: "Check API keys and AI service status",
    };
  }

  // Test timeout (usually AI-related in our suite)
  if (
    error.includes("Test timeout") ||
    test.name?.toLowerCase().includes("human")
  ) {
    return {
      category: "🤖 AI Response Issues",
      cleanError: "Test timeout waiting for AI response",
      action: "Check AI service availability and response times",
    };
  }

  // UI Element Missing
  if (error.includes("Timed out") && error.includes("toBeVisible")) {
    const element = error.match(/locator\('([^']+)'\)/);
    return {
      category: "🎨 UI Issues",
      cleanError: `Element not found: ${element?.[1] || "UI element"}`,
      action: "Check if demo app is loading correctly",
    };
  }

  // Content Generation Failures
  if (error.includes("toBeGreaterThan") && error.includes("0")) {
    return {
      category: "🎯 Content Generation",
      cleanError: "Expected AI content not generated (count was 0)",
      action: "AI generative features not working",
    };
  }

  // Strict Mode Violations (multiple elements found)
  if (error.includes("strict mode violation")) {
    return {
      category: "🎯 Test Reliability",
      cleanError: "Multiple matching elements found",
      action: "Test selectors need to be more specific",
    };
  }

  // CSS/Style Issues
  if (error.includes("toHaveCSS")) {
    return {
      category: "🎨 Styling Issues",
      cleanError: "Expected CSS styles not applied",
      action: "Check if dynamic styling is working",
    };
  }

  // Default fallback
  return {
    category: "❓ Other Issues",
    cleanError: error.split("\n")[0]?.trim() || error,
    action: "Check logs for details",
  };
}

export function generateCustomLayout(
  summaryResults: SummaryResults
): Array<KnownBlock | Block> {
  const { passed, failed, skipped, tests } = summaryResults;

  const summary = {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        failed === 0
          ? `✅ All ${passed} tests passed!`
          : `✅ ${passed} passed • ❌ ${failed} failed • ⏭ ${skipped} skipped`,
    },
  };

  // Only show failures if there are any
  const failures: Array<KnownBlock | Block> = [];
  if (failed > 0) {
    const failedTests = tests.filter(
      (test) => test.status === "failed" || test.status === "timedOut"
    );

    // Categorize failures
    const categorizedFailures = new Map<
      string,
      Array<{ test: SummaryTest; cleanError: string; action: string }>
    >();

    failedTests.forEach((test) => {
      const { category, cleanError, action } = categorizeAndCleanError(test);
      if (!categorizedFailures.has(category)) {
        categorizedFailures.set(category, []);
      }
      categorizedFailures.get(category)!.push({ test, cleanError, action });
    });

    // Get video URLs by category
    const videosByCategory = getVideosByCategory();

    // Display failures by category
    for (const [category, categoryFailures] of categorizedFailures) {
      const failureLines = categoryFailures.map(
        ({ test, cleanError, action }) => {
          const testName = getTestDisplayName(test);

          // Look for videos for this test - search across ALL categories since
          // S3 reporter uses different categorization than Slack layout
          let testVideo: VideoInfo | undefined;
          for (const [_, videos] of videosByCategory) {
            testVideo = videos.find(
              (v) =>
                v.testName === test.name ||
                v.testName.includes(test.name) ||
                test.name.includes(v.testName)
            );
            if (testVideo) break;
          }

          const videoLink = testVideo
            ? `\n  📹 [Watch Video](${testVideo.url})`
            : "";

          return `• **${testName}**\n  → ${cleanError}${videoLink}`;
        }
      );

      const uniqueActions = [...new Set(categoryFailures.map((f) => f.action))];
      const actionText =
        uniqueActions.length === 1
          ? `\n🔧 *Action:* ${uniqueActions[0]}`
          : `\n🔧 *Actions:* ${uniqueActions.join(", ")}`;

      failures.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${category}* (${categoryFailures.length} failure${
            categoryFailures.length > 1 ? "s" : ""
          })\n${failureLines.join("\n\n")}${actionText}`,
        },
      });
    }

    // Add overall action summary if there are AI issues
    const hasAIIssues =
      categorizedFailures.has("🤖 AI Response Issues") ||
      categorizedFailures.has("🎯 Content Generation");

    if (hasAIIssues) {
      failures.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "💡 *Most failures are AI-related.* Check API keys, service status, and rate limits.",
          },
        ],
      });
    }
  }

  return [summary, ...failures];
}

export default generateCustomLayout;
