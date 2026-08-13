/** `CortadelMemory.apply()` — merging into `Options` without clobbering the caller's. */

import { beforeEach, describe, expect, it } from "vitest";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

import * as pkg from "../src/index.js";
import { CortadelMemory, DEFAULT_APP_NAME, DEFAULT_SERVER_NAME } from "../src/index.js";
import { FakeCortadel } from "./helpers.js";

let memory: CortadelMemory;

beforeEach(() => {
  memory = CortadelMemory.fromClient(new FakeCortadel());
});

describe("public surface", () => {
  it("exports exactly the runtime values it documents", () => {
    expect(Object.keys(pkg).sort()).toEqual([
      "CortadelMemory",
      "DEFAULT_APP_NAME",
      "DEFAULT_SERVER_NAME",
      "lastExchange",
    ]);
  });

  it("defaults appName to the published package name", () => {
    expect(DEFAULT_APP_NAME).toBe("@cortadel/claude-agent-sdk");
    expect(DEFAULT_SERVER_NAME).toBe("cortadel");
  });
});

describe("apply", () => {
  it("wires the server, the tools and both hooks", () => {
    const options = memory.apply();

    expect(options.mcpServers).toEqual({ cortadel: memory.mcpServer });
    expect(options.allowedTools).toEqual(memory.allowedTools);
    expect(Object.keys(options.hooks ?? {}).sort()).toEqual(["Stop", "UserPromptSubmit"]);
  });

  it("gives each matcher no tool matcher and a derived timeout in seconds", () => {
    // `HookCallbackMatcher.matcher` filters by tool name, which is meaningless
    // for these two events. The timeout is seconds, ours is milliseconds.
    const tuned = CortadelMemory.fromClient(new FakeCortadel(), {
      recallTimeoutMs: 8_000,
      captureTimeoutMs: 30_000,
    });

    const hooks = tuned.hooks();

    const recall = hooks.UserPromptSubmit![0]!;
    const capture = hooks.Stop![0]!;
    expect(recall.matcher).toBeUndefined();
    expect(capture.matcher).toBeUndefined();
    expect(recall.timeout).toBe(13);
    expect(capture.timeout).toBe(35);
    expect(recall.hooks).toEqual([tuned.onUserPromptSubmit]);
    expect(capture.hooks).toEqual([tuned.onStop]);
  });

  it("preserves unrelated options", () => {
    const options = memory.apply({ model: "claude-sonnet-4-5", maxTurns: 3 });

    expect(options.model).toBe("claude-sonnet-4-5");
    expect(options.maxTurns).toBe(3);
  });

  it("merges rather than replaces", () => {
    const otherHook: HookCallback = async () => ({});
    const base: Options = {
      mcpServers: { weather: { type: "stdio", command: "weather-mcp" } },
      allowedTools: ["Read", "mcp__weather__get_temperature"],
      hooks: { UserPromptSubmit: [{ hooks: [otherHook] }] },
    };

    const options = memory.apply(base);

    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(["cortadel", "weather"]);
    expect(options.allowedTools?.slice(0, 2)).toEqual(["Read", "mcp__weather__get_temperature"]);
    expect(options.allowedTools).toContain("mcp__cortadel__search_memory");
    expect(options.hooks?.UserPromptSubmit?.map((matcher) => matcher.hooks[0])).toEqual([
      otherHook,
      memory.onUserPromptSubmit,
    ]);
    expect(options.hooks?.Stop).toBeDefined();
  });

  it("does not mutate the options it is given", () => {
    const base: Options = { allowedTools: ["Read"] };

    memory.apply(base);

    expect(base.allowedTools).toEqual(["Read"]);
    expect(base.mcpServers).toBeUndefined();
    expect(base.hooks).toBeUndefined();
  });

  it("does not duplicate an already-allowed tool", () => {
    const options = memory.apply({ allowedTools: ["mcp__cortadel__search_memory"] });

    expect(options.allowedTools!.filter((name) => name === "mcp__cortadel__search_memory")).toHaveLength(
      1,
    );
  });

  it("can wire tools only", () => {
    const options = memory.apply({}, { autoMemory: false });

    expect(options.mcpServers).toHaveProperty("cortadel");
    expect(options.hooks).toBeUndefined();
  });

  it("can wire automatic memory only", () => {
    const options = memory.apply({}, { tools: false });

    expect(options.mcpServers).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(Object.keys(options.hooks ?? {}).sort()).toEqual(["Stop", "UserPromptSubmit"]);
  });
});

describe("fromEnv", () => {
  const env = {
    CORTADEL_URL: "http://localhost:3001",
    CORTADEL_USER_ID: "e2e-from-env",
    CORTADEL_CLIENT_NAME: "my-agent",
  } satisfies NodeJS.ProcessEnv;

  it("reads the same variables the cortadel-memory plugin reads", () => {
    const built = CortadelMemory.fromEnv({}, env);

    expect(built.tools.map((tool) => tool.name)).toEqual(["search_memory", "add_memories"]);
    expect(built.allowedTools[0]).toBe("mcp__cortadel__search_memory");
  });

  it("names the missing variables", () => {
    expect(() => CortadelMemory.fromEnv({}, {})).toThrow(/CORTADEL_URL and CORTADEL_USER_ID/);
    expect(() => CortadelMemory.fromEnv({}, { CORTADEL_URL: "http://localhost:3001" })).toThrow(
      /CORTADEL_USER_ID/,
    );
  });

  it("lets explicit options win over the environment", () => {
    const built = CortadelMemory.fromEnv({ serverName: "explicit" }, env);

    expect(built.allowedTools[0]).toBe("mcp__explicit__search_memory");
  });
});
