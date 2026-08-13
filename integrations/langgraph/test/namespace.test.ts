import { describe, expect, it } from "vitest";

import { DEFAULT_NAMESPACE, asNamespace, namespaceUserId, resolveNamespace } from "../src/index.js";

describe("asNamespace", () => {
  it("treats a bare string as a one-label namespace", () => {
    expect(asNamespace("memories")).toEqual(["memories"]);
  });

  it("returns a literal namespace unchanged", () => {
    expect(asNamespace(["memories", "e2e-alice"])).toEqual(["memories", "e2e-alice"]);
  });
});

describe("resolveNamespace", () => {
  it("returns a namespace with no placeholders unchanged, config or not", () => {
    expect(resolveNamespace(["memories", "e2e-alice"])).toEqual(["memories", "e2e-alice"]);
  });

  it("fills placeholders from the configurable object", () => {
    const resolved = resolveNamespace(["memories", "{userId}"], {
      configurable: { userId: "e2e-alice" },
    });
    expect(resolved).toEqual(["memories", "e2e-alice"]);
  });

  it("accepts the snake_case spelling LangGraph's own protocol keys use", () => {
    const resolved = resolveNamespace(["memories", "{userId}"], {
      configurable: { user_id: "e2e-alice" },
    });
    expect(resolved).toEqual(["memories", "e2e-alice"]);
  });

  it("accepts the camelCase spelling of a snake_case placeholder", () => {
    const resolved = resolveNamespace(["memories", "{user_id}"], {
      configurable: { userId: "e2e-alice" },
    });
    expect(resolved).toEqual(["memories", "e2e-alice"]);
  });

  it("names the missing placeholder in the error", () => {
    expect(() => resolveNamespace(["memories", "{userId}"], { configurable: {} })).toThrow(
      /missing "userId" in config.configurable/,
    );
  });

  it("counts a blank placeholder value as missing", () => {
    expect(() =>
      resolveNamespace(["memories", "{userId}"], { configurable: { userId: "" } }),
    ).toThrow(/missing "userId"/);
  });

  it("explains how to supply a config when there is none at all", () => {
    expect(() => resolveNamespace(["memories", "{userId}"])).toThrow(
      /no config was passed and none is available/,
    );
  });

  it("only treats a whole label as a placeholder", () => {
    const resolved = resolveNamespace(["memories", "user-{id}"], { configurable: { id: "x" } });
    expect(resolved).toEqual(["memories", "user-{id}"]);
  });

  it("stringifies a non-string value", () => {
    const resolved = resolveNamespace(["memories", "{userId}"], { configurable: { userId: 42 } });
    expect(resolved).toEqual(["memories", "42"]);
  });
});

describe("namespaceUserId", () => {
  it("pairs with the default namespace via the trailing label", () => {
    expect(DEFAULT_NAMESPACE).toEqual(["memories", "{userId}"]);
    expect(namespaceUserId(-1)(["memories", "e2e-alice"])).toBe("e2e-alice");
  });

  it("lets the user label position be configured", () => {
    expect(namespaceUserId(0)(["e2e-alice", "memories"])).toBe("e2e-alice");
  });

  it("says which namespace failed when the index is out of range", () => {
    expect(() => namespaceUserId(3)(["memories"])).toThrow(/has no label at index 3/);
  });

  it("refuses a blank label", () => {
    expect(() => namespaceUserId(-1)(["memories", ""])).toThrow(/empty label/);
  });
});
