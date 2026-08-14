/**
 * One graph, many users — and no LLM at all, so this runs against nothing but a Cortadel server.
 *
 * A Cortadel client is bound to a single user id at construction, so per-user scoping means one
 * client per user. `namespaceUserId(-1)` is how one `CortadelStore` serves a multi-tenant graph:
 * it reads the user id out of the namespace, and the store keeps one client per resolved id.
 *
 * `thread_id` scopes the short-term transcript; `userId` scopes long-term memory. They are
 * independent — a user has many threads, and their memory crosses all of them.
 *
 * Run it with a Cortadel server on :3001 (`docker compose up` from the repo root):
 *
 *   pnpm dlx tsx examples/03-multi-user-graph.ts
 */
import process from "node:process";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
  messagesStateReducer,
  type Messages,
} from "@langchain/langgraph";

import { CortadelMemory, CortadelStore, namespaceUserId } from "@cortadel/langgraph";

const BASE_URL = process.env.CORTADEL_BASE_URL ?? "http://localhost:3001";

// The two channels `createReactAgent` uses, declared by hand because this graph is hand-built.
// `llmInputMessages` is overwritten on every hook run rather than appended to, which is what keeps
// the recalled memory block out of the durable transcript.
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[], Messages>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  llmInputMessages: Annotation<BaseMessage[], Messages>({
    reducer: (_left: BaseMessage[], right: Messages) => messagesStateReducer([], right),
    default: () => [],
  }),
});

/** Stands in for a model call, and reports whatever memory it was handed. */
function respond(state: typeof AgentState.State) {
  const seen = state.llmInputMessages.length > 0 ? state.llmInputMessages : state.messages;
  const block = seen.find((message) => message instanceof SystemMessage);
  return {
    messages: [new AIMessage(block ? `I recall: ${String(block.content)}` : "Nothing on file yet.")],
  };
}

async function main(): Promise<void> {
  const store = new CortadelStore({
    baseUrl: BASE_URL,
    // The user id comes out of the namespace's trailing label, so one store serves everybody.
    userId: namespaceUserId(-1),
    apiKey: process.env.CORTADEL_API_KEY,
  });

  // `{userId}` is filled from `config.configurable` on every call.
  const memory = new CortadelMemory({ store, namespace: ["memories", "{userId}"] });

  const graph = new StateGraph(AgentState)
    .addNode("recall", memory.recallNode)
    .addNode("respond", respond)
    .addNode("remember", memory.rememberNode)
    .addEdge(START, "recall")
    .addEdge("recall", "respond")
    .addEdge("respond", "remember")
    .addEdge("remember", END)
    .compile({ store, checkpointer: new MemorySaver() });

  for (const userId of ["e2e-langgraph-alice", "e2e-langgraph-bob"]) {
    // Each user gets their own thread and their own Cortadel namespace.
    await graph.invoke(
      { messages: [new HumanMessage(`My name is ${userId} and I work on the platform team.`)] },
      { configurable: { thread_id: `${userId}-t1`, userId } },
    );

    // A fresh thread for the same user: the transcript is empty, the memory is not.
    const result = await graph.invoke(
      { messages: [new HumanMessage("What do you know about me?")] },
      { configurable: { thread_id: `${userId}-t2`, userId } },
    );
    console.log(`${userId}: ${String(result.messages[result.messages.length - 1]?.content)}`);
  }
}

await main();
