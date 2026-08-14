import { beforeEach, describe, expect, it } from 'vitest';

import type { MessageFactory } from '../shared/memory';
import {
	CortadelChatMemory,
	createFallbackMessageFactory,
	loadMessageFactory,
	resetMessageFactoryCache,
} from '../shared/memory';

/**
 * The one branch every other test file misses: what happens when
 * `@langchain/core` really is resolvable, and what happens to our dependency-free
 * shim once a real provider gets hold of it.
 *
 * `@langchain/core` and `@langchain/openai` are **devDependencies only** — this
 * package still ships with zero run-time dependencies (`package.json` has no
 * `dependencies`, and `files` publishes `dist` alone). They are here so the claim
 * "the shim is a structurally valid BaseMessage" is verified against the real
 * library instead of asserted in a comment.
 *
 * Why it matters, in the library's own words:
 *
 * - `@langchain/core` `dist/messages/base.js`:
 *   `isBaseMessage(m) => typeof m?._getType === "function"`
 * - `@langchain/core` `dist/messages/utils.js` `coerceMessageLikeToMessage`:
 *   `else if (isBaseMessage(messageLike)) return messageLike;`
 *
 * So a shim is **not** normalised on its way to the model — it is handed to the
 * provider verbatim. And `@langchain/openai` `dist/converters/completions.js`
 * opens `convertMessagesToCompletionsMessageParams` with
 * `"output_version" in message.response_metadata`, then later reads
 * `message.additional_kwargs.function_call`. A shim missing either field is a
 * `TypeError` on the first model call.
 */

type LangChainMessages = typeof import('@langchain/core/messages');
type LangChainOpenAI = typeof import('@langchain/openai');
type LangChainAnthropic = typeof import('@langchain/anthropic');
type LangChainPromptValues = typeof import('@langchain/core/prompt_values');

let core: LangChainMessages | undefined;
let openai: LangChainOpenAI | undefined;
let anthropic: LangChainAnthropic | undefined;
let promptValues: LangChainPromptValues | undefined;

try {
	core = await import('@langchain/core/messages');
	openai = await import('@langchain/openai');
	anthropic = await import('@langchain/anthropic');
	promptValues = await import('@langchain/core/prompt_values');
} catch {
	// Left undefined; the suites below skip and say so.
}

const hasLangChain = core !== undefined && openai !== undefined;
const hasAnthropic = hasLangChain && anthropic !== undefined && promptValues !== undefined;

describe.skipIf(!hasLangChain)('the real @langchain/core branch of loadMessageFactory', () => {
	beforeEach(() => {
		resetMessageFactoryCache();
	});

	it('resolves the host LangChain classes rather than the shim', async () => {
		const factory = await loadMessageFactory();
		const human = factory.human('hello');
		const ai = factory.ai('hi');
		const system = factory.system('note');

		expect(human).toBeInstanceOf(core!.HumanMessage);
		expect(ai).toBeInstanceOf(core!.AIMessage);
		expect(system).toBeInstanceOf(core!.SystemMessage);
		expect(system.content).toBe('note');
	});

	it('caches the resolved factory for the process', async () => {
		const first = await loadMessageFactory();
		const second = await loadMessageFactory();
		expect(second).toBe(first);
	});
});

describe.skipIf(!hasLangChain)('the dependency-free shim is a usable BaseMessage', () => {
	const factories: Array<[string, () => MessageFactory]> = [
		['shim', createFallbackMessageFactory],
		['real @langchain/core', () => ({
			human: (c: string) => new core!.HumanMessage(c) as never,
			ai: (c: string) => new core!.AIMessage(c) as never,
			system: (c: string) => new core!.SystemMessage(c) as never,
		})],
	];

	it('passes isBaseMessage, so it is returned from coercion untouched', () => {
		const shim = createFallbackMessageFactory().system('recalled fact');
		// This is the gate that makes the missing-fields bug reachable: the shim is
		// NOT converted into a real SystemMessage, it is passed straight through.
		expect(core!.coerceMessageLikeToMessage(shim as never)).toBe(shim);
	});

	it('carries the fields provider converters dereference without a guard', () => {
		for (const make of [
			createFallbackMessageFactory().human,
			createFallbackMessageFactory().ai,
			createFallbackMessageFactory().system,
		]) {
			const message = make('x');
			expect(message.response_metadata).toEqual({});
			expect(message.additional_kwargs).toEqual({});
			expect('output_version' in message.response_metadata).toBe(false);
			expect(message.additional_kwargs.function_call).toBeUndefined();
		}
	});

	for (const [label, makeFactory] of factories) {
		it(`survives the real OpenAI message converter (${label})`, () => {
			const factory = makeFactory();
			const messages = [
				factory.system('Relevant long-term memories recalled from Cortadel.'),
				factory.human('when do we deploy?'),
				factory.ai('Fridays.'),
			].map((m) => core!.coerceMessageLikeToMessage(m as never));

			const params = openai!.convertMessagesToCompletionsMessageParams({
				messages,
				model: 'gpt-4o-mini',
			});

			expect(params.map((p) => p.role)).toEqual(['system', 'user', 'assistant']);
			expect(params.map((p) => p.content)).toEqual([
				'Relevant long-term memories recalled from Cortadel.',
				'when do we deploy?',
				'Fridays.',
			]);
		});
	}

	it('converts to exactly what a real SystemMessage converts to', () => {
		const text = 'Relevant long-term memories recalled from Cortadel.';
		const fromShim = openai!.convertMessagesToCompletionsMessageParams({
			messages: [core!.coerceMessageLikeToMessage(createFallbackMessageFactory().system(text) as never)],
			model: 'gpt-4o-mini',
		});
		const fromReal = openai!.convertMessagesToCompletionsMessageParams({
			messages: [new core!.SystemMessage(text)],
			model: 'gpt-4o-mini',
		});
		expect(fromShim).toEqual(fromReal);
	});
});

