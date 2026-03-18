/**
 * Shared helpers for mocking the SWA deploy path in tests.
 *
 * The new deploy flow calls:
 *   deploySwaDir -> getDeploymentToken (fetch /listSecrets) -> deploySwaContent (binary via execFile)
 *
 * These helpers mock all parts:
 *   1. mockFetch matcher for /listSecrets (returns a fake deployment token)
 *   2. mockFetch matcher for SWA binary download (metadata + binary)
 *   3. mock.method on child_process.execFile (returns success output)
 */

import { mock } from "node:test";
import childProcess from "node:child_process";
import type { RequestMatcher } from "./mock-fetch.js";

/**
 * Returns a mockFetch matcher that handles the /listSecrets POST call
 * used by getDeploymentToken().
 */
export function listSecretsMatcher(): RequestMatcher {
  return (url: string, init?: RequestInit) => {
    if (url.includes("/listSecrets") && init?.method === "POST") {
      return {
        status: 200,
        body: { properties: { apiKey: "test-deploy-key" } },
      };
    }
    return undefined;
  };
}

/**
 * Returns a mockFetch matcher that handles the SWA binary download.
 * Covers both the metadata URL (aka.ms/swalocaldeploy) and the actual
 * binary download URL. Since execFile is already mocked, the binary
 * never actually runs — we just need the download to not crash.
 */
export function swaBinaryMatcher(): RequestMatcher {
  return (url: string) => {
    // Metadata endpoint (returns fake stable version info)
    if (url.includes("aka.ms/swalocaldeploy") || url.includes("swalocaldeploy")) {
      return {
        status: 200,
        body: [
          {
            version: "stable",
            buildId: "test-build",
            files: {
              "linux-x64": { url: "https://fake.test/StaticSitesClient", sha: "abc123" },
              "osx-x64": { url: "https://fake.test/StaticSitesClient", sha: "abc123" },
              "win-x64": { url: "https://fake.test/StaticSitesClient.exe", sha: "abc123" },
            },
          },
        ],
      };
    }
    // Actual binary download
    if (url.includes("fake.test/StaticSitesClient")) {
      return {
        status: 200,
        body: "FAKE_BINARY",
        headers: { "content-type": "application/octet-stream" },
      };
    }
    return undefined;
  };
}

/**
 * Mocks child_process.execFile to simulate successful SWA binary execution.
 * Must be called in beforeEach and paired with mock.restoreAll() in afterEach.
 */
export function mockExecFile(): void {
  mock.method(
    childProcess,
    "execFile",
    function mockedExecFile(
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: Function,
    ) {
      // Handle overloaded signatures: execFile(cmd, args, cb) or execFile(cmd, args, opts, cb)
      if (typeof _opts === "function") {
        cb = _opts;
      }
      if (typeof cb === "function") {
        cb(null, "Deployment Complete :)\nStatus: Succeeded\n", "");
      }
    } as any,
  );
}

/**
 * Restores the original child_process.execFile.
 * Call in afterEach alongside mock.restoreAll().
 */
export function restoreExecFile(): void {
  mock.restoreAll();
}
