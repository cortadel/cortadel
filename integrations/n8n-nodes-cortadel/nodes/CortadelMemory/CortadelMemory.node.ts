import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { BackendTracer, CortadelBackendSettings } from '../../shared/backend';
import { createCortadelBackend } from '../../shared/backend';
import { CortadelChatMemory } from '../../shared/memory';
import { CORTADEL_CREDENTIALS } from '../../shared/transport';

/**
 * Surfaces each recall/persist as a sub-node run in the n8n UI, the way the built-in
 * memory nodes do through `logWrapper`. That helper lives in `@n8n/ai-utilities`,
 * which is internal to the n8n monorepo and unavailable to a community package, so
 * this calls `addInputData`/`addOutputData` directly — and swallows its own errors,
 * because tracing must never be able to break the agent.
 */
export function createTracer(ctx: ISupplyDataFunctions): BackendTracer {
	return async function trace(label, input, run, summarize) {
		let index: number | undefined;
		try {
			index = ctx.addInputData(NodeConnectionTypes.AiMemory, [
				[{ json: { action: label, ...input } as IDataObject }],
			]).index;
		} catch {
			index = undefined;
		}

		try {
			const result = await run();
			if (index !== undefined) {
				try {
					ctx.addOutputData(NodeConnectionTypes.AiMemory, index, [
						[{ json: { action: label, ...summarize(result) } as IDataObject }],
					]);
				} catch {
					// tracing is best-effort
				}
			}
			return result;
		} catch (error) {
			if (index !== undefined) {
				try {
					ctx.addOutputData(NodeConnectionTypes.AiMemory, index, [
						[
							{
								json: {
									action: label,
									error: error instanceof Error ? error.message : String(error),
								},
							},
						],
					]);
				} catch {
					// tracing is best-effort
				}
			}
			throw error;
		}
	};
}

