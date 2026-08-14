import { describe, expect, it } from 'vitest';

import { CortadelMemory } from '../nodes/CortadelMemory/CortadelMemory.node';
import { createCortadelBackend } from '../shared/backend';
import { TEST_SESSION, TEST_USER, createFakeContext } from './helpers';

const node = new CortadelMemory();

async function supply(params: Record<string, unknown>, responses: unknown[] = []) {
	const ctx = createFakeContext({ params, responses });
	const supplied = await (node.supplyData as any).call(ctx, 0);
	return { ctx, memory: supplied.response as any };
}

const baseParams = {
	userId: TEST_USER,
	sessionId: TEST_SESSION,
	scopeRecallToSession: false,
	topK: 4,
	options: {},
};

describe('supplyData', () => {
	it('hands the agent an object with the memory surface LangChain calls', async () => {
		const { memory } = await supply(baseParams);
		expect(memory.memoryKeys).toEqual(['chat_history']);
		expect(typeof memory.loadMemoryVariables).toBe('function');
		expect(typeof memory.saveContext).toBe('function');
		expect(typeof memory.clear).toBe('function');
		expect(typeof memory.chatHistory.getMessages).toBe('function');
	});

	it('refuses to supply memory without a user id', async () => {
		await expect(supply({ ...baseParams, userId: '  ' })).rejects.toThrow(/user id is required/i);
	});

	it('refuses to supply memory without a session id', async () => {
		await expect(supply({ ...baseParams, sessionId: '' })).rejects.toThrow(
			/session id is required/i,
		);
	});
});

describe('recall over REST', () => {
	it('searches the whole user graph by default', async () => {
		const { ctx, memory } = await supply({ ...baseParams, scopeRecallToSession: false }, [
			{ results: [{ id: 'm1', content: 'Ships on Fridays' }] },
		]);

		await memory.loadMemoryVariables({ input: 'when do we ship?' });

		expect(ctx.requests[0].url).toBe('/api/v1/memories/search');
		expect(ctx.requests[0].body).toEqual({
			user_id: TEST_USER,
			query: 'when do we ship?',
			top_k: 4,
			mode: 'hybrid',
			app_name: 'n8n-nodes-cortadel',
		});
	});

	it('narrows recall to the session when Scope Recall to Session is on', async () => {
		const { ctx, memory } = await supply({ ...baseParams, scopeRecallToSession: true }, [
			{ results: [] },
		]);
		await memory.loadMemoryVariables({ input: 'what did I just say?' });
		expect((ctx.requests[0].body as any).session_id).toBe(TEST_SESSION);
	});

	it('recalls Top K memories per turn, defaulting to five', async () => {
		// Only userId and sessionId are supplied, so supplyData falls back for the rest.
		// Those fallbacks must mirror the node description's own defaults — checked in
		// node-description.test.ts — or a stored workflow and a fresh one would differ.
		const { ctx, memory } = await supply(
			{ userId: TEST_USER, sessionId: TEST_SESSION },
			[{ results: [] }],
		);
		await memory.loadMemoryVariables({ input: 'anything relevant' });
		expect((ctx.requests[0].body as any).top_k).toBe(5);
	});

	it('lists recent memories when the turn carries no query', async () => {
		const { ctx, memory } = await supply(baseParams, [
			{ items: [{ id: 'l1', content: 'A stored fact' }], pages: 1 },
		]);
		// This is exactly what n8n's *streaming* agent branch does — it calls
		// loadMemoryVariables({}) with no input at all. Documented in the README.
		const variables = await memory.loadMemoryVariables({});
		expect(ctx.requests[0].method).toBe('GET');
		expect(ctx.requests[0].qs).toEqual({ user_id: TEST_USER, page: 1, size: 4 });
		expect(String((variables.chat_history as any[])[0].content)).toContain('A stored fact');
	});

	it('keeps the configured cognitive-type filter on the no-query fallback', async () => {
		const { ctx, memory } = await supply(
			{ ...baseParams, options: { memoryType: 'procedural' } },
			[{ items: [], pages: 0 }],
		);
		await memory.loadMemoryVariables({});
		expect(ctx.requests[0].qs).toEqual({
			user_id: TEST_USER,
			page: 1,
			size: 4,
			memory_type: 'procedural',
		});
	});
});

