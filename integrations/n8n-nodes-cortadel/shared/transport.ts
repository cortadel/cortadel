import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	ISupplyDataFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

/**
 * Name of the credential type declared by `credentials/CortadelApi.credentials.ts`.
 * Kept as a constant so the node files and the tests can never drift from it.
 */
export const CORTADEL_CREDENTIALS = 'cortadelApi';

/**
 * Identifies this integration to Cortadel. Sent as `app_name` on searches
 * (recorded for access logging) and as `app` on writes (the app that created
 * the memory). These are two different wire fields — see the SDK notes.
 *
 * It is this package's published npm name, verbatim: every Cortadel integration
 * labels itself that way, so an access log names something you can install. The
 * n8n nodes fix it rather than exposing it as an option — a workflow author has no
 * reason to lie about which node wrote a memory.
 */
export const CORTADEL_APP_NAME = 'n8n-nodes-cortadel';

/** Fallback base URL when the credential leaves it blank: a local `docker compose up`. */
export const DEFAULT_BASE_URL = 'http://localhost:3001';

/** Any n8n context that can issue authenticated Cortadel HTTP calls. */
export type CortadelRequestContext =
	| IExecuteFunctions
	| ISupplyDataFunctions
	| ILoadOptionsFunctions
	| IPollFunctions;

export interface CortadelRequestOptions {
	method: IHttpRequestMethods;
	/** Path only, e.g. `/api/v1/memories/search`. */
	url: string;
	body?: unknown;
	qs?: Record<string, string | number | boolean | undefined>;
}

const SLASH_CHAR_CODE = '/'.charCodeAt(0);

/**
 * Strips every trailing `/` in one backward pass.
 *
 * Deliberately *not* `value.replace(/\/+$/, '')`. That pattern is unanchored, so the
 * engine retries it from each position in turn: on a long run of slashes that is not
 * at the end (`'http://h/' + '/'.repeat(n) + 'a'`) every start position inside the run
 * matches `\/+` greedily, fails `$`, and backtracks the whole run — quadratic in the
 * run length (measured: 0.9 ms at n=2_000, 906 ms at n=64_000). This walk is O(n) and
 * returns the same string for every input.
 */
export function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) end--;
	return end === value.length ? value : value.slice(0, end);
}

/** Reads `baseUrl` from the credential and normalises away any trailing slash. */
export async function getCortadelBaseUrl(ctx: CortadelRequestContext): Promise<string> {
	const credentials = await ctx.getCredentials(CORTADEL_CREDENTIALS);
	const raw = credentials?.baseUrl;
	const base = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_BASE_URL;
	return stripTrailingSlashes(base);
}

/** `true` for `{}` — but not for arrays, `Date`s, or anything with own keys. */
function isEmptyPlainObject(value: unknown): boolean {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value as object).length === 0;
}

/**
 * Drops `undefined` entries so we never send `?top_k=undefined` or a body key the
 * contract marks as optional. Cortadel treats a blank string as a real value on
 * several fields, so blanks are dropped too — as are empty arrays and empty plain
 * objects, which is what n8n hands back for a `json` field the user added to the
 * UI but never edited (its default is the string `'{}'`).
 *
 * `false` and `0` are deliberately kept: both are meaningful on the wire
 * (`infer: false`, `page: 0`).
 */
export function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		if (typeof value === 'string' && value.trim().length === 0) continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (isEmptyPlainObject(value)) continue;
		out[key] = value;
	}
	return out;
}

function toJsonObject(error: unknown): JsonObject {
	if (error instanceof Error) {
		const extended = error as Error & {
			httpCode?: string;
			statusCode?: number;
			cause?: unknown;
		};
		const out: JsonObject = { message: error.message, name: error.name };
		if (extended.statusCode !== undefined) out.statusCode = extended.statusCode;
		if (extended.httpCode !== undefined) out.httpCode = extended.httpCode;
		return out;
	}
	if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
		return error as JsonObject;
	}
	return { message: String(error) };
}

/**
 * Single choke point for every Cortadel HTTP call.
 *
 * Deliberately uses n8n's own `httpRequestWithAuthentication` helper rather than
 * bundling `@cortadel/sdk`: n8n's verified-community-node rules forbid run-time
 * dependencies, and the helper is what applies the credential's `authenticate`
 * block, the proxy settings, and the per-instance SSL configuration.
 */
export async function cortadelRequest<T>(
	ctx: CortadelRequestContext,
	options: CortadelRequestOptions,
): Promise<T> {
	const baseURL = await getCortadelBaseUrl(ctx);

	const requestOptions: IHttpRequestOptions = {
		baseURL,
		url: options.url,
		method: options.method,
		json: true,
		headers: { 'User-Agent': `${CORTADEL_APP_NAME}/0.1.0` },
	};
	if (options.body !== undefined) requestOptions.body = options.body;
	if (options.qs !== undefined) requestOptions.qs = compact(options.qs) as IHttpRequestOptions['qs'];

	try {
		return (await ctx.helpers.httpRequestWithAuthentication.call(
			ctx,
			CORTADEL_CREDENTIALS,
			requestOptions,
		)) as T;
	} catch (error) {
		if (error instanceof NodeApiError) throw error;
		throw new NodeApiError(ctx.getNode(), toJsonObject(error), {
			message: 'Cortadel request failed',
			description: `${options.method} ${baseURL}${options.url}`,
		});
	}
}
