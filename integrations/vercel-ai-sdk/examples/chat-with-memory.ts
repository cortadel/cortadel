/**
 * Automatic memory: the same question, asked in two separate runs.
 *
 * Nothing in the `generateText` calls below mentions memory. The middleware does it all — it
 * searches Cortadel before the model call and stores the finished turn after it — so the second
 * conversation already knows what the first one was told, even though no message history is
 * carried between them.
 *
 * Run it:
 *
 *   1. Start a Cortadel server:  docker compose up          (→ http://localhost:3001)
 *      ...or point CORTADEL_BASE_URL at the hosted service: https://app.cortadel.ai
 *   2. pnpm add @ai-sdk/openai && export OPENAI_API_KEY=...
 *   3. pnpm exec tsx examples/chat-with-memory.ts
 *
 * Cortadel extracts facts with an LLM in the background, so give the first run a few seconds to
 * land before the second one searches for it.
 */
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";

import { cortadelMemory } from "@cortadel/vercel-ai-provider";

const baseUrl = process.env.CORTADEL_BASE_URL ?? "http://localhost:3001";

// One middleware instance, reused for every call. It caches a client per user id internally.
const memory = cortadelMemory({
  baseUrl,
  userId: "e2e-vercel-ai-demo",
  // Omit `apiKey` when the server runs with auth disabled (the self-hosted default).
  apiKey: process.env.CORTADEL_API_KEY,

  topK: 5,
  // Serverless/edge handlers are frozen the moment they return, which kills a background write.
  // Locally it is fine either way; set it to true in a deployed handler.
  awaitPersist: true,

  // Memory must never be the reason an agent fails. Recall errors leave the prompt untouched and
  // persistence errors are dropped — this is the only place you will hear about either.
  onError: (error, { phase }) => console.warn(`[cortadel] ${phase} failed:`, error),
});

const model = wrapLanguageModel({ model: openai("gpt-4.1-mini"), middleware: memory });

// --- Turn 1: tell it something worth remembering. -----------------------------------------
const first = await generateText({
  model,
  prompt: "Remember that I always deploy on Fridays and I prefer metric units.",
});
console.log("1:", first.text);

// Give the background extraction pipeline a moment to distill the turn into facts.
await new Promise((resolve) => setTimeout(resolve, 5_000));

// --- Turn 2: a brand new conversation, no message history passed in. -----------------------
const second = await generateText({
  model,
  prompt: "When do I usually ship, and what units should you answer in?",
});
console.log("2:", second.text);

// --- Multi-tenant: override the user per request. ------------------------------------------
// Works because this middleware was built with `baseUrl` rather than a pre-built `client`; it
// builds and caches one Cortadel client per user id behind the scenes.
const other = await generateText({
  model,
  prompt: "What do you remember about me?",
  providerOptions: { cortadel: { userId: "e2e-vercel-ai-demo-other", sessionId: "session-1" } },
});
console.log("3 (different user, should know nothing):", other.text);
