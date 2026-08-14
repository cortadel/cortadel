import type { AddOptions, ListOptions, SearchOptions } from "@cortadel/sdk";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CortadelStore, namespaceUserId } from "../src/index.js";
import {
  FakeBackend,
  NAMESPACE,
  OTHER_USER,
  RecordingLogger,
  USER,
  detail,
  hit,
  listItem,
  serverError,
} from "./fake-cortadel.js";

let backend: FakeBackend;

function newStore(overrides: Partial<ConstructorParameters<typeof CortadelStore>[0]> = {}) {
  return new CortadelStore({
    baseUrl: "http://localhost:3001",
    userId: USER,
    throwOnError: true,
    clientFactory: backend.factory,
    ...overrides,
  });
}

beforeEach(() => {
  backend = new FakeBackend();
});

describe("the BaseStore contract", () => {
  it("is a BaseStore with no abstract methods left", () => {
    const store = newStore();
    expect(store).toBeInstanceOf(BaseStore);
    for (const method of ["batch", "get", "search", "put", "delete", "listNamespaces"] as const) {
      expect(typeof store[method]).toBe("function");
    }
  });

  it("rejects an operation it cannot recognise", async () => {
    const store = newStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(store.batch([{ nonsense: true } as any])).rejects.toThrow(
      /Unknown operation type/,
    );
  });

  it("returns one result per operation, in order", async () => {
    backend.detail = detail("cortadel-9", "a stored fact");
    const store = newStore();
    const results = await store.batch([
      { namespace: NAMESPACE, key: "cortadel-9" },
      { namespacePrefix: NAMESPACE, limit: 10, offset: 0 },
    ]);
    expect(results).toHaveLength(2);
    expect((results[0] as { key: string }).key).toBe("cortadel-9");
    expect(Array.isArray(results[1])).toBe(true);
  });
});

describe("put", () => {
  it("stores the content key as the memory text", async () => {
    const store = newStore();
    await store.put(NAMESPACE, "k1", { content: "Ships on Fridays." });
    const [text, options] = backend.first("add") as [string, AddOptions];
    expect(text).toBe("Ships on Fridays.");
    expect(options.app).toBe("@cortadel/langgraph");
    expect(options.metadata).toMatchObject({
      langgraph_namespace: "memories/e2e-langgraph-integration",
      langgraph_key: "k1",
    });
  });

  it("accepts any of the default text keys and keeps the rest as metadata", async () => {
    const store = newStore();
    await store.put(NAMESPACE, "k1", { memory: "A fact.", topic: "release" });
    const [text, options] = backend.first("add") as [string, AddOptions];
    expect(text).toBe("A fact.");
    expect(options.metadata).toMatchObject({ topic: "release" });
  });

  it("falls back to deterministic JSON when no text key matches", async () => {
    const store = newStore();
    await store.put(NAMESPACE, "k1", { b: 2, a: 1 });
    const [text] = backend.first("add") as [string];
    expect(text).toBe('{"a":1,"b":2}');
  });

  it("maps index: false onto Cortadel's infer: false", async () => {
    const store = newStore();
    await store.put(NAMESPACE, "k1", { content: "verbatim" }, false);
    const [, options] = backend.first("add") as [string, AddOptions];
    expect(options.infer).toBe(false);
  });

  it("infers by default", async () => {
    const store = newStore();
    await store.put(NAMESPACE, "k1", { content: "x" });
    const [, options] = backend.first("add") as [string, AddOptions];
    expect(options.infer).toBe(true);
  });
});

describe("delete", () => {
  it("goes through a PutOperation with a null value", async () => {
    const store = newStore();
    await store.delete(NAMESPACE, "cortadel-7");
    expect(backend.first("delete")).toEqual([["cortadel-7"]]);
  });
});

