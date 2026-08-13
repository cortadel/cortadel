/**
 * Automatic memory: recall before the model call, persist after the turn.
 *
 * Run it twice. The first run stores what you tell it; the second recalls it, in a brand-new
 * process, with no chat history carried over.
 *
 *   export OPENAI_API_KEY=sk-...
 *   export CORTADEL_BASE_URL=http://localhost:3001   # or https://app.cortadel.ai
 *   export CORTADEL_API_KEY=...                      # omit if your server has auth disabled
 *
 *   pnpm dlx tsx examples/chat-with-memory.ts
 */

import { Agent, run } from '@openai/agents';
import { CortadelSession } from '@cortadel/openai-agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a concise assistant. Answer in one sentence.',
  model: 'gpt-4.1-mini',
});

const session = new CortadelSession({
  sessionId: 'e2e-openai-agents-demo',
  // The memory namespace. A Cortadel client is bound to one user id at construction, so one
  // session serves exactly one user — build a session per user, never share one.
  userId: 'e2e-openai-agents-user',
  // baseUrl / apiKey default to $CORTADEL_BASE_URL and $CORTADEL_API_KEY.
  topK: 5,
});

try {
  // `session.runOptions()` installs both halves: `session` (history + store-after-turn) and
  // `callModelInputFilter` (recall-before-model-call). Passing only `{ session }` would store
  // without recalling.
  const first = await run(
    agent,
    'Remember that I use Neovim and that I ship on Fridays.',
    session.runOptions(),
  );
  console.log('turn 1:', first.finalOutput);

  const second = await run(agent, 'What editor do I use?', session.runOptions());
  console.log('turn 2:', second.finalOutput);
} finally {
  // Writes are fire-and-forget by default. `close()` drains anything still in flight — do this
  // before a process exits or a serverless handler returns.
  await session.close();
}
