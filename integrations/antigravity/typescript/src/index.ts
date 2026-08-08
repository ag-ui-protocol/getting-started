import { HttpAgent } from "@ag-ui/client";
import { AgentCapabilities, AgentCapabilitiesSchema } from "@ag-ui/core";

/**
 * Thin client for an Antigravity-backed AG-UI endpoint.
 *
 * The Python side owns the whole translation, so this is an `HttpAgent` plus
 * capability discovery against `<url>/capabilities`.
 */
export class AntigravityAgent extends HttpAgent {
  /**
   * Builds the URL for the capabilities endpoint.
   * Override this to customize the capabilities URL construction.
   *
   * `this.url` may be relative (a common browser setup — `run()` lets fetch
   * resolve it against the page origin), so resolve against `location` when
   * there is one rather than letting `new URL` throw a bare `TypeError`.
   */
  protected capabilitiesUrl(): string {
    const base =
      typeof globalThis !== "undefined"
        ? (globalThis as { location?: { href?: string } }).location?.href
        : undefined;
    let parsed: URL;
    try {
      parsed = new URL(this.url, base);
    } catch {
      throw new Error(
        `Cannot derive a capabilities URL from ${JSON.stringify(this.url)}: it is not ` +
          `absolute and there is no document origin to resolve it against.`,
      );
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/capabilities";
    return parsed.toString();
  }

  /**
   * Returns the fetch config for capabilities requests.
   * Override this to customize auth, headers, or credentials.
   */
  protected capabilitiesRequestInit(): RequestInit {
    return {
      method: "GET",
      headers: {
        ...this.headers,
        Accept: "application/json",
      },
    };
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    const url = this.capabilitiesUrl();
    // `this.fetch` — not the global — so an injected fetch (auth, proxy, retry,
    // a Node polyfill) applies to capability discovery as well as to run().
    const response = await this.fetch(url, this.capabilitiesRequestInit());

    if (!response.ok) {
      let body: string;
      try {
        body = await response.text();
      } catch {
        body = response.statusText || "(unable to read response body)";
      }
      throw new Error(`Failed to fetch capabilities from ${url}: HTTP ${response.status}: ${body}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (e) {
      throw new Error(
        `Failed to parse capabilities response from ${url}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const result = AgentCapabilitiesSchema.safeParse(data);
    if (!result.success) {
      throw new Error(`Invalid capabilities response from ${url}: ${result.error.message}`);
    }
    return result.data;
  }
}
