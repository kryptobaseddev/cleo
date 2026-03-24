import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  ensureOkResponse,
  fetchWithTimeout,
  formatNetworkError,
  NetworkError,
} from "../../src/core/network/fetch.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DEFAULT_FETCH_TIMEOUT_MS", () => {
  it("equals 10 000 ms", () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(10_000);
  });
});

describe("NetworkError", () => {
  it("sets kind, url, status, and name", () => {
    const err = new NetworkError("boom", "http", "https://example.com", 404);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.name).toBe("NetworkError");
    expect(err.message).toBe("boom");
    expect(err.kind).toBe("http");
    expect(err.url).toBe("https://example.com");
    expect(err.status).toBe(404);
  });

  it("leaves status undefined when omitted", () => {
    const err = new NetworkError("timeout", "timeout", "https://api.test");

    expect(err.status).toBeUndefined();
    expect(err.kind).toBe("timeout");
    expect(err.url).toBe("https://api.test");
  });

  it("accepts network kind", () => {
    const err = new NetworkError("fail", "network", "https://down.test");

    expect(err.kind).toBe("network");
    expect(err.url).toBe("https://down.test");
    expect(err.status).toBeUndefined();
  });
});

describe("ensureOkResponse", () => {
  it("returns the response when ok is true", () => {
    const response = { ok: true, status: 200 } as Response;
    const result = ensureOkResponse(response, "https://example.com");

    expect(result).toBe(response);
  });

  it("throws NetworkError with http kind when ok is false", () => {
    const response = { ok: false, status: 502 } as Response;

    expect(() => ensureOkResponse(response, "https://api.test/data")).toThrow(NetworkError);

    try {
      ensureOkResponse(response, "https://api.test/data");
    } catch (error) {
      const ne = error as NetworkError;
      expect(ne.kind).toBe("http");
      expect(ne.url).toBe("https://api.test/data");
      expect(ne.status).toBe(502);
      expect(ne.message).toBe("Request failed with status 502");
    }
  });

  it("includes the status code in the error message", () => {
    const response = { ok: false, status: 404 } as Response;

    expect(() => ensureOkResponse(response, "https://x.test")).toThrowError(
      "Request failed with status 404",
    );
  });
});

describe("formatNetworkError", () => {
  it("formats timeout NetworkError", () => {
    const err = new NetworkError("timed out", "timeout", "https://slow.test");
    const msg = formatNetworkError(err);

    expect(msg).toBe("Network request timed out. Please check your connection and try again.");
  });

  it("formats http NetworkError with status", () => {
    const err = new NetworkError("bad", "http", "https://api.test", 503);
    const msg = formatNetworkError(err);

    expect(msg).toBe("Marketplace request failed with HTTP 503. Please try again shortly.");
  });

  it("formats http NetworkError without status", () => {
    const err = new NetworkError("bad", "http", "https://api.test");
    const msg = formatNetworkError(err);

    expect(msg).toBe("Marketplace request failed with HTTP unknown. Please try again shortly.");
  });

  it("formats network NetworkError", () => {
    const err = new NetworkError("fail", "network", "https://down.test");
    const msg = formatNetworkError(err);

    expect(msg).toBe("Network request failed. Please check your connection and try again.");
  });

  it("formats regular Error using its message", () => {
    const err = new Error("something broke");
    const msg = formatNetworkError(err);

    expect(msg).toBe("something broke");
  });

  it("formats non-Error value using String()", () => {
    expect(formatNetworkError("plain string")).toBe("plain string");
    expect(formatNetworkError(42)).toBe("42");
    expect(formatNetworkError(null)).toBe("null");
    expect(formatNetworkError(undefined)).toBe("undefined");
  });
});

describe("fetchWithTimeout", () => {
  it("returns the response on success", async () => {
    const fakeResponse = { ok: true, status: 200 } as Response;
    const mockFetch = vi.fn().mockResolvedValue(fakeResponse);
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchWithTimeout("https://api.test/data");

    expect(result).toBe(fakeResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/data");
    expect(init.signal).toBeDefined();
  });

  it("merges caller-supplied init with the timeout signal", async () => {
    const fakeResponse = { ok: true, status: 200 } as Response;
    const mockFetch = vi.fn().mockResolvedValue(fakeResponse);
    vi.stubGlobal("fetch", mockFetch);

    const headers = { Authorization: "Bearer tok" };
    await fetchWithTimeout("https://api.test", { headers, method: "POST" });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(headers);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeDefined();
  });

  it("throws timeout NetworkError on AbortError", async () => {
    const abortError = new DOMException("signal timed out", "AbortError");
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal("fetch", mockFetch);

    try {
      await fetchWithTimeout("https://slow.test/api", undefined, 5000);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError);
      const ne = error as NetworkError;
      expect(ne.kind).toBe("timeout");
      expect(ne.url).toBe("https://slow.test/api");
      expect(ne.message).toBe("Request timed out after 5000ms");
    }
  });

  it("throws network NetworkError on non-abort errors", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", mockFetch);

    try {
      await fetchWithTimeout("https://down.test");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkError);
      const ne = error as NetworkError;
      expect(ne.kind).toBe("network");
      expect(ne.url).toBe("https://down.test");
      expect(ne.message).toBe("Network request failed");
    }
  });

  it("uses DEFAULT_FETCH_TIMEOUT_MS when no timeout is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal("fetch", mockFetch);

    // We can't directly inspect the AbortSignal timeout value, but we verify
    // the signal is present (set via AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS))
    await fetchWithTimeout("https://api.test");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses custom timeout value in error message", async () => {
    const abortError = new DOMException("signal timed out", "AbortError");
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal("fetch", mockFetch);

    await expect(fetchWithTimeout("https://x.test", undefined, 3000)).rejects.toThrow(
      "Request timed out after 3000ms",
    );
  });
});
