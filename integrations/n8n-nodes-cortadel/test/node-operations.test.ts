import { describe, expect, it } from 'vitest';

import { Cortadel, parseCsv, toConversationMessages } from '../nodes/Cortadel/Cortadel.node';
import { TEST_SESSION, TEST_USER, createFakeContext } from './helpers';

const node = new Cortadel();

async function run(options: Parameters<typeof createFakeContext>[0]) {
	const ctx = createFakeContext(options);
	const output = await (node.execute as any).call(ctx);
	return { ctx, items: output[0] as Array<{ json: Record<string, unknown> }> };
}

describe('add', () => {
	it('POSTs the memory with the user id and this integration as the app', async () => {
		const { ctx, items } = await run({
			params: {
				operation: 'add',
				userId: TEST_USER,
				text: 'Prefers dark mode.',
				additionalFields: {},
			},
			responses: [{ id: 'mem-1', event: 'ADD', content: 'Prefers dark mode.' }],
		});

		expect(ctx.requests).toHaveLength(1);
		expect(ctx.requests[0].credentialType).toBe('cortadelApi');
		expect(ctx.requests[0].method).toBe('POST');
		expect(ctx.requests[0].url).toBe('/api/v1/memories');
		expect(ctx.requests[0].baseURL).toBe('http://localhost:3001');
		expect(ctx.requests[0].body).toEqual({
			user_id: TEST_USER,
			text: 'Prefers dark mode.',
			app: 'n8n-nodes-cortadel',
		});
		expect(items[0].json).toMatchObject({ id: 'mem-1', event: 'ADD' });
	});

	it('passes infer=false and parsed metadata through', async () => {
		const { ctx } = await run({
			params: {
				operation: 'add',
				userId: TEST_USER,
				text: 'Verbatim note.',
				additionalFields: { infer: false, metadata: '{"source":"n8n"}', memoryType: 'episodic' },
			},
			responses: [{ id: 'mem-2' }],
		});

		expect(ctx.requests[0].body).toEqual({
			user_id: TEST_USER,
			text: 'Verbatim note.',
			app: 'n8n-nodes-cortadel',
			infer: false,
			memory_type: 'episodic',
			metadata: { source: 'n8n' },
		});
	});

	it('sends no metadata key when the JSON field was added but left at its default', () => {
		// n8n hands back the property's default string '{}' as soon as the user adds
		// the option, even untouched. That must not become `metadata: {}` on the wire.
		return run({
			params: {
				operation: 'add',
				userId: TEST_USER,
				text: 'Prefers dark mode.',
				additionalFields: { metadata: '{}' },
			},
			responses: [{ id: 'mem-3' }],
		}).then(({ ctx }) => {
			expect(ctx.requests[0].body).toEqual({
				user_id: TEST_USER,
				text: 'Prefers dark mode.',
				app: 'n8n-nodes-cortadel',
			});
		});
	});

	it('sends no memory_type when the Memory Type option is set back to Any', () => {
		return run({
			params: {
				operation: 'add',
				userId: TEST_USER,
				text: 'Prefers dark mode.',
				additionalFields: { memoryType: '' },
			},
			responses: [{ id: 'mem-4' }],
		}).then(({ ctx }) => {
			expect(Object.keys(ctx.requests[0].body as object)).not.toContain('memory_type');
		});
	});
});

