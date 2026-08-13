import type { CortadelConversationMessage, CortadelSearchHit } from './types';

/**
 * A LangChain-shaped chat message, structurally typed so this package can ship with
 * **zero run-time dependencies** (n8n forbids them for verified community nodes).
 *
 * When the host n8n instance has the AI nodes installed, `@langchain/core/messages`
 * is resolvable at run time and {@link loadMessageFactory} upgrades to the real
 * `HumanMessage`/`AIMessage`/`SystemMessage` classes. The shim below is only the
 * fallback — but it has to be a *structurally complete* stand-in, not just
 * `content` + `_getType()`, and the reason is subtle:
 *
 * `@langchain/core`'s `coerceMessageLikeToMessage()` gates on
 * `isBaseMessage(m) === typeof m?._getType === "function"`
 * (`dist/messages/base.js`) and returns anything that passes **uncoerced**
 * (`dist/messages/utils.js`). So a shim is not normalised on its way to the model —
 * it reaches the provider's message converter verbatim, and those converters
 * dereference message fields without guards. `@langchain/openai`'s
 * `convertMessagesToCompletionsMessageParams` opens with
 * `"output_version" in message.response_metadata` and later reads
 * `message.additional_kwargs.function_call`
 * (`dist/converters/completions.js`) — both a `TypeError` on an object that
 * omits them.
 *
 * Hence the fields below. `test/message-compat.test.ts` pins this against the real
 * `@langchain/core`, `@langchain/openai` and `@langchain/anthropic` (dev-only), so
 * the claim is verified rather than asserted.
 */
export interface MinimalMessage {
	content: string;
	_getType(): string;
	getType(): string;
	/** Provider-extras bag. Read unguarded by provider converters — must exist. */
	additional_kwargs: Record<string, unknown>;
	/** Response-provenance bag. Read unguarded by provider converters — must exist. */
	response_metadata: Record<string, unknown>;
	/** Present on real `AIMessage`; harmlessly empty here. */
	tool_calls?: unknown[];
	name?: string;
	id?: string;
}

export interface MessageFactory {
	human(content: string): MinimalMessage;
	ai(content: string): MinimalMessage;
	system(content: string): MinimalMessage;
}

class ShimMessage implements MinimalMessage {
	readonly additional_kwargs: Record<string, unknown> = {};
	readonly response_metadata: Record<string, unknown> = {};
	readonly tool_calls: unknown[] = [];
	readonly name: string | undefined = undefined;
	readonly id: string | undefined = undefined;

	constructor(
		public readonly content: string,
		private readonly type: string,
	) {}

	_getType(): string {
		return this.type;
	}

	getType(): string {
		return this.type;
	}
}

/** The dependency-free message factory. Always available. */
export function createFallbackMessageFactory(): MessageFactory {
	return {
		human: (content) => new ShimMessage(content, 'human'),
		ai: (content) => new ShimMessage(content, 'ai'),
		system: (content) => new ShimMessage(content, 'system'),
	};
}

let messageFactoryPromise: Promise<MessageFactory> | undefined;

/**
 * Prefers the host's own `@langchain/core/messages` so the objects we hand the agent
 * are genuine LangChain messages; falls back to the shim when it is not resolvable.
 * Never rejects, and the resolved factory is cached for the process.
 */
export function loadMessageFactory(): Promise<MessageFactory> {
	if (messageFactoryPromise === undefined) {
		messageFactoryPromise = (async () => {
			try {
				// Indirect specifier: this module is an optional *host* capability, not a
				// dependency of this package, so it must not be resolved at compile time.
				const specifier = '@langchain/core/messages';
				const mod = (await import(specifier)) as {
					HumanMessage: new (content: string) => MinimalMessage;
					AIMessage: new (content: string) => MinimalMessage;
					SystemMessage: new (content: string) => MinimalMessage;
				};
				if (!mod?.HumanMessage || !mod?.AIMessage || !mod?.SystemMessage) {
					return createFallbackMessageFactory();
				}
				return {
					human: (content: string) => new mod.HumanMessage(content),
					ai: (content: string) => new mod.AIMessage(content),
					system: (content: string) => new mod.SystemMessage(content),
				};
			} catch {
				return createFallbackMessageFactory();
			}
		})();
	}
	return messageFactoryPromise;
}

/** Test seam: forces the next {@link loadMessageFactory} call to resolve afresh. */
export function resetMessageFactoryCache(): void {
	messageFactoryPromise = undefined;
}

/** Renders messages the way LangChain's `getBufferString` does, for string-mode memory. */
export function toBufferString(messages: MinimalMessage[]): string {
	return messages
		.map((message) => {
			const type = message._getType();
			if (type === 'human') return `Human: ${message.content}`;
			if (type === 'ai') return `AI: ${message.content}`;
			return message.content;
		})
		.join('\n');
}

