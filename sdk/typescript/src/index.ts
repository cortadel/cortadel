// The only public entry point. Re-exports the facade and its own types — nothing from
// src/generated is reachable from here, enforced two ways: the package.json `exports` map
// declares only ".", so a deep import of the generated tree is a hard
// ERR_PACKAGE_PATH_NOT_EXPORTED at the module-resolution level; and test/client.test.ts's
// encapsulation test compiles this file's real declaration output and checks that neither it nor
// the files it re-exports from ever import from "./generated".
export { CortadelClient } from "./client.js";
export {
  CortadelError,
  DEFAULT_LIST_SIZE,
  type AddOptions,
  type ChatMessage,
  type ConversationIngestItem,
  type ConversationOptions,
  type ConversationResult,
  type CortadelOptions,
  type HealthResult,
  type ListOptions,
  type MemoryCreated,
  type MemoryDetail,
  type MemoryList,
  type MemoryListItem,
  type SearchHit,
  type SearchOptions,
  type SearchResults,
} from "./models.js";
