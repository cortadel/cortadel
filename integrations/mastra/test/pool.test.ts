import { CortadelClient } from "@cortadel/sdk";
import { describe, expect, it } from "vitest";

import { CortadelClientPool, DEFAULT_APP_NAME, MAX_CACHED_CLIENTS } from "../src/index.js";
import type { CortadelClientLike } from "../src/index.js";
import { fakeClientFactory } from "./fake-client.js";

describe("CortadelClientPool", () => {
  it("creates exactly one client per user id and reuses it", () => {
    const factory = fakeClientFactory();
    const pool = new CortadelClientPool({ createClient: factory.createClient });

    const first = pool.get("e2e-mastra-alice");
    const second = pool.get("e2e-mastra-alice");

    expect(first).toBe(second);
    expect(factory.requested).toEqual(["e2e-mastra-alice"]);
    expect(pool.size).toBe(1);
  });

  it("keeps users apart — a Cortadel client is bound to one user id", () => {
    const factory = fakeClientFactory();
    const pool = new CortadelClientPool({ createClient: factory.createClient });

    const alice = pool.get("e2e-mastra-alice");
    const bob = pool.get("e2e-mastra-bob");

    expect(alice).not.toBe(bob);
    expect(pool.size).toBe(2);
  });

  it("bounds the cache so a multi-tenant server cannot leak clients", () => {
    const pool = new CortadelClientPool({ createClient: (userId) => ({ userId }) as unknown as CortadelClientLike });
    for (let i = 0; i < MAX_CACHED_CLIENTS + 20; i += 1) pool.get(`e2e-mastra-${i}`);
    expect(pool.size).toBe(MAX_CACHED_CLIENTS);
  });

  it("defaults the app name and lets it be overridden", () => {
    expect(new CortadelClientPool().appName).toBe(DEFAULT_APP_NAME);
    expect(new CortadelClientPool({ appName: "custom" }).appName).toBe("custom");
  });

  it("builds a real CortadelClient when no factory is supplied (no network involved)", () => {
    const pool = new CortadelClientPool({ baseUrl: "http://localhost:3001" });
    const client = pool.get("e2e-mastra-alice");
    expect(client).toBeInstanceOf(CortadelClient);
  });

  it("surfaces the SDK's own validation for a bad base URL", () => {
    const pool = new CortadelClientPool({ baseUrl: "not-a-url" });
    expect(() => pool.get("e2e-mastra-alice")).toThrow(/absolute URL/);
  });
});
