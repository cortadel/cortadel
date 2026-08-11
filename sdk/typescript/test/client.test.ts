// Facade tests. Every network boundary is a stub `fetch` — nothing here hits a real network.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CortadelClient } from "../src/client.js";
import { CortadelError } from "../src/models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const BASE_URL = "http://localhost:3001";
const USER_ID = "e2e-client-test-user";

type FetchCall = { url: string; init: RequestInit };

/** A stub `fetch` that records every call and returns pre-programmed responses in order. */
function stubFetch(responses: Array<Response | ((call: FetchCall) => Response | Promise<Response>)>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return typeof next === "function" ? await next(call) : next;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Decodes the body Kiota's serializer set on a request (an ArrayBuffer of UTF-8 JSON text). */
function decodeBody(init: RequestInit): Record<string, unknown> {
  const raw = init.body;
  if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw));
  if (typeof raw === "string") return JSON.parse(raw);
  throw new Error(`unexpected body type: ${Object.prototype.toString.call(raw)}`);
}

describe("constructor validation", () => {
  it("rejects a blank baseUrl", () => {
    expect(() => new CortadelClient({ baseUrl: "", userId: USER_ID })).toThrow(/baseUrl/i);
    expect(() => new CortadelClient({ baseUrl: "   ", userId: USER_ID })).toThrow(/baseUrl/i);
  });

  it("rejects a malformed baseUrl", () => {
    expect(() => new CortadelClient({ baseUrl: "not a url", userId: USER_ID })).toThrow(/baseUrl/i);
  });

  it("rejects a non-http(s) baseUrl", () => {
    expect(() => new CortadelClient({ baseUrl: "ftp://example.com", userId: USER_ID })).toThrow(/http/i);
  });

  it("accepts a plain http:// baseUrl (self-hosted, non-TLS deployments)", () => {
    expect(() => new CortadelClient({ baseUrl: "http://box:3001", userId: USER_ID })).not.toThrow();
  });

  it("rejects a blank userId", () => {
    expect(() => new CortadelClient({ baseUrl: BASE_URL, userId: "" })).toThrow(/userId/i);
    expect(() => new CortadelClient({ baseUrl: BASE_URL, userId: "   " })).toThrow(/userId/i);
  });
});

describe("authentication", () => {
  it("sends Authorization: Bearer <key> when an api key is configured", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ status: "ok" })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, apiKey: "secret-key", fetch });

    await client.health();

    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer secret-key");
  });

  it("sends no Authorization header when no api key is configured", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ status: "ok" })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    await client.health();

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("authorization");
  });

  it("never mutates a caller-supplied fetch: the same fetch used by two clients carries no cross-client auth", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ status: "ok" }), jsonResponse({ status: "ok" })]);
    const withKey = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, apiKey: "only-for-this-client", fetch });
    const withoutKey = new CortadelClient({ baseUrl: BASE_URL, userId: "e2e-other-user", fetch });

    await withKey.health();
    await withoutKey.health();

    expect((calls[0].init.headers as Record<string, string>)["authorization"]).toBe("Bearer only-for-this-client");
    expect(calls[1].init.headers as Record<string, string>).not.toHaveProperty("authorization");
  });
});

describe("request bodies", () => {
  it("go out snake_case: user_id present, userId absent", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ id: "m1", content: "hello", state: "active" })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    await client.add("hello", { app: "test-app" });

    const body = decodeBody(calls[0].init);
    expect(body).toHaveProperty("user_id", USER_ID);
    expect(body).not.toHaveProperty("userId");
    expect(body).toHaveProperty("app", "test-app");
  });

  it("addConversation bodies also carry user_id, not userId", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ results: [] })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    await client.addConversation([{ role: "user", content: "hi" }]);

    const body = decodeBody(calls[0].init);
    expect(body).toHaveProperty("user_id", USER_ID);
    expect(body).not.toHaveProperty("userId");
  });
});

