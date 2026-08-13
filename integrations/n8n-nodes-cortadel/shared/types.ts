/**
 * Wire DTOs for the Cortadel public REST contract.
 *
 * Every field name below is transcribed from `spec/openapi.json` in this repo
 * (`openapi: 3.0.4`, `info.title: "Cortadel API (public)"`, `info.version: v1`).
 * The wire is snake_case; the published SDKs (`@cortadel/sdk`, `cortadel`) expose
 * camelCase facades over exactly these shapes.
 *
 * Note the two documented wire asymmetries, both reproduced faithfully here:
 *   - a search hit's global flag is `global`, but a list item / detail uses `is_global`;
 *   - `created_at` is an ISO 8601 *string* on search hits and on create, but
 *     *Unix seconds* on list items and on detail.
 */

/** `ConversationMessageItem` — one turn handed to `POST /api/v1/memories/from-conversation`. */
export interface CortadelConversationMessage {
	/** `"user"`, `"assistant"`, or `"system"`. */
	role: string;
	/** Message text (1..50000 chars). */
	content: string;
	/** Optional producer-side turn uuid, kept as a pointer anchor on extracted facts. */
	uuid?: string;
}

/** `CreateMemoryRequest` — body of `POST /api/v1/memories`. */
export interface CreateMemoryRequest {
	user_id: string;
	text: string;
	app?: string;
	infer?: boolean;
	memory_type?: string;
	metadata?: Record<string, unknown>;
}

/** `MemoryCreatedResponse` — 200 of `POST /api/v1/memories`. */
export interface MemoryCreatedResponse {
	id?: string | null;
	content?: string | null;
	state?: string | null;
	/** ISO 8601 string on this schema. */
	created_at?: string | null;
	/** `ADD`, `SKIP_DUPLICATE`, `SUPERSEDE`, `TOUCH`, `RESOLVE`, `INVALIDATE`, `DELETE_ENTITY`, `ERROR`. */
	event?: string | null;
	app_name?: string | null;
	/** Metadata as a JSON *string* on this schema (unlike the detail schema). */
	metadata?: string | null;
}

/** `AddConversationRequest` — body of `POST /api/v1/memories/from-conversation`. */
export interface AddConversationRequest {
	user_id: string;
	messages: CortadelConversationMessage[];
	is_agent_memory?: boolean;
	tags?: string[];
	project?: string;
	session_id?: string;
	transcript_path?: string;
}

/** `ConversationIngestItem`. */
export interface ConversationIngestItem {
	id?: string | null;
	memory?: string | null;
	event?: string | null;
	error?: string | null;
}

/** `ConversationIngestResponse` — `results` and `no_facts_extracted` are mutually exclusive. */
export interface ConversationIngestResponse {
	results?: ConversationIngestItem[] | null;
	no_facts_extracted?: boolean | null;
}

/** `SearchMemoriesRequest` — body of `POST /api/v1/memories/search`. */
export interface SearchMemoriesRequest {
	user_id: string;
	query: string;
	/** 1..50. */
	top_k?: number;
	/** `hybrid` (default), `text`, or `vector`. */
	mode?: string;
	session_id?: string;
	/** Only `"cross_encoder"` does anything; omit to skip reranking. */
	rerank?: string;
	memory_type?: string;
	/** Recorded for access logging. */
	app_name?: string;
}

/** `HybridSearchResult` — one ranked hit. */
export interface CortadelSearchHit {
	id?: string | null;
	content?: string | null;
	rrf_score?: number;
	/** ISO 8601 string on this schema. */
	created_at?: string | null;
	app_name?: string | null;
	categories?: string[] | null;
	memory_type?: string | null;
	tags?: string[] | null;
	/** `personal` or `global`. */
	source?: string | null;
	/** Wire name is `global` here — list items and detail use `is_global`. */
	global?: boolean;
	gist?: string | null;
	project_id?: string | null;
	member_ids?: string[] | null;
	similar_ids?: string[] | null;
	text_rank?: number | null;
	vector_rank?: number | null;
	attributes?: Record<string, unknown> | null;
}

/** `SearchResponse` — 200 of `POST /api/v1/memories/search`. */
export interface SearchResponse {
	query?: string | null;
	results?: CortadelSearchHit[] | null;
	total?: number;
}

/** `MemoryListItemResponse`. */
export interface MemoryListItemResponse {
	id?: string | null;
	content?: string | null;
	/** Unix seconds on this schema. */
	created_at?: number;
	state?: string | null;
	app_id?: string | null;
	app_name?: string | null;
	categories?: string[] | null;
	memory_type?: string | null;
	extraction_status?: string | null;
	valid_at?: string | null;
	invalid_at?: string | null;
	is_current?: boolean | null;
	is_global?: boolean;
	metadata_?: unknown;
}

/** `MemoryListPagedResponse` — 200 of `GET /api/v1/memories`. */
export interface MemoryListPagedResponse {
	items?: MemoryListItemResponse[] | null;
	total?: number;
	page?: number;
	size?: number;
	pages?: number;
}

/** `MemoryDetailResponse` — 200 of `GET /api/v1/memories/{memoryId}`. Content field is `text`. */
export interface MemoryDetailResponse {
	id?: string | null;
	text?: string | null;
	/** Unix seconds on this schema. */
	created_at?: number;
	state?: string | null;
	app_id?: string | null;
	app_name?: string | null;
	categories?: string[] | null;
	metadata_?: unknown;
	valid_at?: string | null;
	invalid_at?: string | null;
	is_current?: boolean;
	superseded_by?: string | null;
	is_global?: boolean;
}

/** `DeleteMemoriesRequest` — body of `DELETE /api/v1/memories`. */
export interface DeleteMemoriesRequest {
	user_id: string;
	memory_ids: string[];
}

/** `DeleteMemoriesResponse`. */
export interface DeleteMemoriesResponse {
	message?: string | null;
}

/** `HealthResponse` — `GET /api/health`. Returns 503 with the same body when degraded. */
export interface HealthResponse {
	/** `ok` when every check passed, `degraded` otherwise. */
	status?: string | null;
	checked_at?: string | null;
	checks?: Record<string, unknown> | null;
}
