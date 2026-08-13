export { cortadelMemory, CORTADEL_PROVIDER_OPTIONS_KEY } from "./middleware.js";
export type { CortadelMemoryOptions } from "./middleware.js";

export { cortadelTools } from "./tools.js";
export type {
  AddMemoriesResult,
  CortadelAddToolOptions,
  CortadelSearchToolOptions,
  CortadelToolSet,
  CortadelToolsOptions,
  RecalledMemory,
  SearchMemoryResult,
} from "./tools.js";

export { formatMemories } from "./format.js";

export { DEFAULT_APP_NAME } from "./connection.js";

export type {
  CortadelConnectionOptions,
  CortadelErrorContext,
  CortadelMemoryClient,
  FormatMemoriesContext,
} from "./types.js";
