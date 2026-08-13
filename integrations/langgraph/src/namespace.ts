/**
 * Namespace templating and user-id resolution.
 *
 * LangGraph addresses long-term memory by *namespace* — an array of strings such as
 * `["memories", "alice"]` (`@langchain/langgraph-checkpoint`, `src/store/base.ts`, `BaseStore.put`).
 * Cortadel addresses it by *user id*, fixed at client construction: "All calls are scoped to the
 * userId given at construction." Those two models meet here.
 *
 * - {@link resolveNamespace} expands `{placeholder}` labels from a `LangGraphRunnableConfig`'s
 *   `configurable` object, so a single tool or node can serve every user.
 * - {@link namespaceUserId} builds the `namespace -> userId` callable that {@link CortadelStore}
 *   uses to decide *which* Cortadel client a given namespace belongs to.
 */
import { ambientConfig } from "./runtime.js";

/**
 * A namespace, or a template for one. A bare `string` is treated as a one-label namespace.
 */
export type NamespaceLike = string | readonly string[];

/**
 * Either a fixed Cortadel user id, or a callable mapping a namespace to one.
 */
export type UserIdResolver = string | ((namespace: string[]) => string);

/**
 * The namespace this package defaults to.
 *
 * Mirrors the shape LangGraph's own long-term-memory docs use, and pairs with
 * `namespaceUserId(-1)` so the trailing label *is* the Cortadel user id.
 */
export const DEFAULT_NAMESPACE: readonly string[] = ["memories", "{userId}"];

// Only a *whole* label may be a placeholder ("{userId}", never "user-{id}"). Keeping that
// restriction means a namespace label can never be half-literal, which would make the reverse
// mapping (namespace -> user id) ambiguous.
const PLACEHOLDER = /^\{(\w+)\}$/;

/** Normalise a namespace-ish value to an array of labels. */
export function asNamespace(value: NamespaceLike): string[] {
  if (typeof value === "string") return [value];
  return value.map((label) => String(label));
}

/**
 * The names a placeholder is looked up under, in order.
 *
 * LangGraph's own protocol keys are snake_case (`thread_id`, `checkpoint_id`) while a TypeScript
 * caller naturally writes `userId`, and the docs' own examples use `user_id`. Rather than making
 * that a coin flip, `{userId}` also matches a `user_id` entry and vice versa.
 */
function candidateKeys(name: string): string[] {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const camel = name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const seen = new Set<string>([name, snake, camel]);
  return [...seen];
}

/**
 * Expand `{placeholder}` labels in `template` from a runnable config.
 *
 * @param template A namespace whose labels may be placeholders, e.g. `["memories", "{userId}"]`.
 * @param config The config to read `configurable` from. When omitted, the ambient config is
 *   pulled via `getConfig()` — which only returns something inside a running graph node or tool.
 * @returns The namespace with every placeholder substituted.
 * @throws `Error` if a placeholder has no value, or if no config is available at all.
 */
export function resolveNamespace(
  template: NamespaceLike = DEFAULT_NAMESPACE,
  config?: { configurable?: Record<string, unknown> },
): string[] {
  const labels = asNamespace(template);
  const placeholders: Array<[number, string]> = [];
  labels.forEach((label, index) => {
    const match = PLACEHOLDER.exec(label);
    if (match) placeholders.push([index, match[1]!]);
  });
  if (placeholders.length === 0) return labels;

  const resolvedConfig = config ?? ambientConfig();
  if (resolvedConfig === undefined) {
    const wanted = placeholders.map(([, name]) => name).join(", ");
    throw new Error(
      `Namespace [${labels.join(", ")}] needs {${wanted}} from the runnable config, but no ` +
        "config was passed and none is available. Either invoke this inside a LangGraph node " +
        'with config={ configurable: { ... } }, or pass a fully-resolved namespace.',
    );
  }

  const configurable = resolvedConfig.configurable ?? {};
  const resolved = [...labels];
  const missing: string[] = [];
  for (const [index, name] of placeholders) {
    const key = candidateKeys(name).find((candidate) => {
      const value = configurable[candidate];
      return value !== undefined && value !== null && value !== "";
    });
    if (key === undefined) missing.push(name);
    else resolved[index] = String(configurable[key]);
  }
  if (missing.length > 0) {
    throw new Error(
      `Namespace [${labels.join(", ")}] could not be resolved: missing ` +
        `${missing.map((name) => `"${name}"`).join(", ")} in config.configurable. ` +
        `Invoke with config={ configurable: { ${missing[0]}: "..." } }.`,
    );
  }
  return resolved;
}

/**
 * Build a `namespace -> userId` resolver that reads one label of the namespace.
 *
 * `namespaceUserId(-1)` pairs with {@link DEFAULT_NAMESPACE}: given `["memories", "alice"]` it
 * yields `"alice"`, so one {@link CortadelStore} can serve every user of a multi-tenant graph
 * while still honouring Cortadel's one-client-per-user rule.
 *
 * @param index Position of the label holding the user id. Negative indices count from the end.
 */
export function namespaceUserId(index: number = -1): (namespace: string[]) => string {
  return function namespaceUserIdResolver(namespace: string[]): string {
    const position = index < 0 ? namespace.length + index : index;
    const label = namespace[position];
    if (label === undefined) {
      throw new Error(
        `Namespace [${namespace.join(", ")}] has no label at index ${index}, so no Cortadel ` +
          "user id could be derived from it.",
      );
    }
    if (label === "") {
      throw new Error(
        `Namespace [${namespace.join(", ")}] has an empty label at index ${index}; a Cortadel ` +
          "user id cannot be blank.",
      );
    }
    return label;
  };
}
