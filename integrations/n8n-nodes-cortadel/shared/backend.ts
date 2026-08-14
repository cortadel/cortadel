import type { CortadelMemoryBackend } from './memory';
import type {
	ConversationIngestResponse,
	CortadelConversationMessage,
	CortadelSearchHit,
	MemoryListPagedResponse,
	SearchResponse,
} from './types';
import type { CortadelRequestContext } from './transport';
import { CORTADEL_APP_NAME, compact, cortadelRequest } from './transport';

export interface CortadelBackendSettings {
	userId: string;
	sessionId: string;
	/**
	 * `false` (the default) recalls across the whole of this user's graph — the point of
	 * long-term memory; `true` restricts recall to facts stored under `sessionId`, which
	 * makes the memory behave more like a conversation buffer. Writes always carry the
	 * session id either way.
	 */
	scopeRecallToSession: boolean;
	topK: number;
	/** `hybrid` | `text` | `vector`. */
	mode: string;
	/** Only `cross_encoder` does anything server-side. */
	rerank?: string;
	memoryType?: string;
	project?: string;
	tags?: string[];
	/** When false the memory is read-only: it recalls but never writes turns back. */
	persistTurns: boolean;
}

/**
 * Optional hook so the sub-node can surface each recall/persist as a run in the n8n
 * UI. Returns whatever `run` returns; a tracer that throws must never break memory,
 * so implementations are expected to swallow their own failures.
 */
export type BackendTracer = <T>(
	label: string,
	input: Record<string, unknown>,
	run: () => Promise<T>,
	summarize: (result: T) => Record<string, unknown>,
) => Promise<T>;

const passthroughTracer: BackendTracer = async (_label, _input, run) => await run();

/** Binds the four memory operations to one Cortadel user + session over REST. */
export function createCortadelBackend(
	ctx: CortadelRequestContext,
	settings: CortadelBackendSettings,
	trace: BackendTracer = passthroughTracer,
): CortadelMemoryBackend {
	const searchSessionId = settings.scopeRecallToSession ? settings.sessionId : undefined;

	return {
		async recall(query: string): Promise<CortadelSearchHit[]> {
			return await trace(
				'recall',
				{
					query,
					userId: settings.userId,
					scope: settings.scopeRecallToSession ? 'session' : 'user',
				},
				async () => {
					const body = compact({
						user_id: settings.userId,
						query,
						top_k: settings.topK,
						mode: settings.mode,
						session_id: searchSessionId,
						rerank: settings.rerank,
						memory_type: settings.memoryType,
						app_name: CORTADEL_APP_NAME,
					});
					const response = await cortadelRequest<SearchResponse>(ctx, {
						method: 'POST',
						url: '/api/v1/memories/search',
						body,
					});
					return response?.results ?? [];
				},
				(hits) => ({ recalled: hits.length }),
			);
		},

		async recent(): Promise<CortadelSearchHit[]> {
			return await trace(
				'recent',
				{ userId: settings.userId, size: settings.topK },
				async () => {
					const response = await cortadelRequest<MemoryListPagedResponse>(ctx, {
						method: 'GET',
						url: '/api/v1/memories',
						qs: {
							user_id: settings.userId,
							page: 1,
							size: settings.topK,
							// The list route has no session filter, but it does honour
							// memory_type — so the degraded path still respects a configured
							// cognitive-type restriction instead of ignoring it.
							memory_type: settings.memoryType,
						},
					});
					// A list item's content field is `content`; map it onto the hit shape the
					// renderer expects. `created_at` differs in type between the two schemas
					// (Unix seconds vs ISO string), so it is deliberately not carried over.
					return (response?.items ?? []).map((item) => ({
						id: item.id,
						content: item.content,
						categories: item.categories,
						memory_type: item.memory_type,
					}));
				},
				(hits) => ({ recalled: hits.length }),
			);
		},

		async persist(messages: CortadelConversationMessage[]): Promise<void> {
			if (!settings.persistTurns) return;
			await trace(
				'persist',
				{ turns: messages.length, sessionId: settings.sessionId },
				async () => {
					const body = compact({
						user_id: settings.userId,
						messages,
						session_id: settings.sessionId,
						project: settings.project,
						tags: settings.tags,
					});
					return await cortadelRequest<ConversationIngestResponse>(ctx, {
						method: 'POST',
						url: '/api/v1/memories/from-conversation',
						body,
					});
				},
				(result) => ({
					stored: result?.results?.length ?? 0,
					noFactsExtracted: result?.no_facts_extracted ?? false,
				}),
			);
		},
	};
}
