/**
 * Memory tools: the agent decides when to remember and when to recall.
 *
 * This is the other half of the integration — an in-process MCP server
 * (`createSdkMcpServer`) exposing two tools:
 *
 *     mcp__cortadel__search_memory   query, top_k?
 *     mcp__cortadel__add_memories    text, memory_type?
 *
 * `{ autoMemory: false }` turns the hooks off, so every read and write below is
 * a tool call the model chose to make. Watch the `[tool call]` lines.
 *
 *     npm install @cortadel/claude-agent-sdk @anthropic-ai/claude-agent-sdk zod
 *
 *     export CORTADEL_URL=http://localhost:3001
 *     export CORTADEL_USER_ID=e2e-claude-agent-sdk-demo
 *     # export CORTADEL_API_KEY=...     # only if the server has auth enabled
 *
 *     npx tsx memory-tools.ts
 *
 * From a checkout of this repo instead, build first — the import below is a
 * package self-reference, so Node resolves it through `exports` to `dist/`:
 *
 *     pnpm build && pnpm dlx tsx examples/memory-tools.ts
 *
 * Requires the Claude Code CLI and Anthropic credentials, which the Claude
 * Agent SDK itself needs.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { CortadelMemory } from "@cortadel/claude-agent-sdk";

const PROMPTS = [
  "Remember that our staging database is reset every Sunday at 02:00 UTC.",
  "When is staging wiped? Check your memory before answering.",
];

const memory = new CortadelMemory({
  baseUrl: process.env.CORTADEL_URL ?? "http://localhost:3001",
  userId: process.env.CORTADEL_USER_ID ?? "e2e-claude-agent-sdk-demo",
  apiKey: process.env.CORTADEL_API_KEY || undefined,
});

// apply() merges the MCP server and pre-approves both tool names. By hand:
//     mcpServers: { cortadel: memory.mcpServer },
//     allowedTools: ["mcp__cortadel__search_memory", "mcp__cortadel__add_memories"],
const options = memory.apply(
  {
    model: "claude-sonnet-4-5",
    // No built-in tools: this agent's only capability is its memory.
    tools: [],
    systemPrompt:
      "You have a long-term memory. Store durable facts with add_memories and check " +
      "search_memory before answering anything that might depend on earlier context.",
  },
  { autoMemory: false },
);

for (const prompt of PROMPTS) {
  console.log(`\n>>> ${prompt}`);
  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          console.log(`    [tool call] ${block.name} ${JSON.stringify(block.input)}`);
        }
      }
    } else if (message.type === "result" && message.subtype === "success") {
      console.log(`<<< ${message.result}`);
    }
  }
}
