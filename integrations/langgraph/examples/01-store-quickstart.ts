/**
 * Cortadel as a plain LangGraph `BaseStore` — no graph, no agent, no LLM.
 *
 * The point of this one is that `CortadelStore` is a drop-in `BaseStore`: every call below is
 * LangGraph's own API, and swapping `new InMemoryStore()` for `new CortadelStore(...)` is the only
 * change a graph needs to gain durable, cross-thread, per-user memory.
 *
 * Run it with a Cortadel server on :3001 (`docker compose up` from the repo root):
 *
 *   pnpm dlx tsx examples/01-store-quickstart.ts
 */
import process from "node:process";
import { CortadelStore } from "@cortadel/langgraph";

const BASE_URL = process.env.CORTADEL_BASE_URL ?? "http://localhost:3001";
const USER_ID = "e2e-langgraph-quickstart";
const NAMESPACE = ["memories", USER_ID];

async function main(): Promise<void> {
  const store = new CortadelStore({
    baseUrl: BASE_URL,
    userId: USER_ID,
    // Self-hosted Cortadel defaults to auth disabled, so apiKey is optional there.
    apiKey: process.env.CORTADEL_API_KEY,
    // This example wants to see failures rather than degrade quietly past them.
    throwOnError: true,
  });

  const health = await store.health();
  console.log(`server: ${health?.status ?? "unreachable"}`);

  // 1. Write. `content` is the key CortadelStore turns into the memory text; anything else in the
  //    value object is carried along as Cortadel metadata.
  await store.put(NAMESPACE, "pref-release-day", {
    content: "Ships releases on Fridays, never on Mondays.",
    source: "onboarding",
  });
  await store.put(NAMESPACE, "pref-comms", {
    content: "Prefers async written updates over meetings.",
  });

  // 2. Search. This is Cortadel's hybrid BM25 + vector retrieval, RRF-fused — so it finds things
  //    that share no words with the query.
  const hits = await store.search(NAMESPACE, { query: "when do they deploy?", limit: 5 });
  for (const item of hits) {
    console.log(`- ${String(item.value.content)} (score ${item.score ?? "n/a"})`);
  }

  // 3. Read back by key. Cortadel mints its own ids, so the caller-chosen key above is bridged to
  //    the minted id in-process; the durable id is always on `value.id`.
  const item = await store.get(NAMESPACE, "pref-release-day");
  console.log("durable Cortadel id:", item?.value.id);

  // 4. List everything (a query-less search) and tidy up after ourselves.
  const all = await store.search(NAMESPACE, { limit: 20 });
  console.log(`${all.length} memories for ${USER_ID}`);
  for (const stored of all) await store.delete(NAMESPACE, stored.key);
}

await main();
