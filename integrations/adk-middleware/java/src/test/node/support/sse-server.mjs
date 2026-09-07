import { readFile } from "node:fs/promises";
import http from "node:http";

export async function readJsonLines(url) {
  const content = await readFile(url, "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export async function startSseServer(responses) {
  const responseQueue = responses.map((events) => [...events]);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      headers: request.headers,
      method: request.method,
      url: request.url,
      body: body.length === 0 ? undefined : JSON.parse(body),
    });

    const events = responseQueue.shift();
    if (events === undefined) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("No SSE response configured");
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    for (const event of events) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/run`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}
