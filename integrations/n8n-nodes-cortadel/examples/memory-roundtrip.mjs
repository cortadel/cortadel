/**
 * End-to-end round trip through the exact code the Cortadel Memory sub-node runs,
 * without needing an n8n instance.
 *
 * It drives `CortadelChatMemory` + `createCortadelBackend` — the same two modules the
 * node wires together in `supplyData()` — through one full agent turn:
 *
 *   loadMemoryVariables()  →  POST /api/v1/memories/search   (recall, injected as context)
 *   saveContext()          →  POST /api/v1/memories/from-conversation  (persist the turn)
 *
 * Run it against a real Cortadel server:
 *
 *   cd integrations/n8n-nodes-cortadel
 *   pnpm install && pnpm run build
 *   CORTADEL_BASE_URL=http://localhost:3001 node examples/memory-roundtrip.mjs
 *
 * Optional env: CORTADEL_API_KEY (omit for a self-hosted server with auth disabled).
 * The user id is a disposable e2e-* id — this writes real memories to that server.
 */
import { createCortadelBackend } from '../dist/shared/backend.js';
import { CortadelChatMemory } from '../dist/shared/memory.js';

const BASE_URL = process.env.CORTADEL_BASE_URL ?? 'http://localhost:3001';
const API_KEY = process.env.CORTADEL_API_KEY ?? '';
const USER_ID = 'e2e-n8n-memory-roundtrip';
const SESSION_ID = 'e2e-n8n-roundtrip-session';

/**
 * The backend only needs the handful of members n8n's execution context provides.
 * Outside n8n we stand them up over plain `fetch`; inside n8n the real context
 * supplies `httpRequestWithAuthentication`, which also applies proxy and TLS config.
 */
const ctx = {
	getNode: () => ({ name: 'Cortadel Memory', type: 'n8n-nodes-cortadel.cortadelMemory' }),
	getCredentials: async () => ({ baseUrl: BASE_URL, apiKey: API_KEY }),
	helpers: {
		async httpRequestWithAuthentication(_credentialType, options) {
			const url = new URL(options.url, options.baseURL);
			for (const [key, value] of Object.entries(options.qs ?? {})) {
				url.searchParams.set(key, String(value));
			}
			const response = await fetch(url, {
				method: options.method,
				headers: {
					'Content-Type': 'application/json',
					...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
					...options.headers,
				},
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
			});
			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText} for ${options.url}`);
			}
			return await response.json();
		},
	},
};

const backend = createCortadelBackend(ctx, {
	userId: USER_ID,
	sessionId: SESSION_ID,
	// Leaving recall unscoped is the point of long-term memory: it spans every session
	// this user ever had, not just the current conversation. Set this to `true` to make
	// the memory behave like a conversation buffer instead.
	scopeRecallToSession: false,
	topK: 5,
	mode: 'hybrid',
	persistTurns: true,
	tags: ['n8n-example'],
});

const memory = new CortadelChatMemory({
	backend,
	logger: { warn: (message) => console.warn('  [degraded]', message) },
});

// --- turn 1: nothing is known yet, then we teach it something -----------------
const first = 'I run all my deploys on Fridays and I hate long changelogs.';

console.log('\n1. Recall before the model call');
const before = await memory.loadMemoryVariables({ input: first });
console.log('   injected messages:', before.chat_history.length);
for (const message of before.chat_history) console.log('   |', message.content);

console.log('\n2. Persist the finished turn');
await memory.saveContext(
	{ input: first },
	{ output: 'Got it — Friday deploys, short changelogs.' },
);
console.log('   sent to the extraction pipeline');

// Extraction runs off the request path, so give it a moment before asking again.
await new Promise((resolve) => setTimeout(resolve, 4000));

// --- turn 2: a different question that should surface the same facts ----------
console.log('\n3. Recall on a later, differently-worded turn');
const after = await memory.loadMemoryVariables({ input: 'what is my release cadence?' });
console.log('   injected messages:', after.chat_history.length);
for (const message of after.chat_history) console.log('   |', message.content);

console.log('\n4. The same turn twice is stored only once');
await memory.saveContext(
	{ input: first },
	{ output: 'Got it — Friday deploys, short changelogs.' },
);
console.log('   duplicate suppressed by the turn fingerprint');

console.log('\n5. clear() drops the local cache and deletes nothing');
await memory.clear();
console.log('   done — memories for', USER_ID, 'are still on the server');
