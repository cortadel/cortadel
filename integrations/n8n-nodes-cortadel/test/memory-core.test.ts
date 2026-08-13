import { describe, expect, it, vi } from 'vitest';

import type { CortadelMemoryBackend } from '../shared/memory';
import {
	CortadelChatMemory,
	coerceText,
	createFallbackMessageFactory,
	dedupeHits,
	toBufferString,
} from '../shared/memory';
import type { CortadelConversationMessage, CortadelSearchHit } from '../shared/types';

function hit(id: string, content: string): CortadelSearchHit {
	return { id, content, rrf_score: 0.5 };
}

function createBackend(overrides: Partial<CortadelMemoryBackend> = {}) {
	const persisted: CortadelConversationMessage[][] = [];
	const backend: CortadelMemoryBackend & { persisted: typeof persisted } = {
		persisted,
		recall: vi.fn(async () => [hit('m1', 'Deploys on Fridays')]),
		recent: vi.fn(async () => [hit('m9', 'Recent fact')]),
		persist: vi.fn(async (messages: CortadelConversationMessage[]) => {
			persisted.push(messages);
		}),
		...overrides,
	} as CortadelMemoryBackend & { persisted: typeof persisted };
	return backend;
}

function createMemory(
	backend: CortadelMemoryBackend,
	config: Partial<ConstructorParameters<typeof CortadelChatMemory>[0]> = {},
) {
	const warnings: string[] = [];
	const memory = new CortadelChatMemory({
		backend,
		messageFactory: createFallbackMessageFactory(),
		logger: { warn: (m) => warnings.push(m) },
		...config,
	});
	return { memory, warnings };
}

describe('retrieve then inject', () => {
	it('searches with the current turn and injects the facts as one user-role block', async () => {
		// The default role is `user`, not `system`: Anthropic throws on any system
		// message after position 0, and recalled context always lands after the agent's
		// own system message. See contextRole — the safe role is the default one.
		const backend = createBackend();
		const { memory } = createMemory(backend);

		const variables = await memory.loadMemoryVariables({ input: 'when do we deploy?' });

		expect(backend.recall).toHaveBeenCalledWith('when do we deploy?');
		const messages = variables.chat_history as any[];
		expect(messages).toHaveLength(1);
		expect(messages[0]._getType()).toBe('human');
		expect(messages[0].content).toContain('- Deploys on Fridays');
	});

	it('can inject the context as a system message when asked to', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend, { contextRole: 'system' });

		const variables = await memory.loadMemoryVariables({ input: 'when do we deploy?' });
		const messages = variables.chat_history as any[];
		expect(messages).toHaveLength(1);
		expect(messages[0]._getType()).toBe('system');
		expect(messages[0].content).toContain('- Deploys on Fridays');
	});

	it('carries either role through the messages format too', async () => {
		const backend = createBackend({
			recall: vi.fn(async () => [hit('a', 'One'), hit('b', 'Two')]),
		});
		const { memory } = createMemory(backend, { contextFormat: 'messages' });
		const variables = await memory.loadMemoryVariables({ input: 'anything at all' });
		expect((variables.chat_history as any[]).map((m) => m._getType())).toEqual([
			'human',
			'human',
		]);

		const systemBackend = createBackend({
			recall: vi.fn(async () => [hit('a', 'One'), hit('b', 'Two')]),
		});
		const { memory: systemMemory } = createMemory(systemBackend, {
			contextRole: 'system',
			contextFormat: 'messages',
		});
		const systemVariables = await systemMemory.loadMemoryVariables({ input: 'anything at all' });
		expect((systemVariables.chat_history as any[]).map((m) => m._getType())).toEqual([
			'system',
			'system',
		]);
	});

	it('emits one message per fact in messages format', async () => {
		const backend = createBackend({
			recall: vi.fn(async () => [hit('a', 'One'), hit('b', 'Two')]),
		});
		const { memory } = createMemory(backend, { contextFormat: 'messages' });

		const variables = await memory.loadMemoryVariables({ input: 'anything at all' });
		const messages = variables.chat_history as any[];
		expect(messages.map((m) => m.content)).toEqual(['One', 'Two']);
	});

	it('renders a plain string when returnMessages is off', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend, { returnMessages: false });
		const variables = await memory.loadMemoryVariables({ input: 'deployments' });
		expect(typeof variables.chat_history).toBe('string');
		expect(variables.chat_history as string).toContain('Deploys on Fridays');
	});

	it('honours a custom memory key', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend, { memoryKey: 'cortadel_context' });
		expect(memory.memoryKeys).toEqual(['cortadel_context']);
		const variables = await memory.loadMemoryVariables({ input: 'deployments' });
		expect(Object.keys(variables)).toEqual(['cortadel_context']);
	});

	it('falls back to recent memories when the turn has no usable query', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		await memory.loadMemoryVariables({ input: 'hi' }); // shorter than minQueryLength
		expect(backend.recall).not.toHaveBeenCalled();
		expect(backend.recent).toHaveBeenCalledTimes(1);
	});

	it('returns nothing rather than an empty block when there are no hits', async () => {
		const backend = createBackend({ recall: vi.fn(async () => []) });
		const { memory } = createMemory(backend);
		const variables = await memory.loadMemoryVariables({ input: 'unknown topic' });
		expect(variables.chat_history).toEqual([]);
	});
});

