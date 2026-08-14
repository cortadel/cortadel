import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	CORTADEL_APP_NAME,
	CORTADEL_CREDENTIALS,
	compact,
	cortadelRequest,
} from '../../shared/transport';
import type {
	AddConversationRequest,
	ConversationIngestResponse,
	CortadelConversationMessage,
	CreateMemoryRequest,
	DeleteMemoriesRequest,
	DeleteMemoriesResponse,
	MemoryCreatedResponse,
	MemoryDetailResponse,
	MemoryListPagedResponse,
	SearchMemoriesRequest,
	SearchResponse,
} from '../../shared/types';
import { cortadelNodeProperties } from './CortadelDescription';

/** Splits a comma-separated parameter into trimmed, non-empty values. */
export function parseCsv(value: string): string[] {
	if (typeof value !== 'string') return [];
	return value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** Parses a `json`-typed parameter that n8n may hand back as a string or an object. */
export function parseJsonParameter(value: unknown, what: string): unknown {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`${what} is not valid JSON`);
	}
}

/** Normalises the `addConversation` turns from either input mode into wire shape. */
export function toConversationMessages(raw: unknown): CortadelConversationMessage[] {
	if (!Array.isArray(raw)) return [];
	const out: CortadelConversationMessage[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== 'object') continue;
		const item = entry as Record<string, unknown>;
		const role = typeof item.role === 'string' && item.role.trim() ? item.role.trim() : 'user';
		const content = typeof item.content === 'string' ? item.content : '';
		if (!content.trim()) continue;
		const message: CortadelConversationMessage = { role, content };
		if (typeof item.uuid === 'string' && item.uuid.trim()) message.uuid = item.uuid.trim();
		out.push(message);
	}
	return out;
}