describe('persist over REST', () => {
	it('posts the finished turn to the conversation route with session and tags', async () => {
		const { ctx, memory } = await supply(
			{ ...baseParams, options: { tags: 'support, vip', project: 'acme' } },
			[{ results: [{ id: 'f1', event: 'ADD' }] }],
		);

		await memory.saveContext({ input: 'I use Postgres' }, { output: 'Got it.' });

		expect(ctx.requests[0].url).toBe('/api/v1/memories/from-conversation');
		expect(ctx.requests[0].body).toEqual({
			user_id: TEST_USER,
			messages: [
				{ role: 'user', content: 'I use Postgres' },
				{ role: 'assistant', content: 'Got it.' },
			],
			session_id: TEST_SESSION,
			project: 'acme',
			tags: ['support', 'vip'],
		});
	});

	it('makes the memory read-only when Persist Turns is off', async () => {
		const { ctx, memory } = await supply({ ...baseParams, options: { persistTurns: false } });
		await memory.saveContext({ input: 'anything' }, { output: 'reply' });
		expect(ctx.requests).toHaveLength(0);
	});
});

describe('user scoping', () => {
	it('binds each supplied memory to exactly one Cortadel user', async () => {
		const alice = await supply({ ...baseParams, userId: 'e2e-alice' }, [{ results: [] }]);
		const bob = await supply({ ...baseParams, userId: 'e2e-bob' }, [{ results: [] }]);

		await alice.memory.loadMemoryVariables({ input: 'shared question' });
		await bob.memory.loadMemoryVariables({ input: 'shared question' });

		expect((alice.ctx.requests[0].body as any).user_id).toBe('e2e-alice');
		expect((bob.ctx.requests[0].body as any).user_id).toBe('e2e-bob');
	});
});

describe('degradation and tracing', () => {
	it('keeps the agent running when the Cortadel server is unreachable', async () => {
		const { ctx, memory } = await supply(baseParams, [new Error('ECONNREFUSED')]);
		const variables = await memory.loadMemoryVariables({ input: 'anything relevant' });
		expect(variables.chat_history).toEqual([]);
		expect(ctx.warnings.join()).toMatch(/\[Cortadel Memory]/);
	});

	it('surfaces each call as a sub-node run in the n8n UI', async () => {
		const { ctx, memory } = await supply(baseParams, [{ results: [{ id: 'x', content: 'y' }] }]);
		await memory.loadMemoryVariables({ input: 'a real query' });
		expect(ctx.traceInputs).toHaveLength(1);
		expect(ctx.traceOutputs).toHaveLength(1);
		expect((ctx.traceOutputs[0] as any)[0][0].json).toEqual({ action: 'recall', recalled: 1 });
	});

	it('still works when the tracing helpers are unavailable', async () => {
		const ctx = createFakeContext({ params: baseParams, responses: [{ results: [] }] });
		ctx.addInputData = () => {
			throw new Error('not supported on this n8n version');
		};
		const supplied = await (node.supplyData as any).call(ctx, 0);
		await expect(
			(supplied.response as any).loadMemoryVariables({ input: 'a real query' }),
		).resolves.toBeDefined();
		expect(ctx.requests).toHaveLength(1);
	});
});

describe('backend wiring', () => {
	it('drops optional fields rather than sending blanks', async () => {
		const ctx = createFakeContext({ responses: [{ results: [] }] });
		const backend = createCortadelBackend(ctx as any, {
			userId: TEST_USER,
			sessionId: TEST_SESSION,
			scopeRecallToSession: false,
			topK: 10,
			mode: 'hybrid',
			rerank: undefined,
			memoryType: undefined,
			project: undefined,
			tags: [],
			persistTurns: true,
		});

		await backend.recall('query text');
		const body = ctx.requests[0].body as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(['app_name', 'mode', 'query', 'top_k', 'user_id']);
	});
});
