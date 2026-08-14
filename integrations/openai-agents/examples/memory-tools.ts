/**
 * Explicit memory: the agent decides when to search and when to remember.
 *
 *   export OPENAI_API_KEY=sk-...
 *   export CORTADEL_BASE_URL=http://localhost:3001   # or https://app.cortadel.ai
 *   export CORTADEL_API_KEY=...                      # omit if your server has auth disabled
 *
 *   pnpm dlx tsx examples/memory-tools.ts
 */

import { Agent, run } from '@openai/agents';
import { cortadelMemoryTools } from '@cortadel/openai-agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: [
    'You have a long-term memory of this user.',
    'Call search_memory before answering anything that depends on who they are.',
    'Call add_memories when they tell you something durable about themselves.',
  ].join(' '),
  model: 'gpt-4.1-mini',
  // One toolset per user: the tools close over a client that is bound to this user id.
  tools: cortadelMemoryTools({ userId: 'e2e-openai-agents-user' }),
});

const stored = await run(agent, 'Please remember that my deploy window is Friday morning.');
console.log('stored:', stored.finalOutput);

const recalled = await run(agent, 'When is my deploy window?');
console.log('recalled:', recalled.finalOutput);

// The two shapes compose: give an agent a CortadelSession *and* `tools: session.tools()` for
// automatic recall plus an explicit "look it up again" escape hatch. Tools built that way
// inherit the session's client and retrieval settings, so they never disagree about what the
// user's memory contains.