export class Cortadel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cortadel',
		name: 'cortadel',
		icon: 'file:cortadel.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Read and write long-term memories in Cortadel',
		defaults: { name: 'Cortadel' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		// Lets n8n wrap every operation as a callable tool for the AI Agent node,
		// so an agent can search and write its own memories.
		usableAsTool: true,
		credentials: [{ name: CORTADEL_CREDENTIALS, required: true }],
		properties: cortadelNodeProperties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const userId = (this.getNodeParameter('userId', i) as string)?.trim();
				if (!userId) {
					throw new NodeOperationError(
						this.getNode(),
						'User ID is required — every Cortadel memory is namespaced to exactly one user',
						{ itemIndex: i },
					);
				}

				const pushed = await runOperation(this, operation, userId, i);
				for (const json of pushed) {
					returnData.push({ json, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}

/**
 * One handler per `operation`, so each stays small enough to read whole. They take the
 * execution context explicitly rather than via `this`, which keeps the dispatch table
 * below plainly typed.
 */
type OperationHandler = (
	ctx: IExecuteFunctions,
	userId: string,
	itemIndex: number,
) => Promise<IDataObject[]>;

/** Query string shared by both list paths. */
type ListQuery = Record<string, string | number | boolean | undefined>;

async function runAdd(
	ctx: IExecuteFunctions,
	userId: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const extra = ctx.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	const metadata = parseJsonParameter(extra.metadata, 'Metadata (JSON)');
	const body = compact({
		user_id: userId,
		text: ctx.getNodeParameter('text', itemIndex) as string,
		app: (extra.app as string) ?? CORTADEL_APP_NAME,
		infer: extra.infer as boolean | undefined,
		memory_type: extra.memoryType as string | undefined,
		metadata: metadata as Record<string, unknown> | undefined,
	}) as unknown as CreateMemoryRequest;

	const created = await cortadelRequest<MemoryCreatedResponse>(ctx, {
		method: 'POST',
		url: '/api/v1/memories',
		body,
	});
	return [created as unknown as IDataObject];
}

/** Reads the turns from whichever of the two input modes the user picked. */
function readConversationTurns(ctx: IExecuteFunctions, itemIndex: number): unknown {
	const inputMode = ctx.getNodeParameter('inputMode', itemIndex, 'fields') as string;
	if (inputMode === 'json') {
		return parseJsonParameter(
			ctx.getNodeParameter('messagesJson', itemIndex, '[]'),
			'Messages (JSON)',
		);
	}
	const collection = ctx.getNodeParameter('messages', itemIndex, {}) as IDataObject;
	return (collection.message as IDataObject[]) ?? [];
}

async function runAddConversation(
	ctx: IExecuteFunctions,
	userId: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const messages = toConversationMessages(readConversationTurns(ctx, itemIndex));
	if (messages.length === 0) {
		throw new NodeOperationError(
			ctx.getNode(),
			'At least one non-empty conversation message is required',
			{ itemIndex },
		);
	}

	const extra = ctx.getNodeParameter('conversationFields', itemIndex, {}) as IDataObject;
	const body = compact({
		user_id: userId,
		messages,
		is_agent_memory: extra.isAgentMemory as boolean | undefined,
		project: extra.project as string | undefined,
		session_id: extra.sessionId as string | undefined,
		tags: parseCsv((extra.tags as string) ?? ''),
	}) as unknown as AddConversationRequest;

	const result = await cortadelRequest<ConversationIngestResponse>(ctx, {
		method: 'POST',
		url: '/api/v1/memories/from-conversation',
		body,
	});
	// `results` and `no_facts_extracted` are mutually exclusive on the wire.
	if (Array.isArray(result?.results) && result.results.length > 0) {
		return result.results as unknown as IDataObject[];
	}
	return [{ no_facts_extracted: result?.no_facts_extracted ?? true }];
}

async function runSearch(
	ctx: IExecuteFunctions,
	userId: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const options = ctx.getNodeParameter('searchOptions', itemIndex, {}) as IDataObject;
	const body = compact({
		user_id: userId,
		query: ctx.getNodeParameter('query', itemIndex) as string,
		top_k: (options.topK as number) ?? 10,
		mode: (options.mode as string) ?? 'hybrid',
		session_id: options.sessionId as string | undefined,
		// The contract accepts exactly one rerank strategy; anything else silently no-ops.
		rerank: options.rerank === true ? 'cross_encoder' : undefined,
		memory_type: options.memoryType as string | undefined,
		app_name: CORTADEL_APP_NAME,
	}) as unknown as SearchMemoriesRequest;

	const response = await cortadelRequest<SearchResponse>(ctx, {
		method: 'POST',
		url: '/api/v1/memories/search',
		body,
	});

	const simplify = ctx.getNodeParameter('simplify', itemIndex, true) as boolean;
	if (!simplify) return [response as unknown as IDataObject];
	const hits = response?.results ?? [];
	return hits.length > 0 ? (hits as unknown as IDataObject[]) : [];
}

/** Walks every page of the list route, 100 at a time. */
async function collectAllListPages(
	ctx: IExecuteFunctions,
	baseQs: ListQuery,
): Promise<IDataObject[]> {
	const collected: IDataObject[] = [];
	let page = 1;
	// Guard against a server that reports pages inconsistently.
	for (let guard = 0; guard < 1000; guard++) {
		const response = await cortadelRequest<MemoryListPagedResponse>(ctx, {
			method: 'GET',
			url: '/api/v1/memories',
			qs: { ...baseQs, page, size: 100 },
		});
		const pageItems = (response?.items ?? []) as unknown as IDataObject[];
		collected.push(...pageItems);
		const totalPages = response?.pages ?? 0;
		if (pageItems.length === 0 || page >= totalPages) break;
		page += 1;
	}
	return collected;
}

async function runList(
	ctx: IExecuteFunctions,
	userId: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const options = ctx.getNodeParameter('listOptions', itemIndex, {}) as IDataObject;
	const returnAll = ctx.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = ctx.getNodeParameter('limit', itemIndex, 20) as number;

	const baseQs: ListQuery = {
		user_id: userId,
		app_id: options.appId as string | undefined,
		categories: options.categories as string | undefined,
		search_query: options.searchQuery as string | undefined,
		memory_type: options.memoryType as string | undefined,
		// The wire takes this flag as a *string*, not a boolean.
		include_superseded: options.includeSuperseded === true ? 'true' : undefined,
	};

	if (returnAll) return await collectAllListPages(ctx, baseQs);

	const page = await cortadelRequest<MemoryListPagedResponse>(ctx, {
		method: 'GET',
		url: '/api/v1/memories',
		qs: { ...baseQs, page: (options.page as number) ?? 1, size: limit },
	});
	return (page?.items ?? []) as unknown as IDataObject[];
}

async function runGet(
	ctx: IExecuteFunctions,
	userId: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const memoryId = (ctx.getNodeParameter('memoryId', itemIndex) as string)?.trim();
	if (!memoryId) {
		throw new NodeOperationError(ctx.getNode(), 'Memory ID is required', { itemIndex });
	}
	const detail = await cortadelRequest<MemoryDetailResponse>(ctx, {
		method: 'GET',
		url: `/api/v1/memories/${encodeURIComponent(memoryId)}`,
		qs: { user_id: userId },
	});
	return [detail as unknown as IDataObject];
}

async function runDelete(
	ctx: IExecuteFunctions,
	userId: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const memoryIds = parseCsv(ctx.getNodeParameter('memoryIds', itemIndex) as string);
	if (memoryIds.length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'At least one memory ID is required', {
			itemIndex,
		});
	}
	const body: DeleteMemoriesRequest = { user_id: userId, memory_ids: memoryIds };
	const result = await cortadelRequest<DeleteMemoriesResponse>(ctx, {
		method: 'DELETE',
		url: '/api/v1/memories',
		body,
	});
	return [{ deleted: memoryIds, message: result?.message ?? null }];
}

/**
 * A `Map`, deliberately not a plain object. `operation` is whatever the workflow JSON
 * says, and an object lookup would resolve inherited keys — `operation: 'toString'`
 * would find `Object.prototype.toString`, sail past a truthiness check and be invoked
 * as a handler. A `Map` only ever returns its own entries, so an unknown operation
 * lands on the error below exactly as the old `default:` branch did.
 */
const OPERATION_HANDLERS = new Map<string, OperationHandler>([
	['add', runAdd],
	['addConversation', runAddConversation],
	['search', runSearch],
	['list', runList],
	['get', runGet],
	['delete', runDelete],
]);

async function runOperation(
	ctx: IExecuteFunctions,
	operation: string,
	userId: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const handler = OPERATION_HANDLERS.get(operation);
	if (handler === undefined) {
		throw new NodeOperationError(ctx.getNode(), `Unknown operation: ${operation}`, {
			itemIndex,
		});
	}
	return await handler(ctx, userId, itemIndex);
}