describe("get()", () => {
  it("resolves null on a 404 with a JSON ErrorResponse body", async () => {
    const { fetch } = stubFetch([jsonResponse({ code: "not_found", message: "no such memory", status: 404 }, 404)]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    await expect(client.get("missing-id")).resolves.toBeNull();
  });

  it("resolves null on a 404 with an empty body and no Content-Type (proxy / unmatched-route 404)", async () => {
    const { fetch } = stubFetch([new Response(null, { status: 404 })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    await expect(client.get("missing-id")).resolves.toBeNull();
  });

  it("maps a found memory", async () => {
    const { fetch } = stubFetch([jsonResponse({ id: "m1", text: "hello", created_at: 1735689600, is_global: false })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    const detail = await client.get("m1");
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("m1");
    expect(detail?.text).toBe("hello");
  });
});

describe("error translation", () => {
  it("rejects with a CortadelError carrying the status and the contract's code on a non-success response", async () => {
    const { fetch } = stubFetch([jsonResponse({ code: "internal_error", message: "boom", status: 500 }, 500)]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    const err = await client.search("q").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CortadelError);
    expect((err as CortadelError).status).toBe(500);
    expect((err as CortadelError).code).toBe("internal_error");
    expect((err as CortadelError).message).toBe("boom");
  });

  it("surfaces ValidationProblemDetails field errors in the message instead of an opaque string", async () => {
    const { fetch } = stubFetch([
      jsonResponse(
        {
          title: "One or more validation errors occurred.",
          status: 400,
          errors: { text: ["Text is required."], memoryType: ["Invalid memory type."] },
        },
        400,
      ),
    ]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    const err = await client.add("").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CortadelError);
    expect((err as CortadelError).status).toBe(400);
    expect((err as CortadelError).code).toBe("validation_error");
    expect((err as CortadelError).message).toContain("Text is required.");
    expect((err as CortadelError).message).toContain("Invalid memory type.");
  });

  it("throws a CortadelError for an unmapped status with no error body", async () => {
    const { fetch } = stubFetch([new Response(null, { status: 502 })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    const err = await client.search("q").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CortadelError);
    expect((err as CortadelError).status).toBe(502);
  });
});

describe("cancellation", () => {
  it("propagates an AbortError instead of becoming a CortadelError", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch } = stubFetch([
      (call) => {
        if (call.init.signal?.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
        return Promise.resolve(jsonResponse({ query: "q", results: [], total: 0 }));
      },
    ]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    const err = await client.search("q", undefined, controller.signal).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CortadelError);
    expect((err as { name?: string }).name).toBe("AbortError");
  });
});

describe("health()", () => {
  it("maps a degraded 503 the same way as a normal 200 (contract quirk: both share the HealthResponse schema)", async () => {
    const { fetch } = stubFetch([
      jsonResponse({ status: "degraded", checks: { memgraph: { ok: false, error: "connection refused" } } }, 503),
    ]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    const health = await client.health();
    expect(health.status).toBe("degraded");
  });
});

describe("list()", () => {
  it("defaults size to 20 (deliberate divergence from the contract's own default of 10)", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ items: [], total: 0, page: 1, size: 20, pages: 0 })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    await client.list();

    expect(calls[0].url).toContain("size=20");
  });

  it("stringifies includeSuperseded to the wire's string-typed query param", async () => {
    const { fetch, calls } = stubFetch([jsonResponse({ items: [], total: 0, page: 1, size: 20, pages: 0 })]);
    const client = new CortadelClient({ baseUrl: BASE_URL, userId: USER_ID, fetch });

    await client.list({ includeSuperseded: true });

    expect(calls[0].url).toContain("include_superseded=true");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encapsulation boundary (src/index.ts)", () => {
  it("emits no reference to src/generated in the real declaration output of index.ts, client.ts, or models.ts", () => {
    // A check that only stringifies each method's *declared* return type would pass while broken:
    // every method returns `Promise<...>`, and the literal text "Promise<MemoryDetail>" never
    // mentions "generated" even if `MemoryDetail` itself were an alias for a generated type. This
    // instead runs the real compiler and inspects its fully-resolved declaration output, which
    // must reference (via import, however deeply nested the type is) every type any public export
    // structurally depends on -- there is no way for a transitive generated-type dependency to
    // avoid showing up here.
    const tscBin = path.join(ROOT, "node_modules/typescript/bin/tsc");
    execFileSync(process.execPath, [tscBin, "-p", ROOT], { cwd: ROOT, stdio: "pipe" });

    const leakPattern = /from\s+["'][^"']*\/generated\//;
    const offenders: string[] = [];
    for (const file of ["index.d.ts", "client.d.ts", "models.d.ts"]) {
      const text = readFileSync(path.join(ROOT, "dist", file), "utf8");
      if (leakPattern.test(text)) offenders.push(file);
    }
    expect(offenders, `generated-tree import found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("exports only the facade and its own types at runtime — no generated values", async () => {
    const mod = (await import(pathToFileURL(path.join(ROOT, "dist/index.js")).href)) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(["CortadelClient", "CortadelError", "DEFAULT_LIST_SIZE"]);
  });
});