describe('addConversation', () => {
	it('sends the fixedCollection turns to the from-conversation route', async () => {
		const { ctx, items } = await run({
			params: {
				operation: 'addConversation',
				userId: TEST_USER,
				inputMode: 'fields',
				messages: {
					message: [
						{ role: 'user', content: 'I deploy on Fridays.' },
						{ role: 'assistant', content: 'Noted.' },
					],
				},
				conversationFields: { sessionId: TEST_SESSION, tags: 'ops, deploys' },
			},
			responses: [{ results: [{ id: 'f-1', memory: 'Deploys on Fridays', event: 'ADD' }] }],
		});

		expect(ctx.requests[0].url).toBe('/api/v1/memories/from-conversation');
		expect(ctx.requests[0].body).toEqual({
			user_id: TEST_USER,
			messages: [
				{ role: 'user', content: 'I deploy on Fridays.' },
				{ role: 'assistant', content: 'Noted.' },
			],
			session_id: TEST_SESSION,
			tags: ['ops', 'deploys'],
		});
		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({ id: 'f-1', event: 'ADD' });
	});

	it('reports the mutually-exclusive no_facts_extracted branch', async () => {
		const { items } = await run({
			params: {
				operation: 'addConversation',
				userId: TEST_USER,
				inputMode: 'json',
				messagesJson: '[{"role":"user","content":"hi"}]',
				conversationFields: {},
			},
			responses: [{ no_facts_extracted: true }],
		});
		expect(items[0].json).toEqual({ no_facts_extracted: true });
	});

	it('rejects an empty transcript instead of calling the server', async () => {
		await expect(
			run({
				params: {
					operation: 'addConversation',
					userId: TEST_USER,
					inputMode: 'json',
					messagesJson: '[]',
					conversationFields: {},
				},
			}),
		).rejects.toThrow(/at least one non-empty conversation message/i);
	});
});

describe('search', () => {
	it('maps the Rerank toggle onto the only strategy the contract accepts', async () => {
		const { ctx, items } = await run({
			params: {
				operation: 'search',
				userId: TEST_USER,
				query: 'deployment preferences',
				simplify: true,
				searchOptions: { topK: 3, rerank: true, sessionId: TEST_SESSION },
			},
			responses: [
				{
					query: 'deployment preferences',
					total: 2,
					results: [
						{ id: 'a', content: 'Deploys on Fridays', rrf_score: 0.9 },
						{ id: 'b', content: 'Prefers dark mode', rrf_score: 0.4 },
					],
				},
			],
		});

		expect(ctx.requests[0].url).toBe('/api/v1/memories/search');
		expect(ctx.requests[0].body).toEqual({
			user_id: TEST_USER,
			query: 'deployment preferences',
			top_k: 3,
			mode: 'hybrid',
			session_id: TEST_SESSION,
			rerank: 'cross_encoder',
			app_name: 'n8n-nodes-cortadel',
		});
		expect(items).toHaveLength(2);
		expect(items[0].json).toMatchObject({ id: 'a' });
	});

	it('returns the raw envelope when Simplify is off', async () => {
		const { items } = await run({
			params: {
				operation: 'search',
				userId: TEST_USER,
				query: 'anything',
				simplify: false,
				searchOptions: {},
			},
			responses: [{ query: 'anything', total: 0, results: [] }],
		});
		expect(items).toHaveLength(1);
		expect(items[0].json).toEqual({ query: 'anything', total: 0, results: [] });
	});
});

describe('list', () => {
	it('sends the paging query string and stringifies include_superseded', async () => {
		const { ctx, items } = await run({
			params: {
				operation: 'list',
				userId: TEST_USER,
				returnAll: false,
				limit: 5,
				listOptions: { includeSuperseded: true, categories: 'ops' },
			},
			responses: [{ items: [{ id: 'l-1', content: 'x' }], total: 1, page: 1, size: 5, pages: 1 }],
		});

		expect(ctx.requests[0].method).toBe('GET');
		expect(ctx.requests[0].url).toBe('/api/v1/memories');
		expect(ctx.requests[0].qs).toEqual({
			user_id: TEST_USER,
			categories: 'ops',
			include_superseded: 'true',
			page: 1,
			size: 5,
		});
		expect(items).toHaveLength(1);
	});

	it('walks every page when Return All is on', async () => {
		const { ctx, items } = await run({
			params: { operation: 'list', userId: TEST_USER, returnAll: true, listOptions: {} },
			responses: [
				{ items: [{ id: '1' }, { id: '2' }], total: 3, page: 1, size: 100, pages: 2 },
				{ items: [{ id: '3' }], total: 3, page: 2, size: 100, pages: 2 },
			],
		});

		expect(ctx.requests).toHaveLength(2);
		expect(ctx.requests[0].qs?.page).toBe(1);
		expect(ctx.requests[1].qs?.page).toBe(2);
		expect(items.map((i) => i.json.id)).toEqual(['1', '2', '3']);
	});
});

