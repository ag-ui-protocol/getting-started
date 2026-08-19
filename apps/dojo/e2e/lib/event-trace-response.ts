type ResponseMetadata = {
  method: string;
  url: string;
  contentType: string | undefined;
};

export function isEventTraceResponse(response: ResponseMetadata) {
  if (response.method !== "POST") return false;
  if (!response.contentType?.toLowerCase().includes("text/event-stream")) {
    return false;
  }

  const path = new URL(response.url).pathname;
  return /^\/api\/copilotkit(?:\/|$)/.test(path);
}