describe('persist after the turn', () => {
	it('sends both turns to Cortadel', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		await memory.saveContext({ input: 'I deploy on Fridays' }, { output: 'Noted.' });

		expect(backend.persist).toHaveBeenCalledTimes(1);
		expect((backend as any).persisted[0]).toEqual([
			{ role: 'user', content: 'I deploy on Fridays' },
			{ role: 'assistant', content: 'Noted.' },
		]);
	});

	it('unwraps a structured agent output', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		await memory.saveContext({ input: 'hello' }, { output: { output: 'structured reply' } });
		expect((backend as any).persisted[0][1]).toEqual({
			role: 'assistant',
			content: 'structured reply',
		});
	});

	it('writes nothing when both sides of the turn are empty', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		await memory.saveContext({ input: '   ' }, { output: '' });
		expect(backend.persist).not.toHaveBeenCalled();
	});
});

describe('does not re-store or re-search the same thing', () => {
	it('writes an identical turn only once', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		await memory.saveContext({ input: 'same' }, { output: 'reply' });
		await memory.saveContext({ input: 'same' }, { output: 'reply' });
		await memory.saveContext({ input: 'different' }, { output: 'reply' });
		expect(backend.persist).toHaveBeenCalledTimes(2);
	});

	it('suppresses a repeat that is not immediately consecutive (A -> B -> A)', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		await memory.saveContext({ input: 'A' }, { output: 'reply A' });
		await memory.saveContext({ input: 'B' }, { output: 'reply B' });
		await memory.saveContext({ input: 'A' }, { output: 'reply A' });
		expect(backend.persist).toHaveBeenCalledTimes(2);
	});

	it('does not treat a shifted input/output split as the same turn', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		await memory.saveContext({ input: 'ab' }, { output: 'c' });
		await memory.saveContext({ input: 'a' }, { output: 'bc' });
		expect(backend.persist).toHaveBeenCalledTimes(2);
	});

	it('serves a repeated recall query from cache inside the TTL, and re-queries after it', async () => {
		let clock = 1_000;
		const backend = createBackend();
		const { memory } = createMemory(backend, {
			recallCacheTtlMs: 15_000,
			now: () => clock,
		});

		await memory.loadMemoryVariables({ input: 'deployment policy' });
		await memory.loadMemoryVariables({ input: 'Deployment Policy' }); // case-insensitive hit
		expect(backend.recall).toHaveBeenCalledTimes(1);

		clock += 20_000;
		await memory.loadMemoryVariables({ input: 'deployment policy' });
		expect(backend.recall).toHaveBeenCalledTimes(2);
	});

	it('can disable the recall cache entirely', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend, { recallCacheTtlMs: 0 });
		await memory.loadMemoryVariables({ input: 'deployment policy' });
		await memory.loadMemoryVariables({ input: 'deployment policy' });
		expect(backend.recall).toHaveBeenCalledTimes(2);
	});

	it('collapses duplicate hits by id and by text', () => {
		expect(
			dedupeHits([
				hit('a', 'One'),
				hit('a', 'One again under the same id'),
				hit('b', 'one'),
				hit('c', '   '),
				hit('d', 'Two'),
			]),
		).toEqual(['One', 'Two']);
	});

	it('routes chatHistory writes through the same guard as saveContext', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		await memory.saveContext({ input: 'hello' }, { output: 'hi' });
		await memory.chatHistory.addUserMessage('hello');
		await memory.chatHistory.addAIChatMessage('hi');
		expect(backend.persist).toHaveBeenCalledTimes(1);
	});
});

