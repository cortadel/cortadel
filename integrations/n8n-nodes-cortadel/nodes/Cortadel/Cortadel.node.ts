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

				const pushed = await runOperation.call(this, operation, userId, i);
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

async function runOperation(
	this: IExecuteFunctions,
	operation: string,
	userId: string,
	i: number,
): Promise<IDataObject[]> {
	switch (operation) {
		case 'add': {
			const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
			const metadata = parseJsonParameter(extra.metadata, 'Metadata (JSON)');
			const body = compact({
				user_id: userId,
				text: this.getNodeParameter('text', i) as string,
				app: (extra.app as string) ?? CORTADEL_APP_NAME,
				infer: extra.infer as boolean | undefined,
				memory_type: extra.memoryType as string | undefined,
				metadata: metadata as Record<string, unknown> | undefined,
			}) as unknown as CreateMemoryRequest;

			const created = await cortadelRequest<MemoryCreatedResponse>(this, {
				method: 'POST',
				url: '/api/v1/memories',
				body,
			});
			return [created as unknown as IDataObject];
		}

		case 'addConversation': {
			const inputMode = this.getNodeParameter('inputMode', i, 'fields') as string;
			let raw: unknown;
			if (inputMode === 'json') {
				raw = parseJsonParameter(
					this.getNodeParameter('messagesJson', i, '[]'),
					'Messages (JSON)',
				);
			} else {
				const collection = this.getNodeParameter('messages', i, {}) as IDataObject;
				raw = (collection.message as IDataObject[]) ?? [];
			}
			const messages = toConversationMessages(raw);
			if (messages.length === 0) {
				throw new NodeOperationError(
					this.getNode(),
					'At least one non-empty conversation message is required',
					{ itemIndex: i },
				);
			}

			const extra = this.getNodeParameter('conversationFields', i, {}) as IDataObject;
			const body = compact({
				user_id: userId,
				messages,
				is_agent_memory: extra.isAgentMemory as boolean | undefined,
				project: extra.project as string | undefined,
				session_id: extra.sessionId as string | undefined,
				tags: parseCsv((extra.tags as string) ?? ''),
			}) as unknown as AddConversationRequest;

			const result = await cortadelRequest<ConversationIngestResponse>(this, {
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

		case 'search': {
			const options = this.getNodeParameter('searchOptions', i, {}) as IDataObject;
			const body = compact({
				user_id: userId,
				query: this.getNodeParameter('query', i) as string,
				top_k: (options.topK as number) ?? 10,
				mode: (options.mode as string) ?? 'hybrid',
				session_id: options.sessionId as string | undefined,
				// The contract accepts exactly one rerank strategy; anything else silently no-ops.
				rerank: options.rerank === true ? 'cross_encoder' : undefined,
				memory_type: options.memoryType as string | undefined,
				app_name: CORTADEL_APP_NAME,
			}) as unknown as SearchMemoriesRequest;

			const response = await cortadelRequest<SearchResponse>(this, {
				method: 'POST',
				url: '/api/v1/memories/search',
				body,
			});

			const simplify = this.getNodeParameter('simplify', i, true) as boolean;
			if (!simplify) return [response as unknown as IDataObject];
			const hits = response?.results ?? [];
			return hits.length > 0 ? (hits as unknown as IDataObject[]) : [];
		}

		case 'list': {
			const options = this.getNodeParameter('listOptions', i, {}) as IDataObject;
			const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
			const limit = this.getNodeParameter('limit', i, 20) as number;

			const baseQs = {
				user_id: userId,
				app_id: options.appId as string | undefined,
				categories: options.categories as string | undefined,
				search_query: options.searchQuery as string | undefined,
				memory_type: options.memoryType as string | undefined,
				// The wire takes this flag as a *string*, not a boolean.
				include_superseded: options.includeSuperseded === true ? 'true' : undefined,
			};

			if (!returnAll) {
				const page = await cortadelRequest<MemoryListPagedResponse>(this, {
					method: 'GET',
					url: '/api/v1/memories',
					qs: { ...baseQs, page: (options.page as number) ?? 1, size: limit },
				});
				return (page?.items ?? []) as unknown as IDataObject[];
			}

			const collected: IDataObject[] = [];
			let page = 1;
			// Guard against a server that reports pages inconsistently.
			for (let guard = 0; guard < 1000; guard++) {
				const response = await cortadelRequest<MemoryListPagedResponse>(this, {
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

		case 'get': {
			const memoryId = (this.getNodeParameter('memoryId', i) as string)?.trim();
			if (!memoryId) {
				throw new NodeOperationError(this.getNode(), 'Memory ID is required', { itemIndex: i });
			}
			const detail = await cortadelRequest<MemoryDetailResponse>(this, {
				method: 'GET',
				url: `/api/v1/memories/${encodeURIComponent(memoryId)}`,
				qs: { user_id: userId },
			});
			return [detail as unknown as IDataObject];
		}

		case 'delete': {
			const memoryIds = parseCsv(this.getNodeParameter('memoryIds', i) as string);
			if (memoryIds.length === 0) {
				throw new NodeOperationError(this.getNode(), 'At least one memory ID is required', {
					itemIndex: i,
				});
			}
			const body: DeleteMemoriesRequest = { user_id: userId, memory_ids: memoryIds };
			const result = await cortadelRequest<DeleteMemoriesResponse>(this, {
				method: 'DELETE',
				url: '/api/v1/memories',
				body,
			});
			return [{ deleted: memoryIds, message: result?.message ?? null }];
		}

		default:
			throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
				itemIndex: i,
			});
	}
}
