// Tests the wire-shape mapping helpers in src/mapping.ts that src/client.ts relies on. Each case
// starts from a JSON literal written with the *contract's* snake_case field names (spec/openapi.json)
// and runs it through Kiota's own JsonParseNode + the real generated `create*FromDiscriminatorValue`
// factory — the same deserialization path a live server response goes through — before handing the
// result to our mapper. That exercises both stages a wire-name typo could hide in: Kiota's own
// snake_case -> camelCase field binding, and our mapper reading the right camelCase property.
import { JsonParseNode } from "@microsoft/kiota-serialization-json";
import { describe, expect, it } from "vitest";

import {
  createHealthResponseFromDiscriminatorValue,
  createHybridSearchResultFromDiscriminatorValue,
  createMemoryCreatedResponseFromDiscriminatorValue,
  createMemoryDetailResponseFromDiscriminatorValue,
  createMemoryListItemResponseFromDiscriminatorValue,
  type HealthResponse,
  type HybridSearchResult,
  type MemoryCreatedResponse,
  type MemoryDetailResponse,
  type MemoryListItemResponse,
} from "../src/generated/models/index.js";
import {
  mapHealthResult,
  mapMemoryCreated,
  mapMemoryDetail,
  mapMemoryListItem,
  mapSearchHit,
} from "../src/mapping.js";

/** Deserializes a raw wire-shaped (snake_case) JSON literal through Kiota's real JSON parse node,
 * the same path a live HTTP response body goes through. */
function fromWire<T>(json: Record<string, unknown>, factory: (node: unknown) => (instance?: unknown) => Record<string, (node: unknown) => void>): T {
  const node = new JsonParseNode(json);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return node.getObjectValue(factory as any) as T;
}

describe("mapSearchHit", () => {
  it("maps rrf_score -> rrfScore and created_at -> createdAt (string) from real wire JSON", () => {
    const generated = fromWire<HybridSearchResult>(
      {
        id: "m1",
        content: "hello",
        rrf_score: 0.873,
        created_at: "2026-01-02T03:04:05Z",
        global: true,
      },
      createHybridSearchResultFromDiscriminatorValue,
    );

    const hit = mapSearchHit(generated);

    expect(hit.rrfScore).toBe(0.873);
    expect(hit.createdAt).toBe("2026-01-02T03:04:05Z");
    expect(typeof hit.createdAt).toBe("string");
  });

  it("maps the wire's `global` flag (not `is_global`) to isGlobal — the trap that bit the .NET leg", () => {
    const generatedTrue = fromWire<HybridSearchResult>({ id: "m1", global: true }, createHybridSearchResultFromDiscriminatorValue);
    const generatedFalse = fromWire<HybridSearchResult>({ id: "m2", global: false }, createHybridSearchResultFromDiscriminatorValue);
    const generatedAbsent = fromWire<HybridSearchResult>({ id: "m3" }, createHybridSearchResultFromDiscriminatorValue);

    expect(mapSearchHit(generatedTrue).isGlobal).toBe(true);
    expect(mapSearchHit(generatedFalse).isGlobal).toBe(false);
    expect(mapSearchHit(generatedAbsent).isGlobal).toBe(false);
  });

  it("surfaces freeform attributes via additionalData", () => {
    const generated = fromWire<HybridSearchResult>(
      { id: "m1", attributes: { confidence_band: "high", anchors: ["a", "b"] } },
      createHybridSearchResultFromDiscriminatorValue,
    );

    expect(mapSearchHit(generated).attributes).toEqual({ confidence_band: "high", anchors: ["a", "b"] });
  });
});

describe("mapMemoryListItem", () => {
  it("maps is_global -> isGlobal (not `global`) and created_at -> createdAt (number)", () => {
    const generated = fromWire<MemoryListItemResponse>(
      { id: "m1", content: "hi", created_at: 1735689600, is_global: true },
      createMemoryListItemResponseFromDiscriminatorValue,
    );

    const item = mapMemoryListItem(generated);

    expect(item.isGlobal).toBe(true);
    expect(item.createdAt).toBe(1735689600);
    expect(typeof item.createdAt).toBe("number");
  });

  it("defaults isGlobal to false when the wire omits is_global", () => {
    const generated = fromWire<MemoryListItemResponse>({ id: "m1" }, createMemoryListItemResponseFromDiscriminatorValue);
    expect(mapMemoryListItem(generated).isGlobal).toBe(false);
  });
});

describe("mapMemoryDetail", () => {
  it("maps is_global -> isGlobal and created_at -> createdAt (number)", () => {
    const generated = fromWire<MemoryDetailResponse>(
      { id: "m1", text: "hi", created_at: 1735689600, is_global: true },
      createMemoryDetailResponseFromDiscriminatorValue,
    );

    const detail = mapMemoryDetail(generated);

    expect(detail.isGlobal).toBe(true);
    expect(detail.createdAt).toBe(1735689600);
    expect(typeof detail.createdAt).toBe("number");
  });

  it("converts the metadata_ UntypedNode tree into plain JSON", () => {
    const generated = fromWire<MemoryDetailResponse>(
      { id: "m1", metadata_: { source: "cli", count: 3, tags: ["a", "b"], nested: { ok: true } } },
      createMemoryDetailResponseFromDiscriminatorValue,
    );

    expect(mapMemoryDetail(generated).metadata).toEqual({ source: "cli", count: 3, tags: ["a", "b"], nested: { ok: true } });
  });
});

describe("mapMemoryCreated", () => {
  it("keeps created_at as a string (this endpoint, unlike list/detail, returns ISO text)", () => {
    const generated = fromWire<MemoryCreatedResponse>(
      { id: "m1", created_at: "2026-01-02T03:04:05Z" },
      createMemoryCreatedResponseFromDiscriminatorValue,
    );

    const created = mapMemoryCreated(generated);
    expect(created.createdAt).toBe("2026-01-02T03:04:05Z");
    expect(typeof created.createdAt).toBe("string");
  });
});

describe("mapHealthResult", () => {
  it("maps checked_at and nested per-dependency checks", () => {
    const generated = fromWire<HealthResponse>(
      {
        status: "ok",
        checked_at: "2026-01-02T03:04:05Z",
        checks: {
          memgraph: { ok: true, latency_ms: 4, url: "bolt://localhost:7687", user: "neo4j" },
          embeddings: { ok: false, error: "timeout" },
        },
      },
      createHealthResponseFromDiscriminatorValue,
    );

    const health = mapHealthResult(generated);

    expect(health.status).toBe("ok");
    expect(health.checkedAt).toBe("2026-01-02T03:04:05Z");
    expect(health.checks).toEqual({
      memgraph: { ok: true, url: "bolt://localhost:7687", user: "neo4j", latencyMs: 4, error: null },
      embeddings: { ok: false, provider: null, model: null, dim: null, latencyMs: null, error: "timeout" },
    });
  });
});