describe("caller keys and Cortadel ids", () => {
  it("bridges a caller key to the minted Cortadel id", async () => {
    backend.detail = detail("cortadel-1", "a stored fact");
    const store = newStore();
    await store.put(NAMESPACE, "my-key", { content: "a stored fact" });
    const item = await store.get(NAMESPACE, "my-key");
    expect(backend.first("get")).toEqual(["cortadel-1"]);
    // The BaseStore contract says the item comes back under the key the caller asked for; the
    // durable Cortadel id is always available on the value.
    expect(item?.key).toBe("my-key");
    expect(item?.value.id).toBe("cortadel-1");
  });

  it("targets the minted id when deleting through the alias", async () => {
    const store = newStore();
    await store.put(NAMESPACE, "my-key", { content: "x" });
    await store.delete(NAMESPACE, "my-key");
    expect(backend.first("delete")).toEqual([["cortadel-1"]]);
  });

  it("passes an unknown key straight through as a Cortadel id", async () => {
    backend.detail = detail("cortadel-42", "x");
    const store = newStore();
    await store.get(NAMESPACE, "cortadel-42");
    expect(backend.first("get")).toEqual(["cortadel-42"]);
  });

  it("bounds the alias table", async () => {
    const store = newStore({ maxAliasEntries: 2 });
    for (const key of ["a", "b", "c"]) await store.put(NAMESPACE, key, { content: key });
    backend.detail = detail("cortadel-1", "a");
    // "a" was evicted, so its key is now treated as a Cortadel id rather than an alias.
    await store.get(NAMESPACE, "a");
    expect(backend.first("get")).toEqual(["a"]);
  });
});

describe("get", () => {
  it("returns null for a missing memory", async () => {
    backend.detail = null;
    const store = newStore();
    expect(await store.get(NAMESPACE, "nope")).toBeNull();
  });

  it("maps Unix seconds to a Date", async () => {
    backend.detail = detail("cortadel-1", "x", { createdAt: 1_754_049_600 });
    const store = newStore();
    const item = await store.get(NAMESPACE, "cortadel-1");
    expect(item?.createdAt).toBeInstanceOf(Date);
    expect(item?.createdAt.toISOString()).toBe("2025-08-01T12:00:00.000Z");
  });
});

describe("search", () => {
  it("uses hybrid search when a query is given", async () => {
    backend.searchHits = [hit("m1", "first"), hit("m2", "second")];
    const store = newStore();
    const items = await store.search(NAMESPACE, { query: "deploy day", limit: 5 });
    const [query, options] = backend.first("search") as [string, SearchOptions];
    expect(query).toBe("deploy day");
    expect(options.topK).toBe(5);
    expect(options.mode).toBe("hybrid");
    expect(items.map((item) => item.key)).toEqual(["m1", "m2"]);
    expect(items[0]!.value.content).toBe("first");
    expect(items[0]!.score).toBe(0.5);
  });

  it("lists instead when there is no query", async () => {
    backend.listItems = [listItem("m1", "first")];
    const store = newStore();
    const items = await store.search(NAMESPACE, { limit: 3 });
    expect(backend.methods()).toContain("list");
    expect(backend.methods()).not.toContain("search");
    const [options] = backend.first("list") as [ListOptions];
    expect(options.size).toBe(3);
    // A plain list is unranked, so there is deliberately no score.
    expect(items[0]!.score).toBeUndefined();
  });

  it("honours offset by overfetching then slicing", async () => {
    backend.searchHits = [hit("m1", "a"), hit("m2", "b"), hit("m3", "c")];
    const store = newStore();
    const items = await store.search(NAMESPACE, { query: "q", limit: 2, offset: 1 });
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.topK).toBe(3);
    expect(items.map((item) => item.key)).toEqual(["m2", "m3"]);
  });

  it("clamps topK to the server ceiling and warns once", async () => {
    const logger = new RecordingLogger();
    const store = newStore({ logger });
    await store.search(NAMESPACE, { query: "q", limit: 100 });
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.topK).toBe(50);
    expect(logger.warnings.join("\n")).toMatch(/caps that at 50/);
  });

  it("passes searchMode and rerank through", async () => {
    const store = newStore({ searchMode: "vector", rerank: "cross_encoder" });
    await store.search(NAMESPACE, { query: "q" });
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.mode).toBe("vector");
    expect(options.rerank).toBe("cross_encoder");
  });

  it("pushes a server-side filter key into SearchOptions", async () => {
    const store = newStore();
    await store.search(NAMESPACE, { query: "q", filter: { memoryType: "semantic" } });
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.memoryType).toBe("semantic");
  });

  it("pushes sessionId into SearchOptions", async () => {
    const store = newStore();
    await store.search(NAMESPACE, { query: "q", filter: { sessionId: "thread-1" } });
    const [, options] = backend.first("search") as [string, SearchOptions];
    expect(options.sessionId).toBe("thread-1");
  });

  it("applies a client-side filter key to the results", async () => {
    backend.searchHits = [
      hit("m1", "a", { categories: ["work"] }),
      hit("m2", "b", { categories: ["travel"] }),
    ];
    const store = newStore();
    const items = await store.search(NAMESPACE, { query: "q", filter: { categories: "work" } });
    expect(items.map((item) => item.key)).toEqual(["m1"]);
  });

  it("supports the operator filters the JS SearchOperation documents", async () => {
    backend.searchHits = [
      hit("m1", "a", { memoryType: "semantic" }),
      hit("m2", "b", { memoryType: "episodic" }),
    ];
    const store = newStore();
    const items = await store.search(NAMESPACE, {
      query: "q",
      filter: { appName: { $ne: "other-app" } },
    });
    expect(items.map((item) => item.key)).toEqual(["m1", "m2"]);
  });

  it("warns once about an unusable filter key and does not drop rows", async () => {
    backend.searchHits = [hit("m1", "a")];
    const logger = new RecordingLogger();
    const store = newStore({ logger });
    const first = await store.search(NAMESPACE, { query: "q", filter: { nonsense: 1 } });
    const second = await store.search(NAMESPACE, { query: "q", filter: { nonsense: 1 } });
    expect(first.map((item) => item.key)).toEqual(["m1"]);
    expect(second).toHaveLength(1);
    expect(logger.warnings.filter((line) => line.includes("nonsense"))).toHaveLength(1);
  });
});

