"""Automatic memory: the agent recalls and remembers without ever being asked.

This is the `UserPromptSubmit` + `Stop` hook path. Nothing in the prompts below mentions memory —
the hooks do the work:

  * before the model runs, `UserPromptSubmit` searches Cortadel with the submitted prompt and
    injects the hits as `hookSpecificOutput.additionalContext`;
  * after the turn ends, `Stop` reads the exchange back off the session transcript and hands it to
    `add_conversation`, where Cortadel distils the durable facts. That write is awaited
    (`await_persist=True`, the default), so it is guaranteed to have landed before this script's
    event loop shuts down — which is exactly why turn 2 can find it.

Run it twice. The first run has nothing to recall and stores the turn; the second run answers from
memory, in a brand-new session.

    # A Cortadel server (self-hosted `docker compose up`, or https://app.cortadel.ai)
    export CORTADEL_URL=http://localhost:3001
    export CORTADEL_USER_ID=e2e-claude-agent-sdk-demo
    # export CORTADEL_API_KEY=...     # only if the server has auth enabled

    uv run python examples/auto_memory.py

Requires the Claude Code CLI and Anthropic credentials, which the Claude Agent SDK itself needs.
"""
from __future__ import annotations

import asyncio
import logging
import os

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

from cortadel_claude_agent_sdk import CortadelMemory

PROMPTS = [
    # Turn 1 — states a durable preference. The Stop hook captures it.
    "For this project we standardise on four-space indentation and never use tabs. "
    "Acknowledge that and tell me nothing else.",
    # Turn 2 — never restates the rule. The UserPromptSubmit hook supplies it.
    "What indentation should I use in this project?",
]


async def main() -> None:
    base_url = os.environ.get("CORTADEL_URL", "http://localhost:3001")
    user_id = os.environ.get("CORTADEL_USER_ID", "e2e-claude-agent-sdk-demo")

    # One CortadelMemory per user: a Cortadel client is bound to one user id at construction, so
    # the user id belongs here and never appears in an individual call.
    memory = CortadelMemory(
        base_url,
        user_id,
        api_key=os.environ.get("CORTADEL_API_KEY") or None,
        top_k=5,
        # Recall across sessions — that is the point of turn 2 below answering in a fresh session.
        scope_recall_to_session=False,
        # raise_on_error=False (the default) keeps the agent running when Cortadel is down; the
        # on_error callback is how you find out that it was.
        raise_on_error=False,
        on_error=lambda exc: logging.getLogger("auto_memory").warning("cortadel: %s", exc),
    )

    # tools=False keeps this example honest: no memory tools are offered, so anything the model
    # recalls came from the hooks rather than from a deliberate tool call.
    options = memory.apply(
        ClaudeAgentOptions(model="claude-sonnet-4-5", max_turns=1),
        tools=False,
    )

    async with memory:
        for prompt in PROMPTS:
            print(f"\n>>> {prompt}")
            async for message in query(prompt=prompt, options=options):
                if isinstance(message, ResultMessage) and message.subtype == "success":
                    print(f"<<< {message.result}")

    print(
        "\nRun this again: the second turn should answer from memory even in a fresh session. "
        f"Everything is stored under user id {user_id!r}."
    )


if __name__ == "__main__":
    asyncio.run(main())