/** The four Cortadel calls the memory needs, injected so tests never touch HTTP. */
export interface CortadelMemoryBackend {
	/** Hybrid search for memories relevant to the current turn. */
	recall(query: string): Promise<CortadelSearchHit[]>;
	/** Fallback when the turn carries no usable query text. */
	recent(): Promise<CortadelSearchHit[]>;
	/** Distils and stores the finished turn. */
	persist(messages: CortadelConversationMessage[]): Promise<void>;
}

export interface CortadelMemoryLogger {
	warn(message: string): void;
}

export interface CortadelMemoryConfig {
	backend: CortadelMemoryBackend;
	/** Variable the agent reads recalled context from. LangChain's default is `chat_history`. */
	memoryKey?: string;
	/** Key of the user's turn inside the values LangChain hands us. */
	inputKey?: string;
	/** Key of the model's turn inside the values LangChain hands us. */
	outputKey?: string;
	/** `true` → message objects, `false` → a single rendered string. */
	returnMessages?: boolean;
	/** `block` folds every recalled fact into one message; `messages` emits one each. */
	contextFormat?: 'block' | 'messages';
	/**
	 * Role the recalled context is injected under. **Defaults to `user`**, which every
	 * provider accepts in every position.
	 *
	 * `system` reads marginally better to most models, but it is not safe as a default,
	 * because **Anthropic rejects a system message anywhere except position 0**:
	 * `@langchain/anthropic`'s `_convertMessagesToAnthropicPayload` lifts `messages[0]`
	 * into the API's `system` field and then throws `System messages are only permitted
	 * as the first passed message.` for any later one. n8n's agent prompt is
	 * `[system?, ...chat_history, human]` (`ToolsAgent` `prepareMessages`), so anything
	 * we put in `chat_history` is at index ≥ 1 whenever the agent's own System Message
	 * option is set — and `contextFormat: 'messages'` produces several regardless.
	 *
	 * That is a hard failure of the whole agent run, which would contradict this class's
	 * first guarantee (memory degrades, it never breaks the agent) on nothing worse than
	 * a provider swap. So the default is the role that cannot throw; `system` stays
	 * available, and is a sound choice on OpenAI-style providers.
	 */
	contextRole?: 'system' | 'user';
	/** Heading placed above the recalled facts in `block` format. */
	contextHeader?: string;
	/** Queries shorter than this skip recall entirely. */
	minQueryLength?: number;
	/** How long an identical recall query is served from cache. `0` disables the cache. */
	recallCacheTtlMs?: number;
	logger?: CortadelMemoryLogger;
	messageFactory?: MessageFactory;
	now?: () => number;
}

const DEFAULT_HEADER =
	'Relevant long-term memories recalled from Cortadel. Treat them as background knowledge about the user, not as things the user just said.';

const RECALL_CACHE_MAX_ENTRIES = 32;
const PERSIST_FINGERPRINT_MAX_ENTRIES = 64;

/** Best-effort extraction of turn text from whatever LangChain hands us. */
export function coerceText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return '';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		for (const key of ['output', 'text', 'content', 'input']) {
			if (typeof record[key] === 'string') return record[key] as string;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return '';
		}
	}
	return '';
}

/**
 * Cortadel as an n8n `ai_memory` provider.
 *
 * This is deliberately **not** a rolling chat buffer. Every turn it runs a fresh
 * hybrid search against the user's whole Cortadel graph and injects the facts that
 * are relevant *now*; after the turn it hands the exchange to Cortadel's extraction
 * pipeline, which distils durable facts out of it. That is the difference between a
 * window of the last N messages and memory that survives the session.
 *
 * Three properties matter more than the feature list:
 *
 * 1. **It never takes the agent down.** Every Cortadel call is wrapped; a failed
 *    recall yields empty context and a warning, a failed persist is swallowed. An
 *    unreachable memory server degrades the agent, it does not break it. The same
 *    rule picks the default {@link CortadelMemoryConfig.contextRole}: `user`, the one
 *    role no provider can reject, rather than the one that throws on Anthropic.
 * 2. **It does not thrash the server.** Identical recall queries inside one turn are
 *    served from a short-lived cache, and an identical (input, output) pair is never
 *    written twice by the same instance — which together stop the agent's own tool
 *    loop from re-searching and re-storing the same turn.
 * 3. **`clear()` does not delete anything.** Clearing an n8n chat window drops the
 *    local recall cache only. Long-term memory is not a UI affordance to wipe.
 */
export class CortadelChatMemory {
	readonly memoryKey: string;
	readonly inputKey: string;
	readonly outputKey: string;
	readonly returnMessages: boolean;