describe("listNamespaces", () => {
  it("reports namespaces this instance has touched", async () => {
    const store = newStore();
    await store.put(["memories", "e2e-a"], "k", { content: "x" });
    await store.put(["memories", "e2e-b"], "k", { content: "x" });
    expect(await store.listNamespaces({})).toEqual([
      ["memories", "e2e-a"],
      ["memories", "e2e-b"],
    ]);
  });

  it("supports prefix wildcards", async () => {
    const store = newStore();
    await store.put(["memories", "e2e-a"], "k", { content: "x" });
    await store.put(["scratch", "e2e-a"], "k", { content: "x" });
    expect(await store.listNamespaces({ prefix: ["memories", "*"] })).toEqual([
      ["memories", "e2e-a"],
    ]);
  });

  it("truncates to maxDepth without duplicating", async () => {
    const store = newStore();
    await store.put(["memories", "e2e-a"], "k", { content: "x" });
    await store.put(["memories", "e2e-b"], "k", { content: "x" });
    expect(await store.listNamespaces({ maxDepth: 1 })).toEqual([["memories"]]);
  });

  it("is empty before anything is touched", async () => {
    const store = newStore();
    expect(await store.listNamespaces({})).toEqual([]);
  });
});

describe("user-id resolution", () => {
  it("uses a fixed user id for every namespace", async () => {
    const store = newStore();
    await store.put(["memories", "someone-else"], "k", { content: "x" });
    expect(backend.users()).toEqual([USER]);
  });

  it("lets the namespace select the user, one client each", async () => {
    const store = newStore({ userId: namespaceUserId(-1) });
    await store.put(["memories", USER], "k", { content: "x" });
    await store.put(["memories", OTHER_USER], "k", { content: "x" });
    await store.put(["memories", USER], "k2", { content: "y" });
    expect(backend.users()).toEqual([USER, OTHER_USER, USER]);
    // Three writes, but only two clients: they are cached per resolved user id.
    expect(backend.constructed).toEqual([USER, OTHER_USER]);
  });

  it("degrades instead of throwing when the namespace yields no user", async () => {
    const logger = new RecordingLogger();
    const store = newStore({ userId: namespaceUserId(5), throwOnError: false, logger });
    expect(await store.search(["memories"], { query: "q" })).toEqual([]);
    expect(backend.calls).toHaveLength(0);
    expect(logger.warnings.join("\n")).toMatch(/has no label at index 5/);
  });

  it("propagates that failure when asked to", async () => {
    const store = newStore({ userId: namespaceUserId(5) });
    await expect(store.search(["memories"], { query: "q" })).rejects.toThrow(/no label at index 5/);
  });

  it("reports a blank user id from the resolver", async () => {
    const logger = new RecordingLogger();
    const store = newStore({ userId: () => "", throwOnError: false, logger });
    expect(await store.search(NAMESPACE, { query: "q" })).toEqual([]);
    expect(logger.warnings.join("\n")).toMatch(/No Cortadel user id could be derived/);
  });
});

