import { startLLMock, stopLLMock, llmockBaseUrl } from "./llmock";
import { startDotnetServer, stopDotnetServer } from "./dotnet-server";
import { resolveRecordConfig } from "./record-config";

// Vitest globalSetup contract: setup runs once before any test file; the
// returned function runs once after all files. Both LLMock and the C# server
// stay alive across the entire test run; tests share the same processes.
export default async function setup(): Promise<() => Promise<void>> {
  const record = resolveRecordConfig();

  if (record) {
    // Record mode: AIMock proxies unmatched LLM calls to the real upstream and
    // captures them. The C# server presents `apiKey` (an AAD token for Azure),
    // which AIMock forwards upstream; `modelId` becomes the Azure deployment.
    console.error(
      `[record] proxying unmatched LLM calls to ${record.upstream} (model ${record.modelId})`,
    );
    await startLLMock({ record: { upstream: record.upstream } });
    await startDotnetServer({
      openAiBaseUrl: llmockBaseUrl(),
      apiKey: record.apiKey,
      modelId: record.modelId,
    });
  } else {
    await startLLMock();
    await startDotnetServer({ openAiBaseUrl: llmockBaseUrl() });
  }

  return async () => {
    await stopDotnetServer();
    await stopLLMock();
  };
}