describe('get and delete', () => {
	it('url-encodes the memory id and scopes the read to the user', async () => {
		const { ctx } = await run({
			params: { operation: 'get', userId: TEST_USER, memoryId: 'mem/1 2' },
			responses: [{ id: 'mem/1 2', text: 'hello' }],
		});
		expect(ctx.requests[0].url).toBe('/api/v1/memories/mem%2F1%202');
		expect(ctx.requests[0].qs).toEqual({ user_id: TEST_USER });
	});

	it('sends a DELETE with the id list in the body', async () => {
		const { ctx, items } = await run({
			params: { operation: 'delete', userId: TEST_USER, memoryIds: 'a, b ,,c' },
			responses: [{ message: 'Deleted 3 memories' }],
		});
		expect(ctx.requests[0].method).toBe('DELETE');
		expect(ctx.requests[0].body).toEqual({ user_id: TEST_USER, memory_ids: ['a', 'b', 'c'] });
		expect(items[0].json).toEqual({ deleted: ['a', 'b', 'c'], message: 'Deleted 3 memories' });
	});
});

describe('user scoping and error propagation', () => {
	it('refuses to run without a user id', async () => {
		await expect(
			run({ params: { operation: 'search', userId: '   ', query: 'x', searchOptions: {} } }),
		).rejects.toThrow(/user id is required/i);
	});

	it('scopes each execution to the user id it was given', async () => {
		const first = await run({
			params: { operation: 'search', userId: 'e2e-alice', query: 'q', searchOptions: {} },
			responses: [{ results: [] }],
		});
		const second = await run({
			params: { operation: 'search', userId: 'e2e-bob', query: 'q', searchOptions: {} },
			responses: [{ results: [] }],
		});
		expect((first.ctx.requests[0].body as any).user_id).toBe('e2e-alice');
		expect((second.ctx.requests[0].body as any).user_id).toBe('e2e-bob');
	});

	it('rejects an unknown operation, including inherited Object keys', async () => {
		// The dispatch table is a Map on purpose. As a plain object, `operation:
		// 'toString'` would resolve `Object.prototype.toString`, pass a truthiness
		// check and be invoked as a handler. Every one of these must 404, not dispatch.
		for (const operation of ['nope', 'toString', 'constructor', 'valueOf', '__proto__']) {
			await expect(
				run({ params: { operation, userId: TEST_USER } }),
			).rejects.toThrow(/unknown operation/i);
		}
	});

	it('wraps a transport failure as a node error', async () => {
		await expect(
			run({
				params: { operation: 'search', userId: TEST_USER, query: 'q', searchOptions: {} },
				responses: [new Error('ECONNREFUSED 127.0.0.1:3001')],
			}),
		).rejects.toThrow();
	});

	it('emits an error item instead of throwing when Continue On Fail is set', async () => {
		const { items } = await run({
			params: { operation: 'search', userId: TEST_USER, query: 'q', searchOptions: {} },
			responses: [new Error('boom')],
			continueOnFail: true,
		});
		expect(items).toHaveLength(1);
		expect(String(items[0].json.error)).toMatch(/boom|Cortadel request failed/);
	});
});

describe('pure helpers', () => {
	it('parses comma-separated ids, dropping blanks', () => {
		expect(parseCsv(' a , ,b,')).toEqual(['a', 'b']);
		expect(parseCsv('')).toEqual([]);
	});

	it('normalises conversation turns and drops empty content', () => {
		expect(
			toConversationMessages([
				{ role: 'user', content: 'hi', uuid: 'u1' },
				{ role: '', content: 'no role' },
				{ role: 'assistant', content: '   ' },
				'nonsense',
			]),
		).toEqual([
			{ role: 'user', content: 'hi', uuid: 'u1' },
			{ role: 'user', content: 'no role' },
		]);
	});
});