describe.skipIf(!hasAnthropic)('Anthropic only accepts a system message in first position', () => {
	// `_convertMessagesToAnthropicPayload` lifts messages[0] into the API's single
	// `system` field and throws for any later system message. n8n's agent prompt is
	// [system?, ...chat_history, human] (ToolsAgent -> prepareMessages), so recalled
	// context sits at index >= 1 whenever the agent's System Message option is set.
	const toPayload = (messages: unknown[]) =>
		anthropic!.convertPromptToAnthropic(
			new promptValues!.ChatPromptValue(messages as never),
		);

	const agentSystemPrompt = () => new core!.SystemMessage('You are a helpful assistant.');
	const userTurn = () => new core!.HumanMessage('when do we deploy?');

	it('rejects system-role context once the agent has its own system message', () => {
		const context = createFallbackMessageFactory().system('Relevant long-term memories...');
		expect(() => toPayload([agentSystemPrompt(), context, userTurn()])).toThrow(
			/System messages are only permitted as the first passed message/,
		);
	});

	it('rejects a second system-role fact even with no agent system message', () => {
		const factory = createFallbackMessageFactory();
		expect(() =>
			toPayload([factory.system('memory A'), factory.system('memory B'), userTurn()]),
		).toThrow(/System messages are only permitted as the first passed message/);
	});

	it('accepts system-role context when it really is first (the one safe case)', () => {
		const context = createFallbackMessageFactory().system('Relevant long-term memories...');
		const payload = toPayload([context, userTurn()]);
		expect(payload.system).toBe('Relevant long-term memories...');
		expect(payload.messages.map((m) => m.role)).toEqual(['user']);
	});

	it('accepts the default user-role context in every position — which is why it is the default', async () => {
		const memory = new CortadelChatMemory({
			// No contextRole: this is the out-of-the-box configuration, and it is the
			// case that used to throw here before the default was flipped to `user`.
			messageFactory: createFallbackMessageFactory(),
			backend: {
				recall: async () => [{ id: 'e2e-m1', content: 'Deploys on Fridays' }],
				recent: async () => [],
				persist: async () => undefined,
			},
		});
		const variables = await memory.loadMemoryVariables({ input: 'when do we deploy?' });
		const context = (variables.chat_history as unknown[])[0];

		const payload = toPayload([agentSystemPrompt(), context, userTurn()]);
		expect(payload.system).toBe('You are a helpful assistant.');
		expect(payload.messages.map((m) => m.role)).toEqual(['user', 'user']);
	});

	it('still throws for the opt-in system role, so the caveat is real and pinned', async () => {
		const memory = new CortadelChatMemory({
			contextRole: 'system',
			messageFactory: createFallbackMessageFactory(),
			backend: {
				recall: async () => [{ id: 'e2e-m1', content: 'Deploys on Fridays' }],
				recent: async () => [],
				persist: async () => undefined,
			},
		});
		const variables = await memory.loadMemoryVariables({ input: 'when do we deploy?' });
		const context = (variables.chat_history as unknown[])[0];

		expect(() => toPayload([agentSystemPrompt(), context, userTurn()])).toThrow(
			/System messages are only permitted as the first passed message/,
		);
	});
});

describe.skipIf(!hasLangChain)('end to end: recalled memories reach a provider intact', () => {
	const recallingMemory = (contextRole?: 'system' | 'user') =>
		new CortadelChatMemory({
			// Forced onto the shim, i.e. the sandboxed-host fallback this package
			// advertises as safe. Before the fix this threw a TypeError here.
			messageFactory: createFallbackMessageFactory(),
			...(contextRole ? { contextRole } : {}),
			backend: {
				recall: async () => [
					{ id: 'e2e-m1', content: 'Deploys on Fridays' },
					{ id: 'e2e-m2', content: 'Prefers Postgres' },
				],
				recent: async () => [],
				persist: async () => undefined,
			},
		});

	// Both roles, through the real OpenAI converter: the default must work, and so must
	// the option a user picks deliberately.
	for (const [label, contextRole, expectedRole] of [
		['the default role', undefined, 'user'],
		['the opt-in system role', 'system', 'system'],
	] as Array<[string, 'system' | 'user' | undefined, string]>) {
		it(`renders hits through the shim and hands them to the converter (${label})`, async () => {
			const memory = recallingMemory(contextRole);

			const variables = await memory.loadMemoryVariables({ input: 'when do we deploy?' });
			const injected = variables.chat_history as unknown[];
			expect(injected).toHaveLength(1);

			const params = openai!.convertMessagesToCompletionsMessageParams({
				messages: injected.map((m) => core!.coerceMessageLikeToMessage(m as never)),
				model: 'gpt-4o-mini',
			});

			expect(params).toHaveLength(1);
			expect(params[0].role).toBe(expectedRole);
			expect(String(params[0].content)).toContain('- Deploys on Fridays');
			expect(String(params[0].content)).toContain('- Prefers Postgres');
		});
	}
});