describe("degradation", () => {
  it("turns a server failure into an empty result by default", async () => {
    backend.failures.set("search", serverError());
    const logger = new RecordingLogger();
    const store = newStore({ throwOnError: false, logger });
    expect(await store.search(NAMESPACE, { query: "q" })).toEqual([]);
    expect(logger.warnings.join("\n")).toMatch(/search failed \(status=503 code=transport_error\)/);
  });

  it("never throws from a write by default", async () => {
    backend.failures.set("add", serverError());
    const store = newStore({ throwOnError: false, logger: new RecordingLogger() });
    await expect(store.put(NAMESPACE, "k", { content: "x" })).resolves.toBeUndefined();
  });

  it("returns null from get on failure", async () => {
    backend.failures.set("get", serverError());
    const store = newStore({ throwOnError: false, logger: new RecordingLogger() });
    expect(await store.get(NAMESPACE, "k")).toBeNull();
  });

  it("hands the failure to an onError callback instead of the log", async () => {
    backend.failures.set("search", serverError());
    const observed: unknown[] = [];
    const logger = new RecordingLogger();
    const store = newStore({ throwOnError: false, logger, onError: (e) => observed.push(e) });
    await store.search(NAMESPACE, { query: "q" });
    expect(observed).toHaveLength(1);
    expect(logger.warnings).toEqual([]);
  });

  it("survives a callback that itself throws", async () => {
    backend.failures.set("search", serverError());
    const logger = new RecordingLogger();
    const store = newStore({
      throwOnError: false,
      logger,
      onError: () => {
        throw new Error("observer exploded");
      },
    });
    await expect(store.search(NAMESPACE, { query: "q" })).resolves.toEqual([]);
    expect(logger.warnings.join("\n")).toMatch(/onError callback threw/);
  });

  it("propagates the CortadelError when throwOnError is set", async () => {
    backend.failures.set("search", serverError());
    const store = newStore();
    await expect(store.search(NAMESPACE, { query: "q" })).rejects.toThrow("boom");
  });

  it("lets throwOnError win over the callback", async () => {
    backend.failures.set("search", serverError());
    const observed: unknown[] = [];
    const store = newStore({ onError: (e) => observed.push(e) });
    await expect(store.search(NAMESPACE, { query: "q" })).rejects.toThrow("boom");
    expect(observed).toEqual([]);
  });

  it("rejects the pre-release onError mode string loudly", () => {
    expect(() =>
      newStore({ onError: "warn" as unknown as (error: unknown) => void }),
    ).toThrow(TypeError);
  });

  it("refuses an empty textKeys list", () => {
    expect(() => newStore({ textKeys: [] })).toThrow(/at least one key/);
  });
});

describe("Cortadel-specific extensions", () => {
  it("passes conversation options through", async () => {
    const store = newStore();
    await store.addConversation(NAMESPACE, [{ role: "user", content: "hi" }], {
      sessionId: "thread-1",
      project: "cortadel",
      tags: ["chat"],
    });
    const [messages, options] = backend.first("addConversation") as [unknown[], unknown];
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
    expect(options).toMatchObject({
      sessionId: "thread-1",
      project: "cortadel",
      tags: ["chat"],
      isAgentMemory: false,
    });
  });

  it("skips an empty turn list", async () => {
    const store = newStore();
    expect(await store.addConversation(NAMESPACE, [])).toBeNull();
    expect(backend.calls).toHaveLength(0);
  });

  it("exposes health and does not throw for a degraded server", async () => {
    backend.healthResult = { status: "degraded" };
    const store = newStore();
    expect((await store.health(NAMESPACE))?.status).toBe("degraded");
  });

  it("returns null from health when the call itself fails", async () => {
    backend.failures.set("health", serverError());
    const store = newStore({ throwOnError: false, logger: new RecordingLogger() });
    expect(await store.health(NAMESPACE)).toBeNull();
  });
});

describe("the default client factory", () => {
  it("builds a real CortadelClient per user without touching the network", () => {
    const store = new CortadelStore({ baseUrl: "http://localhost:3001", userId: USER });
    // Constructing the store must not construct a client, let alone open a socket.
    expect(store).toBeInstanceOf(BaseStore);
  });

  it("validates the base URL the way the SDK does, at first use", async () => {
    const store = new CortadelStore({ baseUrl: "not-a-url", userId: USER, throwOnError: true });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(store.get(NAMESPACE, "k")).rejects.toThrow(/absolute URL/);
    spy.mockRestore();
  });
});
