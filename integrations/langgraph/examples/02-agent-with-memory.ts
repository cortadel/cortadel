/**
 * A `createReactAgent` that remembers — automatic recall before the model, automatic persistence
 * after the turn, plus the two memory tools for when the agent wants to look something up itself.
 *
 * It deliberately runs on `FakeListChatModel` so the example needs **no LLM API key**: what is
 * being demonstrated is the memory wiring, and a canned model makes the effect visible without
 * spending anything. Swap in a real model with one line — see `REAL MODEL` below.
 *
 * Run it with a Cortadel server on :3001 (`docker compose up` from the repo root):
 *
 *   pnpm dlx tsx examples/02-agent-with-memory.ts
 */
import process from "node:process";
import { HumanMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

import { CortadelMemory, CortadelStore, createMemoryTools } from "@cortadel/langgraph";

const BASE_URL = process.env.CORTADEL_BASE_URL ?? "http://localhost:3001";
const USER_ID = "e2e-langgraph-agent";
const NAMESPACE = ["memories", USER_ID];

async function main(): Promise<void> {
  // 1. Cortadel as the graph's long-term store.
  const store = new CortadelStore({
    baseUrl: BASE_URL,
    userId: USER_ID,
    apiKey: process.env.CORTADEL_API_KEY,
  });

  // 2. Automatic memory: recall before the model call, persist after the turn. Neither needs the
  //    agent to decide anything.
  const memory = new CortadelMemory({ store, namespace: NAMESPACE });

  // REAL MODEL: replace this with, say,
  //   import { ChatAnthropic } from "@langchain/anthropic";
  //   const llm = new ChatAnthropic({ model: "claude-sonnet-4-5" });
  const llm = new FakeListChatModel({
    responses: ["Noted — Fridays it is.", "Friday, going by what you told me before."],
  });

  const agent = createReactAgent({
    llm,
    // 3. ...and tools, for when the agent wants to look something up or write something down.
    tools: createMemoryTools({ store, namespace: NAMESPACE }),
    store,
    preModelHook: memory.preModelHook,
    postModelHook: memory.postModelHook,
    checkpointer: new MemorySaver(),
  });

  // Turn one, on thread `conv-1`.
  await agent.invoke(
    { messages: [new HumanMessage("I ship releases on Fridays.")] },
    { configurable: { thread_id: "conv-1" } },
  );

  // Turn two, on a brand-new thread — the checkpointer's transcript is empty here, so anything the
  // agent knows now came out of Cortadel.
  const result = await agent.invoke(
    { messages: [new HumanMessage("When should we deploy?")] },
    { configurable: { thread_id: "conv-2" } },
  );
  console.log(String(result.messages[result.messages.length - 1]?.content));

  // Long-term memory crossed the thread boundary; the transcript did not.
  const remembered = await store.search(NAMESPACE, { query: "release schedule", limit: 5 });
  for (const item of remembered) console.log(`- ${String(item.value.content)}`);
}

await main();
