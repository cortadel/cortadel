"""Shared test helpers. Nothing here touches the network, a Cortadel server, or the Claude CLI.

The Cortadel boundary is stubbed with :class:`FakeCortadel`, a plain object implementing the four
methods this package calls. The Claude Agent SDK side is **not** stubbed: tools are driven through
the real in-process MCP server built by ``create_sdk_mcp_server``, so the tests exercise the
SDK's own schema validation and result marshalling rather than our idea of it.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

from cortadel import (
    AddOptions,
    ChatMessage,
    ConversationOptions,
    ConversationResult,
    MemoryCreated,
    SearchHit,
    SearchOptions,
    SearchResults,
)
from mcp.types import CallToolRequest, CallToolRequestParams, ListToolsRequest, Tool

BASE_URL = "http://localhost:3001"
USER_ID = "e2e-claude-agent-sdk"

# Not a UUID on purpose: `get_session_messages` rejects non-UUID session ids and returns [], which
# forces `last_exchange` down its transcript-path fallback — the branch these tests can drive
# hermetically, without planting files under ~/.claude/projects/.
SESSION_ID = "e2e-session-not-a-uuid"


@dataclass
class FakeCortadel:
    """Records every call and returns pre-programmed results. Set ``*_error`` to make one fail."""

    search_results: list[SearchHit] = field(default_factory=list)
    created: MemoryCreated = field(default_factory=lambda: MemoryCreated(id="mem-1", event="ADD"))
    conversation: ConversationResult = field(
        default_factory=lambda: ConversationResult(no_facts_extracted=True)
    )
    search_error: Optional[BaseException] = None
    add_error: Optional[BaseException] = None
    conversation_error: Optional[BaseException] = None

    searches: list[tuple[str, Optional[SearchOptions]]] = field(default_factory=list)
    adds: list[tuple[str, Optional[AddOptions]]] = field(default_factory=list)
    conversations: list[tuple[list[ChatMessage], Optional[ConversationOptions]]] = field(
        default_factory=list
    )
    closed: bool = False

    async def search(self, query: str, options: Optional[SearchOptions] = None) -> SearchResults:
        self.searches.append((query, options))
        if self.search_error is not None:
            raise self.search_error
        return SearchResults(
            query=query, results=list(self.search_results), total=len(self.search_results)
        )

    async def add(self, text: str, options: Optional[AddOptions] = None) -> MemoryCreated:
        self.adds.append((text, options))
        if self.add_error is not None:
            raise self.add_error
        return self.created

    async def add_conversation(
        self, messages: Iterable[ChatMessage], options: Optional[ConversationOptions] = None
    ) -> ConversationResult:
        self.conversations.append((list(messages), options))
        if self.conversation_error is not None:
            raise self.conversation_error
        return self.conversation

    async def aclose(self) -> None:
        self.closed = True


def hit(memory_id: str, content: str, **kwargs: Any) -> SearchHit:
    kwargs.setdefault("rrf_score", 0.5)
    kwargs.setdefault("created_at", "2026-08-13T09:00:00Z")
    return SearchHit(id=memory_id, content=content, **kwargs)


# ── Driving the real in-process MCP server ──────────────────────────────────────────────────


async def list_tools(memory: Any) -> list[Tool]:
    """The tool list the SDK MCP server actually advertises."""
    server = memory.mcp_server["instance"]
    result = await server.request_handlers[ListToolsRequest](ListToolsRequest(method="tools/list"))
    return list(result.root.tools)


async def call_tool(memory: Any, name: str, arguments: dict[str, Any]) -> Any:
    """Invoke a tool through the server, so JSON Schema validation and error marshalling run."""
    server = memory.mcp_server["instance"]
    result = await server.request_handlers[CallToolRequest](
        CallToolRequest(
            method="tools/call", params=CallToolRequestParams(name=name, arguments=arguments)
        )
    )
    return result.root


def tool_text(result: Any) -> str:
    return "\n".join(block.text for block in result.content if block.type == "text")


# ── Hook inputs and transcripts ─────────────────────────────────────────────────────────────


def prompt_input(prompt: str, *, session_id: str = SESSION_ID) -> dict[str, Any]:
    """A ``UserPromptSubmitHookInput``-shaped dict, matching claude_agent_sdk/types.py."""
    return {
        "hook_event_name": "UserPromptSubmit",
        "session_id": session_id,
        "transcript_path": "/tmp/does-not-exist.jsonl",
        "cwd": "/work/demo-project",
        "prompt": prompt,
    }


def stop_input(
    transcript_path: Path,
    *,
    session_id: str = SESSION_ID,
    cwd: str = "/work/demo-project",
    stop_hook_active: bool = False,
) -> dict[str, Any]:
    """A ``StopHookInput``-shaped dict. Note it carries no message content — that is why the Stop
    hook has to read the transcript back."""
    return {
        "hook_event_name": "Stop",
        "session_id": session_id,
        "transcript_path": str(transcript_path),
        "cwd": cwd,
        "stop_hook_active": stop_hook_active,
    }


def write_transcript(path: Path, entries: list[dict[str, Any]]) -> Path:
    path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n", encoding="utf-8")
    return path


def user_entry(text: str, *, uuid: str = "u-1", **extra: Any) -> dict[str, Any]:
    return {"type": "user", "uuid": uuid, "message": {"role": "user", "content": text}, **extra}


def assistant_entry(text: str, *, uuid: str = "a-1", **extra: Any) -> dict[str, Any]:
    return {
        "type": "assistant",
        "uuid": uuid,
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
        **extra,
    }