describe('degrades instead of breaking the agent', () => {
	it('returns empty context and warns when recall fails', async () => {
		const backend = createBackend({
			recall: vi.fn(async () => {
				throw new Error('ECONNREFUSED 127.0.0.1:3001');
			}),
		});
		const { memory, warnings } = createMemory(backend);

		const variables = await memory.loadMemoryVariables({ input: 'what do you know?' });
		expect(variables.chat_history).toEqual([]);
		expect(warnings.join()).toMatch(/recall failed/i);
	});

	it('swallows a persist failure', async () => {
		const backend = createBackend({
			persist: vi.fn(async () => {
				throw new Error('503 degraded');
			}),
		});
		const { memory, warnings } = createMemory(backend);
		await expect(memory.saveContext({ input: 'a' }, { output: 'b' })).resolves.toBeUndefined();
		expect(warnings.join()).toMatch(/persist failed/i);
	});
});

describe('clear() never deletes long-term memory', () => {
	it('only drops the local cache', async () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);

		await memory.loadMemoryVariables({ input: 'deployment policy' });
		await memory.clear();
		await memory.loadMemoryVariables({ input: 'deployment policy' });

		// Two searches, because the cache was dropped — and clear() reached the backend
		// for nothing else: no write, and no recent() either.
		expect(backend.recall).toHaveBeenCalledTimes(2);
		expect(backend.persist).not.toHaveBeenCalled();
		expect(backend.recent).not.toHaveBeenCalled();
	});

	it('exposes no delete-shaped method on the memory surface at all', () => {
		const backend = createBackend();
		const { memory } = createMemory(backend);
		const surface = [
			...Object.getOwnPropertyNames(memory),
			...Object.getOwnPropertyNames(Object.getPrototypeOf(memory)),
		];
		for (const forbidden of ['delete', 'deleteMemories', 'forget', 'purge']) {
			expect(surface).not.toContain(forbidden);
		}
	});
});

describe('message shim', () => {
	it('produces LangChain-shaped messages without any dependency', () => {
		const factory = createFallbackMessageFactory();
		expect(factory.human('a')._getType()).toBe('human');
		expect(factory.ai('b').getType()).toBe('ai');
		expect(factory.system('c').content).toBe('c');
	});

	it('renders the same buffer string LangChain would', () => {
		const factory = createFallbackMessageFactory();
		expect(toBufferString([factory.human('hi'), factory.ai('yo'), factory.system('note')])).toBe(
			'Human: hi\nAI: yo\nnote',
		);
	});

	it('coerces the shapes LangChain hands us', () => {
		expect(coerceText('plain')).toBe('plain');
		expect(coerceText({ output: 'wrapped' })).toBe('wrapped');
		expect(coerceText({ text: 'texty' })).toBe('texty');
		expect(coerceText(undefined)).toBe('');
		expect(coerceText(42)).toBe('42');
	});
});