	private readonly backend: CortadelMemoryBackend;
	private readonly contextFormat: 'block' | 'messages';
	private readonly contextRole: 'system' | 'user';
	private readonly contextHeader: string;
	private readonly minQueryLength: number;
	private readonly recallCacheTtlMs: number;
	private readonly logger?: CortadelMemoryLogger;
	private readonly injectedFactory?: MessageFactory;
	private readonly now: () => number;

	private readonly recallCache = new Map<string, { at: number; hits: CortadelSearchHit[] }>();
	/**
	 * Every `(input, output)` pair already written by this instance, not just the
	 * previous one — an A → B → A tool loop must not store A twice. Bounded and
	 * FIFO-evicted so a long conversation cannot grow it without limit.
	 */
	private readonly persistedFingerprints = new Set<string>();
	private lastLoadedMessages: MinimalMessage[] = [];
	private pendingHuman?: string;
	private pendingAi?: string;

	constructor(config: CortadelMemoryConfig) {
		this.backend = config.backend;
		this.memoryKey = config.memoryKey ?? 'chat_history';
		this.inputKey = config.inputKey ?? 'input';
		this.outputKey = config.outputKey ?? 'output';
		this.returnMessages = config.returnMessages ?? true;
		this.contextFormat = config.contextFormat ?? 'block';
		// `user`, not `system`: see CortadelMemoryConfig.contextRole — a system-role
		// injection is a hard throw on Anthropic, and "never breaks the agent" has to
		// hold for the configuration a user gets without choosing anything.
		this.contextRole = config.contextRole ?? 'user';
		this.contextHeader = config.contextHeader ?? DEFAULT_HEADER;
		this.minQueryLength = config.minQueryLength ?? 3;
		this.recallCacheTtlMs = config.recallCacheTtlMs ?? 15_000;
		this.logger = config.logger;
		this.injectedFactory = config.messageFactory;
		this.now = config.now ?? (() => Date.now());
	}

	/** LangChain reads this to know which prompt variable the memory fills. */
	get memoryKeys(): string[] {
		return [this.memoryKey];
	}

	/**
	 * Minimal `BaseChatMessageHistory` surface. n8n and some LangChain code paths
	 * reach for `memory.chatHistory` directly instead of going through
	 * `loadMemoryVariables`/`saveContext`; the writes funnel into the same
	 * fingerprinted persist path, so nothing can be stored twice.
	 */
	get chatHistory() {
		return {
			getMessages: async (): Promise<MinimalMessage[]> => this.lastLoadedMessages,
			addMessage: async (message: MinimalMessage): Promise<void> => {
				const type = typeof message?._getType === 'function' ? message._getType() : 'human';
				if (type === 'ai') await this.addAIChatMessage(message.content);
				else await this.addUserMessage(message.content);
			},
			addUserMessage: async (text: string): Promise<void> => this.addUserMessage(text),
			addAIChatMessage: async (text: string): Promise<void> => this.addAIChatMessage(text),
			clear: async (): Promise<void> => this.clear(),
		};
	}

	/**
	 * Before the model call: search Cortadel and inject what is relevant to this turn.
	 *
	 * **Host caveat.** `values` is only populated on the non-streaming path, where
	 * LangChain's `BaseChain._formatValues` passes the real chain inputs through. n8n's
	 * *streaming* agent branch calls `memory.loadMemoryVariables({})` with a literally
	 * empty object (`utils/agent-execution/memoryManagement.ts` `loadMemory()`), and
	 * `AgentExecutor`'s stream iterator never re-runs `_formatValues`. There is no turn
	 * text to search with, so this falls back to {@link CortadelMemoryBackend.recent} —
	 * the newest N memories rather than the ones relevant to what was just said.
	 * Nothing here can recover the input; it is not passed to us. See the README.
	 */
	async loadMemoryVariables(values?: Record<string, unknown>): Promise<Record<string, unknown>> {
		const query = coerceText(values?.[this.inputKey]).trim();
		let hits: CortadelSearchHit[] = [];

		try {
			hits =
				query.length >= this.minQueryLength
					? await this.cachedRecall(query)
					: await this.backend.recent();
		} catch (error) {
			// Memory must degrade, never break the agent.
			this.logger?.warn(
				`Cortadel recall failed, continuing without long-term memory: ${describe(error)}`,
			);
			hits = [];
		}

		const messages = await this.renderHits(hits);
		this.lastLoadedMessages = messages;

		return {
			[this.memoryKey]: this.returnMessages ? messages : toBufferString(messages),
		};
	}

