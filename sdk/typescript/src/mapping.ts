// Generated-model -> facade-DTO mapping. Deliberately its own module, separate from models.ts:
// these functions must accept the *generated* interfaces (GM.HybridSearchResult and friends) so a
// future field rename in the generated tree fails this file at compile time. If they lived in
// models.ts instead, models.ts's own .d.ts would gain a transitive reference to src/generated —
// exactly the leak src/index.ts's encapsulation test (test/client.test.ts) checks for, since
// models.ts's types are re-exported wholesale from index.ts and this module's exports are not.
//
// client.ts is the only non-test importer of this module; the facade "owns no field names beyond
// the mapping" (per the plan) by delegating every generated->DTO conversion here.
import {
  isUntypedArray,
  isUntypedBoolean,
  isUntypedNull,
  isUntypedNumber,
  isUntypedObject,
  isUntypedString,
  type UntypedNode,
} from "@microsoft/kiota-abstractions";

import type * as GM from "./generated/models/index.js";
import type {
  ConversationIngestItem,
  ConversationResult,
  HealthResult,
  MemoryCreated,
  MemoryDetail,
  MemoryList,
  MemoryListItem,
  SearchHit,
  SearchResults,
} from "./models.js";

/** Recursively unwraps a Kiota `UntypedNode` tree (used for `metadata_`/free-form fields) into plain JSON. */
export function untypedToJson(node: UntypedNode | null | undefined): unknown {
  if (node == null || isUntypedNull(node)) return null;
  if (isUntypedString(node) || isUntypedBoolean(node) || isUntypedNumber(node)) return node.getValue();
  if (isUntypedArray(node)) return node.getValue().map(untypedToJson);
  if (isUntypedObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.getValue())) out[key] = untypedToJson(value);
    return out;
  }
  return node.getValue();
}

export function mapMemoryCreated(r: GM.MemoryCreatedResponse): MemoryCreated {
  return {
    id: r.id ?? "",
    content: r.content ?? null,
    state: r.state ?? null,
    createdAt: r.createdAt ?? null,
    event: r.event ?? null,
    appName: r.appName ?? null,
    metadata: r.metadata ?? null,
  };
}

export function mapConversationIngestItem(i: GM.ConversationIngestItem): ConversationIngestItem {
  return {
    id: i.id ?? null,
    memory: i.memory ?? null,
    event: i.event ?? null,
    error: i.errorEscaped ?? null,
  };
}

export function mapConversationResult(r: GM.ConversationIngestResponse): ConversationResult {
  return {
    results: r.results?.map(mapConversationIngestItem) ?? null,
    noFactsExtracted: r.noFactsExtracted ?? null,
  };
}

export function mapSearchHit(h: GM.HybridSearchResult): SearchHit {
  return {
    id: h.id ?? "",
    content: h.content ?? "",
    rrfScore: h.rrfScore ?? null,
    createdAt: h.createdAt ?? null,
    appName: h.appName ?? null,
    categories: h.categories ?? null,
    memoryType: h.memoryType ?? null,
    tags: h.tags ?? null,
    source: h.source ?? null,
    // Trap: this schema's flag is `global`, not `is_global` (MemoryListItem/MemoryDetail use
    // `is_global`) — see the doc comment on SearchHit.isGlobal in models.ts.
    isGlobal: h.global ?? false,
    gist: h.gist ?? null,
    projectId: h.projectId ?? null,
    memberIds: h.memberIds ?? null,
    similarIds: h.similarIds ?? null,
    textRank: h.textRank ?? null,
    vectorRank: h.vectorRank ?? null,
    attributes: (h.attributes?.additionalData as Record<string, unknown> | undefined) ?? null,
  };
}

export function mapSearchResults(r: GM.SearchResponse): SearchResults {
  return {
    query: r.query ?? "",
    results: (r.results ?? []).map(mapSearchHit),
    total: r.total ?? 0,
  };
}

export function mapMemoryListItem(i: GM.MemoryListItemResponse): MemoryListItem {
  return {
    id: i.id ?? "",
    content: i.content ?? "",
    createdAt: i.createdAt ?? 0,
    state: i.state ?? "active",
    appId: i.appId ?? null,
    appName: i.appName ?? null,
    categories: i.categories ?? [],
    memoryType: i.memoryType ?? null,
    extractionStatus: i.extractionStatus ?? null,
    validAt: i.validAt ?? null,
    invalidAt: i.invalidAt ?? null,
    isCurrent: i.isCurrent ?? null,
    // Trap: this schema's flag is `is_global` — the SearchHit schema uses `global` instead.
    isGlobal: i.isGlobal ?? false,
    metadata: untypedToJson(i.metadata),
  };
}

export function mapMemoryList(r: GM.MemoryListPagedResponse): MemoryList {
  return {
    items: (r.items ?? []).map(mapMemoryListItem),
    total: r.total ?? 0,
    page: r.page ?? 0,
    size: r.size ?? 0,
    pages: r.pages ?? 0,
  };
}

export function mapMemoryDetail(d: GM.MemoryDetailResponse): MemoryDetail {
  return {
    id: d.id ?? "",
    text: d.text ?? "",
    createdAt: d.createdAt ?? 0,
    state: d.state ?? "active",
    appId: d.appId ?? null,
    appName: d.appName ?? null,
    categories: d.categories ?? [],
    metadata: untypedToJson(d.metadata),
    validAt: d.validAt ?? null,
    invalidAt: d.invalidAt ?? null,
    isCurrent: d.isCurrent ?? null,
    supersededBy: d.supersededBy ?? null,
    // Trap: this schema's flag is `is_global` — the SearchHit schema uses `global` instead.
    isGlobal: d.isGlobal ?? false,
  };
}

function mapEmbeddingCheck(c: GM.EmbeddingCheck) {
  return {
    ok: c.ok ?? false,
    provider: c.provider ?? null,
    model: c.model ?? null,
    dim: c.dim ?? null,
    latencyMs: c.latencyMs ?? null,
    error: c.errorEscaped ?? null,
  };
}

function mapIndexesCheck(c: GM.IndexesCheck) {
  return {
    ok: c.ok ?? false,
    model: c.model ?? null,
    providerDim: c.providerDim ?? null,
    vectorIndexes: c.vectorIndexes ?? null,
    mismatches: c.mismatches ?? null,
    error: c.errorEscaped ?? null,
  };
}

function mapMemgraphCheck(c: GM.MemgraphCheck) {
  return {
    ok: c.ok ?? false,
    url: c.url ?? null,
    user: c.user ?? null,
    latencyMs: c.latencyMs ?? null,
    error: c.errorEscaped ?? null,
  };
}

function mapHealthChecks(c: GM.HealthChecks): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.embeddings) out.embeddings = mapEmbeddingCheck(c.embeddings);
  if (c.indexes) out.indexes = mapIndexesCheck(c.indexes);
  if (c.memgraph) out.memgraph = mapMemgraphCheck(c.memgraph);
  return out;
}

export function mapHealthResult(r: GM.HealthResponse): HealthResult {
  return {
    status: r.status ?? "",
    checkedAt: r.checkedAt ?? null,
    checks: r.checks ? mapHealthChecks(r.checks) : null,
  };
}
