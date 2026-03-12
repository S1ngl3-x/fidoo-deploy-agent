/**
 * Shared fetch mock for tests. Intercepts global fetch and returns
 * canned responses based on URL/body matching.
 */

export interface MockResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type RequestMatcher = (url: string, init?: RequestInit) => MockResponse | undefined;

let matchers: RequestMatcher[] = [];
let originalFetch: typeof globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];

export function mockFetch(matcher: RequestMatcher): void {
  matchers.unshift(matcher);
}

export function mockFetchOnce(response: MockResponse, urlMatch?: string): void {
  let used = false;
  matchers.push((url) => {
    if (used) return undefined;
    if (urlMatch && !url.includes(urlMatch)) return undefined;
    used = true;
    return response;
  });
}

export function getFetchCalls(): Array<{ url: string; init?: RequestInit }> {
  return [...calls];
}

export function installMockFetch(): void {
  originalFetch = globalThis.fetch;
  calls = [];
  matchers = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    for (const matcher of matchers) {
      const result = matcher(url, init);
      if (result) {
        // Status 204 (No Content) must not have a body
        if (result.status === 204) {
          return new Response(null, { status: 204 });
        }
        const headers = { "content-type": "application/json", ...result.headers };
        const contentType = headers["content-type"];
        const body =
          typeof result.body === "string" && !contentType.includes("application/json")
            ? result.body
            : JSON.stringify(result.body);
        return new Response(body, { status: result.status, headers });
      }
    }
    throw new Error(`mock-fetch: no matcher for ${url}`);
  }) as typeof globalThis.fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
  matchers = [];
  calls = [];
}
