"""Memory tools: the agent decides when to remember and when to recall.

This is the other half of the integration — an in-process MCP server (`create_sdk_mcp_server`)
exposing two tools:

    mcp__cortadel__search_memory   query, top_k?
    mcp__cortadel__add_memories    text, memory_type?

`auto_memory=False` turns the hooks off, so every read and write below is a tool call the model
chose to make. Watch the `[tool call]` lines to see it happen.

    export CORTADEL_URL=http://localhost:3001
    export CORTADEL_USER_ID=e2e-claude-agent-sdk-demo
    # export CORTADEL_API_KEY=...     # only if the server has auth enabled

    uv run python examples/memory_tools.py

Requires the Claude Code CLI and Anthropic credentials, which the Claude Agent SDK itself needs.
"""
from __future__ import annotations

import asyncio
import os

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    ToolUseBlock,
    query,
)

from cortadel_claude_agent_sdk import CortadelMemory

PROMPTS = [
    "Remember that our staging database is reset every Sunday at 02:00 UTC.",
    "When is staging wiped? Check your memory before answering.",
]


async def main() -> None:
    memory = CortadelMemory(
        os.environ.get("CORTADEL_URL", "http://localhost:3001"),
        os.environ.get("CORTADEL_USER_ID", "e2e-claude-agent-sdk-demo"),
        api_key=os.environ.get("CORTADEL_API_KEY") or None,
    )

    # apply() merges the MCP server and pre-approves both tool names. Written out by hand it is:
    #     mcp_servers={"cortadel": memory.mcp_server},
    #     allowed_tools=["mcp__cortadel__search_memory", "mcp__cortadel__add_memories"],
    options = memory.apply(
        ClaudeAgentOptions(
            model="claude-sonnet-4-5",
            # No built-in tools: this agent's only capability is its memory.
            tools=[],
            system_prompt=(
                "You have a long-term memory. Store durable facts with add_memories and check "
                "search_memory before answering anything that might depend on earlier context."
            ),
        ),
        auto_memory=False,
    )

    async with memory:
        for prompt in PROMPTS:
            print(f"\n>>> {prompt}")
            async for message in query(prompt=prompt, options=options):
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, ToolUseBlock):
                            print(f"    [tool call] {block.name} {block.input}")
                elif isinstance(message, ResultMessage) and message.subtype == "success":
                    print(f"<<< {message.result}")


if __name__ == "__main__":
    asyncio.run(main())
