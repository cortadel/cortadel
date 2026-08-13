/**
 * Reading the ambient LangGraph runtime without letting it throw.
 *
 * `getStore()` / `getConfig()` (`@langchain/langgraph`, re-exported from
 * `libs/langgraph-core/src/pregel/utils/config.ts`) are the documented way for a node or tool to
 * reach the store the graph was compiled with. Their JS shape differs from the Python one in two
 * ways that matter here:
 *
 * 1. **`getStore` takes an optional `config`.** Its body is
 *    `(config ?? AsyncLocalStorageProviderSingleton.getRunnableConfig())?.store`, so a node or tool
 *    that was handed a `LangGraphRunnableConfig` can pass it straight in and never touch
 *    AsyncLocalStorage. Python's `get_store()` takes no argument at all. Preferring the explicit
 *    config is why this package threads `config` through every call site.
 * 2. **It throws exactly one error**, a plain `Error` ("Config not retrievable…"), and only when
 *    there is neither an argument nor an ALS config — e.g. a tool invoked standalone in a unit
 *    test, or a web/edge build with no `node:async_hooks`. There is no JS analogue of Python's
 *    `KeyError('__pregel_runtime')`: the store hangs off the config directly rather than off a
 *    runtime object nested inside `configurable`. It returns `undefined` when the graph was
 *    compiled without a store.
 *
 * Memory is an enhancement, never a reason for an agent to crash, so this narrows every one of
 * those outcomes to a single `undefined`.
 */
import { getConfig, getStore, type LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BaseStore } from "@langchain/langgraph-checkpoint";

/** The store the current graph was compiled with, or `undefined` if there isn't one. */
export function ambientStore(config?: LangGraphRunnableConfig): BaseStore | undefined {
  try {
    return getStore(config) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ambient runnable config, or `undefined` outside a graph.
 *
 * `getConfig()` returns `undefined` rather than throwing when there is no ALS config (Python's
 * `get_config()` raises `RuntimeError` instead), but a web build without `node:async_hooks` can
 * still throw from inside the singleton — hence the guard.
 */
export function ambientConfig(): LangGraphRunnableConfig | undefined {
  try {
    return getConfig() ?? undefined;
  } catch {
    return undefined;
  }
}
