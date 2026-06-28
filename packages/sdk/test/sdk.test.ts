import { describe, it, expect } from "vitest";
import { CountersignClient, CountersignApiError } from "../src/index";

// Build a fake fetch that records the request and returns a scripted response.
function fakeFetch(status: number, jsonBody: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
      text: async () => (typeof jsonBody === "string" ? jsonBody : JSON.stringify(jsonBody)),
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("CountersignClient — request semantics", () => {
  it("returns parsed JSON on 2xx", async () => {
    const { fn } = fakeFetch(200, { ok: true, providers: [] });
    const c = new CountersignClient({ baseUrl: "http://core", fetch: fn });
    expect(await c.health()).toEqual({ ok: true, providers: [] });
  });

  it("throws CountersignApiError carrying status + body on a non-2xx (no silent success)", async () => {
    const { fn } = fakeFetch(401, "unauthorized");
    const c = new CountersignClient({ baseUrl: "http://core", fetch: fn });
    await expect(c.agents()).rejects.toBeInstanceOf(CountersignApiError);
    try {
      await c.agents();
    } catch (e) {
      expect((e as CountersignApiError).status).toBe(401);
      expect((e as CountersignApiError).body).toBe("unauthorized");
    }
  });

  it("throws on 500 too (every non-2xx is an error, never a swallowed success)", async () => {
    const { fn } = fakeFetch(500, "boom");
    const c = new CountersignClient({ baseUrl: "http://core", fetch: fn });
    await expect(c.evaluate({ agentId: "a", amount: "1", asset: "USDC", venue: "base-sepolia" })).rejects.toBeInstanceOf(CountersignApiError);
  });
});

describe("CountersignClient — auth header + body framing", () => {
  it("sends Authorization: Bearer ONLY when an apiKey is configured", async () => {
    const withKey = fakeFetch(200, { ok: true });
    await new CountersignClient({ baseUrl: "http://core", apiKey: "csk_abc", fetch: withKey.fn }).health();
    expect((withKey.calls[0]!.init!.headers as Record<string, string>)["authorization"]).toBe("Bearer csk_abc");

    const noKey = fakeFetch(200, { ok: true });
    await new CountersignClient({ baseUrl: "http://core", fetch: noKey.fn }).health();
    expect(noKey.calls[0]!.init?.headers).toBeUndefined(); // no headers at all on an unauthenticated GET
  });

  it("sends a JSON body + content-type on POST, and none on GET", async () => {
    const post = fakeFetch(200, { ok: true });
    await new CountersignClient({ baseUrl: "http://core", fetch: post.fn }).freeze({ reason: "kill" });
    expect(post.calls[0]!.init!.method).toBe("POST");
    expect((post.calls[0]!.init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(post.calls[0]!.init!.body).toBe(JSON.stringify({ reason: "kill" }));

    const get = fakeFetch(200, { records: [], verified: true });
    await new CountersignClient({ baseUrl: "http://core", fetch: get.fn }).ledger();
    expect(get.calls[0]!.init!.method).toBe("GET");
    expect(get.calls[0]!.init?.body).toBeUndefined();
  });

  it("strips a trailing slash from baseUrl so paths aren't doubled", async () => {
    const { fn, calls } = fakeFetch(200, { ok: true, providers: [] });
    await new CountersignClient({ baseUrl: "http://core/", fetch: fn }).health();
    expect(calls[0]!.url).toBe("http://core/health");
  });
});
