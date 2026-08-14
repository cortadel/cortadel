import type { INodeProperties } from 'n8n-workflow';

const showFor = (operation: string[]): INodeProperties['displayOptions'] => ({
	show: { resource: ['memory'], operation },
});

/**
 * Cognitive-type pin. Blank/invalid values are ignored server-side (auto-classified),
 * and `compact()` drops the blank before the request is built.
 *
 * `Any` exists so a user who adds the option in the UI can get back to "no filter"
 * without removing the option again — and so this list matches the Memory sub-node's.
 */
const memoryTypeOptions = [
	{ name: 'Any', value: '' },
	{ name: 'Episodic', value: 'episodic' },
	{ name: 'Procedural', value: 'procedural' },
	{ name: 'Semantic', value: 'semantic' },
];

export const cortadelNodeProperties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [{ name: 'Memory', value: 'memory' }],
		default: 'memory',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['memory'] } },
		options: [
			{
				name: 'Add',
				value: 'add',
				action: 'Add a memory',
				description: 'Store a single piece of text as a long-term memory',
			},
			{
				name: 'Add Conversation',
				value: 'addConversation',
				action: 'Add a conversation',
				description: 'Distil facts out of a conversation transcript and store them',
			},
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete memories',
				description: 'Delete one or more memories by ID',
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get a memory',
				description: 'Fetch one memory by ID, including its bi-temporal validity window',
			},
			{
				name: 'List',
				value: 'list',
				action: 'List memories',
				description: 'Page through stored memories',
			},
			{
				name: 'Search',
				value: 'search',
				action: 'Search memories',
				description: 'Find relevant memories with hybrid BM25 + vector search',
			},
		],
		default: 'search',
	},

	// ---------------------------------------------------------------- shared
	{
		displayName: 'User ID',
		name: 'userId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. alice',
		description:
			'The Cortadel user who owns these memories. Every memory in Cortadel is namespaced to one user, so this is the isolation boundary — use an expression such as {{ $json.userId }} to scope per chat participant.',
		displayOptions: { show: { resource: ['memory'] } },
	},

	// ------------------------------------------------------------------- add
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		required: true,
		description: 'The memory text to store (up to 50,000 characters)',
		displayOptions: showFor(['add']),
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: showFor(['add']),
		options: [
			{
				displayName: 'App',
				name: 'app',
				type: 'string',
				default: '',
				description: 'Application name recorded as the creator of this memory',
			},
			{
				displayName: 'Infer',
				name: 'infer',
				type: 'boolean',
				default: true,
				description:
					'Whether to run background entity and category extraction. Turn off to store the text verbatim; deduplication still applies.',
			},
			{
				displayName: 'Memory Type',
				name: 'memoryType',
				type: 'options',
				options: memoryTypeOptions,
				default: '',
				description: 'Pin the cognitive type instead of letting the server classify it',
			},
			{
				displayName: 'Metadata (JSON)',
				name: 'metadata',
				type: 'json',
				default: '{}',
				description: 'Arbitrary key-value pairs stored alongside the memory',
			},
		],
	},

	// ------------------------------------------------------- addConversation
	{
		displayName: 'Input Mode',
		name: 'inputMode',
		type: 'options',
		options: [
			{ name: 'Fields', value: 'fields', description: 'Build the turns one by one' },
			{ name: 'JSON', value: 'json', description: 'Pass an array of {role, content} objects' },
		],
		default: 'fields',
		description: 'How the conversation turns are supplied',
		displayOptions: showFor(['addConversation']),
	},
	{
		displayName: 'Messages',
		name: 'messages',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		placeholder: 'Add Message',
		default: {},
		description: 'Conversation turns, in order (1-500)',
		displayOptions: {
			show: { resource: ['memory'], operation: ['addConversation'], inputMode: ['fields'] },
		},
		options: [
			{
				displayName: 'Message',
				name: 'message',
				values: [
					{
						displayName: 'Role',
						name: 'role',
						type: 'options',
						options: [
							{ name: 'Assistant', value: 'assistant' },
							{ name: 'System', value: 'system' },
							{ name: 'User', value: 'user' },
						],
						default: 'user',
						description: 'Who produced this turn',
					},
					{
						displayName: 'Content',
						name: 'content',
						type: 'string',
						typeOptions: { rows: 2 },
						default: '',
						description: 'Text of the turn',
					},
				],
			},
		],
	},
	{
		displayName: 'Messages (JSON)',
		name: 'messagesJson',
		type: 'json',
		default: '[\n  { "role": "user", "content": "" }\n]',
		description: 'Array of {role, content} objects, in order',
		displayOptions: {
			show: { resource: ['memory'], operation: ['addConversation'], inputMode: ['json'] },
		},
	},
	{
		displayName: 'Additional Fields',
		name: 'conversationFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: showFor(['addConversation']),
		options: [
			{
				displayName: 'Is Agent Memory',
				name: 'isAgentMemory',
				type: 'boolean',
				default: false,
				description:
					'Whether to extract facts about the assistant rather than about the user',
			},
			{
				displayName: 'Project',
				name: 'project',
				type: 'string',
				default: '',
				description: 'Project scope for the extracted facts, e.g. a repository name',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Groups the extracted facts under one session',
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				placeholder: 'support,billing',
				description: 'Comma-separated tags applied to every extracted fact',
			},
		],
	},

	// ---------------------------------------------------------------- search
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		required: true,
		placeholder: "e.g. what are the user's deployment preferences?",
		description: 'Natural-language query, fused across BM25 and vector arms',
		displayOptions: showFor(['search']),
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description:
			'Whether to return one item per hit instead of the raw {query, results, total} envelope',
		displayOptions: showFor(['search']),
	},
	{
		displayName: 'Options',
		name: 'searchOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['search']),
		options: [
			{
				displayName: 'Memory Type',
				name: 'memoryType',
				type: 'options',
				options: memoryTypeOptions,
				default: '',
				description: 'Restrict results to one cognitive type',
			},
			{
				displayName: 'Mode',
				name: 'mode',
				type: 'options',
				options: [
					{ name: 'Hybrid', value: 'hybrid' },
					{ name: 'Text', value: 'text' },
					{ name: 'Vector', value: 'vector' },
				],
				default: 'hybrid',
				description: 'Which retrieval arms to fuse',
			},
			{
				displayName: 'Rerank',
				name: 'rerank',
				type: 'boolean',
				default: false,
				description:
					'Whether to rerank the fused results with the local cross-encoder. Also enables the graph and session arms, which ride below the fusion floor.',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Restrict results to one session',
			},
			{
				displayName: 'Top K',
				name: 'topK',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 50 },
				default: 10,
				description: 'Max number of results to return',
			},
		],
	},

	// ------------------------------------------------------------------ list
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: showFor(['list']),
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 100 },
		default: 20,
		description: 'Max number of results to return',
		displayOptions: {
			show: { resource: ['memory'], operation: ['list'], returnAll: [false] },
		},
	},
	{
		displayName: 'Options',
		name: 'listOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['list']),
		options: [
			{
				displayName: 'App ID',
				name: 'appId',
				type: 'string',
				default: '',
				description: 'Only return memories created by this app',
			},
			{
				displayName: 'Categories',
				name: 'categories',
				type: 'string',
				default: '',
				placeholder: 'preferences,tooling',
				description: 'Comma-separated category names to filter by',
			},
			{
				displayName: 'Include Superseded',
				name: 'includeSuperseded',
				type: 'boolean',
				default: false,
				description:
					'Whether to include older, superseded versions of memories alongside the current ones',
			},
			{
				displayName: 'Memory Type',
				name: 'memoryType',
				type: 'options',
				options: memoryTypeOptions,
				default: '',
				description: 'Restrict results to one cognitive type',
			},
			{
				displayName: 'Page',
				name: 'page',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 1,
				description: 'Which page to fetch, when not returning all',
			},
			{
				displayName: 'Search Query',
				name: 'searchQuery',
				type: 'string',
				default: '',
				description:
					'Runs a hybrid search but still returns the paged list envelope, not the search envelope',
			},
		],
	},

	// ------------------------------------------------------------------- get
	{
		displayName: 'Memory ID',
		name: 'memoryId',
		type: 'string',
		default: '',
		required: true,
		description: 'ID of the memory to fetch',
		displayOptions: showFor(['get']),
	},

	// ---------------------------------------------------------------- delete
	{
		displayName: 'Memory IDs',
		name: 'memoryIds',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'id-one,id-two',
		description: 'Comma-separated list of memory IDs to delete',
		displayOptions: showFor(['delete']),
	},
];