	/** After the turn: hand the exchange to Cortadel's extraction pipeline. */
	async saveContext(
		inputValues?: Record<string, unknown>,
		outputValues?: Record<string, unknown>,
	): Promise<void> {
		const input = coerceText(inputValues?.[this.inputKey]).trim();
		const output = coerceText(outputValues?.[this.outputKey]).trim();
		await this.persistPair(input, output);
	}

	/**
	 * Drops the local recall cache. It deliberately does **not** delete memories:
	 * clearing an n8n chat window must not destroy a user's long-term memory. Use the
	 * Cortadel node's Delete operation for that, explicitly.
	 */
	async clear(): Promise<void> {
		this.recallCache.clear();
		this.lastLoadedMessages = [];
		this.persistedFingerprints.clear();
		this.pendingHuman = undefined;
		this.pendingAi = undefined;
	}

	private async addUserMessage(text: string): Promise<void> {
		this.pendingHuman = coerceText(text).trim();
		await this.flushPending();
	}

	private async addAIChatMessage(text: string): Promise<void> {
		this.pendingAi = coerceText(text).trim();
		await this.flushPending();
	}

	private async flushPending(): Promise<void> {
		if (!this.pendingHuman && !this.pendingAi) return;
		if (this.pendingHuman && this.pendingAi === undefined) return;
		const input = this.pendingHuman ?? '';
		const output = this.pendingAi ?? '';
		this.pendingHuman = undefined;
		this.pendingAi = undefined;
		await this.persistPair(input, output);
	}

	private async persistPair(input: string, output: string): Promise<void> {
		const messages: CortadelConversationMessage[] = [];
		if (input) messages.push({ role: 'user', content: input });
		if (output) messages.push({ role: 'assistant', content: output });
		if (messages.length === 0) return;

		// Guard against the same turn being handed to us twice (agent retries, a tool
		// loop re-entering the chain, or chatHistory and saveContext both firing).
		const fingerprint = `${input}\u0000${output}`;
		// Set-backed rather than last-value-only, so a non-consecutive repeat
		// (A -> B -> A, which an agent tool loop produces routinely) is suppressed too.
		if (this.persistedFingerprints.has(fingerprint)) return;
		this.persistedFingerprints.add(fingerprint);
		if (this.persistedFingerprints.size > PERSIST_FINGERPRINT_MAX_ENTRIES) {
			const oldest = this.persistedFingerprints.values().next();
			if (!oldest.done) this.persistedFingerprints.delete(oldest.value);
		}

		try {
			await this.backend.persist(messages);
		} catch (error) {
			this.logger?.warn(`Cortadel persist failed, turn not stored: ${describe(error)}`);
		}
	}

	private async cachedRecall(query: string): Promise<CortadelSearchHit[]> {
		if (this.recallCacheTtlMs <= 0) return await this.backend.recall(query);

		const key = query.toLowerCase();
		const cached = this.recallCache.get(key);
		const now = this.now();
		if (cached && now - cached.at < this.recallCacheTtlMs) return cached.hits;

		const hits = await this.backend.recall(query);
		this.recallCache.set(key, { at: now, hits });
		if (this.recallCache.size > RECALL_CACHE_MAX_ENTRIES) {
			const oldest = this.recallCache.keys().next();
			if (!oldest.done) this.recallCache.delete(oldest.value);
		}
		return hits;
	}

	private async renderHits(hits: CortadelSearchHit[]): Promise<MinimalMessage[]> {
		const factory = this.injectedFactory ?? (await loadMessageFactory());
		const facts = dedupeHits(hits);
		if (facts.length === 0) return [];

		// See CortadelMemoryConfig.contextRole for why the default is `user` and why
		// `system` is still offered.
		// Called through the factory rather than detached, so a factory whose members
		// are methods rather than arrows still works.
		const render = (text: string): MinimalMessage =>
			this.contextRole === 'user' ? factory.human(text) : factory.system(text);

		if (this.contextFormat === 'messages') {
			return facts.map((fact) => render(fact));
		}
		return [render(`${this.contextHeader}\n${facts.map((f) => `- ${f}`).join('\n')}`)];
	}
}

/** Collapses hits that repeat an id or the exact same text, preserving rank order. */
export function dedupeHits(hits: CortadelSearchHit[]): string[] {
	const seenIds = new Set<string>();
	const seenText = new Set<string>();
	const out: string[] = [];
	for (const hit of hits ?? []) {
		const text = (hit?.content ?? hit?.gist ?? '').trim();
		if (!text) continue;
		const id = hit?.id ?? undefined;
		if (id && seenIds.has(id)) continue;
		const textKey = text.toLowerCase();
		if (seenText.has(textKey)) continue;
		if (id) seenIds.add(id);
		seenText.add(textKey);
		out.push(text);
	}
	return out;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