function csv(value: unknown): string[] {
	if (typeof value !== 'string') return [];
	return value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export class CortadelMemory implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cortadel Memory',
		name: 'cortadelMemory',
		icon: 'file:cortadel.svg',
		iconColor: 'black',
		group: ['transform'],
		version: 1,
		description: 'Use Cortadel as long-term memory for an AI Agent',
		defaults: { name: 'Cortadel Memory' },
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Memory'],
				Memory: ['External memories'],
			},
			resources: {
				primaryDocumentation: [{ url: 'https://github.com/cortadel/cortadel' }],
			},
		},
		// A memory sub-node: no main input, one ai_memory output that plugs into the
		// AI Agent node's Memory port.
		inputs: [],
		outputs: [NodeConnectionTypes.AiMemory],
		outputNames: ['Memory'],
		credentials: [{ name: CORTADEL_CREDENTIALS, required: true }],
		properties: [
			{
				displayName:
					'Unlike a rolling chat buffer, this recalls facts from the whole of the user\'s Cortadel graph on every turn and writes the finished turn back for distillation. Memories survive the session.',
				name: 'cortadelNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				required: true,
				default: '={{ $json.userId ?? $json.sessionId }}',
				description:
					'The Cortadel user these memories belong to. Cortadel namespaces every memory to one user, so this — not the session — is the long-term identity that memories accumulate against.',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				required: true,
				default: '={{ $json.sessionId }}',
				description:
					'Groups this conversation. Stored facts are tagged with it, and it can also narrow recall — see Scope Recall to Session.',
			},
			{
				displayName: 'Scope Recall to Session',
				name: 'scopeRecallToSession',
				type: 'boolean',
				default: false,
				description:
					'Whether to recall only facts stored under this session ID. Off (the default) recalls across everything Cortadel knows about this user, which is the point of long-term memory; on makes this behave more like a conversation buffer.',
			},
			{
				displayName: 'Top K',
				name: 'topK',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 50 },
				default: 5,
				description: 'Max number of memories to inject into the agent context each turn',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Context Format',
						name: 'contextFormat',
						type: 'options',
						// Alphabetical, as n8n's node linter requires; `default` picks Single Block.
						options: [
							{
								name: 'One Message Per Fact',
								value: 'messages',
								description:
									'A separate message for each recalled fact. Not compatible with Context Role = System on Anthropic.',
							},
							{
								name: 'Single Block',
								value: 'block',
								description: 'One message listing every recalled fact',
							},
						],
						default: 'block',
						description: 'How recalled facts are shaped before they enter the prompt',
					},
					{
						displayName: 'Context Header',
						name: 'contextHeader',
						type: 'string',
						typeOptions: { rows: 2 },
						default: '',
						description:
							'Overrides the sentence placed above the recalled facts in single-block format',
					},
					{
						displayName: 'Context Role',
						name: 'contextRole',
						type: 'options',
						options: [
							{
								name: 'System',
								value: 'system',
								description:
									'Reads marginally better to OpenAI-style models. Throws on the Anthropic Chat Model — see the caveat.',
							},
							{
								name: 'User',
								value: 'user',
								description: 'Default. Accepted by every provider in any position.',
							},
						],
						default: 'user',
						description:
							'Role recalled memories are injected under. User is the default because it is the only role that cannot fail: Anthropic permits a system message in first position only, and recalled context always lands after the agent\'s own system message. Choose System if you are on an OpenAI-style model and want the context read as instructions.',
					},
					{
						displayName: 'Input Key',
						name: 'inputKey',
						type: 'string',
						default: 'input',
						description: "Key holding the user's turn in the values LangChain passes in",
					},
					{
						displayName: 'Memory Key',
						name: 'memoryKey',
						type: 'string',
						default: 'chat_history',
						description: 'Prompt variable the recalled context is written to',
					},
					{
						displayName: 'Memory Type',
						name: 'memoryType',
						type: 'options',
						options: [
							{ name: 'Any', value: '' },
							{ name: 'Episodic', value: 'episodic' },
							{ name: 'Procedural', value: 'procedural' },
							{ name: 'Semantic', value: 'semantic' },
						],
						default: '',
						description: 'Restrict recall to one cognitive type',
					},
					{
						displayName: 'Output Key',
						name: 'outputKey',
						type: 'string',
						default: 'output',
						description: "Key holding the model's turn in the values LangChain passes in",
					},
					{
						displayName: 'Persist Turns',
						name: 'persistTurns',
						type: 'boolean',
						default: true,
						description:
							'Whether to send each finished turn to Cortadel for fact extraction. Turn off for read-only memory.',
					},
					{
						displayName: 'Project',
						name: 'project',
						type: 'string',
						default: '',
						description: 'Project scope recorded on facts extracted from this conversation',
					},
					{
						displayName: 'Recall Cache TTL (Ms)',
						name: 'recallCacheTtlMs',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 15000,
						description:
							'How long an identical recall query is served from a local cache, so an agent tool loop cannot re-search the same thing repeatedly. Set to 0 to disable.',
					},
					{
						displayName: 'Rerank',
						name: 'rerank',
						type: 'boolean',
						default: false,
						description:
							'Whether to rerank recalled memories with the cross-encoder. Slower, and also enables the graph and session arms.',
					},
					{
						displayName: 'Return Messages',
						name: 'returnMessages',
						type: 'boolean',
						default: true,
						description:
							'Whether to hand the agent message objects rather than one rendered string',
					},
					{
						displayName: 'Search Mode',
						name: 'mode',
						type: 'options',
						options: [
							{ name: 'Hybrid', value: 'hybrid' },
							{ name: 'Text', value: 'text' },
							{ name: 'Vector', value: 'vector' },
						],
						default: 'hybrid',
						description: 'Which retrieval arms to fuse when recalling',
					},
					{
						displayName: 'Tags',
						name: 'tags',
						type: 'string',
						default: '',
						placeholder: 'support,billing',
						description: 'Comma-separated tags applied to every fact stored from this chat',
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const userId = String(this.getNodeParameter('userId', itemIndex, '') ?? '').trim();
		if (!userId) {
			throw new NodeOperationError(
				this.getNode(),
				'User ID is required — Cortadel namespaces every memory to exactly one user',
				{ itemIndex },
			);
		}

		const sessionId = String(this.getNodeParameter('sessionId', itemIndex, '') ?? '').trim();
		if (!sessionId) {
			throw new NodeOperationError(this.getNode(), 'Session ID is required', { itemIndex });
		}

		const scopeRecallToSession =
			this.getNodeParameter('scopeRecallToSession', itemIndex, false) === true;
		const topKRaw = this.getNodeParameter('topK', itemIndex, 5) as number;
		const topK = Math.max(1, Math.min(Math.floor(topKRaw) || 5, 50));
		const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;

		const settings: CortadelBackendSettings = {
			userId,
			sessionId,
			scopeRecallToSession,
			topK,
			mode: (options.mode as string) || 'hybrid',
			rerank: options.rerank === true ? 'cross_encoder' : undefined,
			memoryType: (options.memoryType as string) || undefined,
			project: (options.project as string) || undefined,
			tags: csv(options.tags),
			persistTurns: options.persistTurns !== false,
		};

		const backend = createCortadelBackend(this, settings, createTracer(this));

		const memory = new CortadelChatMemory({
			backend,
			memoryKey: (options.memoryKey as string) || 'chat_history',
			inputKey: (options.inputKey as string) || 'input',
			outputKey: (options.outputKey as string) || 'output',
			returnMessages: options.returnMessages !== false,
			contextFormat: (options.contextFormat as 'block' | 'messages') || 'block',
			contextRole: (options.contextRole as 'system' | 'user') || 'user',
			contextHeader: (options.contextHeader as string) || undefined,
			recallCacheTtlMs:
				typeof options.recallCacheTtlMs === 'number' ? options.recallCacheTtlMs : 15_000,
			logger: {
				warn: (message: string) => this.logger.warn(`[Cortadel Memory] ${message}`),
			},
		});

		return { response: memory };
	}
}
