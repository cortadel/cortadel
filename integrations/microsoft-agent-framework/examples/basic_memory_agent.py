# Copyright (c) Cortadel. Licensed under the Apache-2.0 License.

"""End-to-end example: an Agent Framework agent that remembers across sessions.

What this shows
---------------
1. `CortadelContextProvider` attached via `Agent(context_providers=[...])` — the framework's own
   memory extension point. It searches Cortadel before every model call and stores the turn after.
2. `cortadel_memory_tools(...)` — `search_memory` / `add_memories` as real `FunctionTool`s, so the
   agent can also go looking on its own initiative.
3. That memory outlives the session: turn three runs in a brand-new `AgentSession` and the agent
   still knows what it was told in turn one.

Prerequisites
-------------
    pip install cortadel-agent-framework agent-framework-openai

    # A Cortadel server. Self-host it:
    #     docker compose up          # -> http://localhost:3001
    # ...or point CORTADEL_BASE_URL at the hosted service, https://app.cortadel.ai
    export CORTADEL_BASE_URL=http://localhost:3001
    export CORTADEL_API_KEY=...     # omit when the server runs with auth disabled
    export OPENAI_API_KEY=...

Run it
------
    python examples/basic_memory_agent.py

Note the memory pipeline is asynchronous server-side: Cortadel distils facts out of a stored
conversation off the request path, so a brand-new server may need a few seconds before turn three
can recall turn one. That is why this script pauses between the phases.
"""

from __future__ import annotations

import asyncio
import os

from agent_framework import Agent, AgentSession
from agent_framework.openai import OpenAIChatClient

from cortadel_agent_framework import CortadelContextProvider, cortadel_memory_tools

# `e2e-` marks this as disposable test data — the convention across the Cortadel repo.
# In a real app this is your end user's stable id.
USER_ID = "e2e-agent-framework-example"

BASE_URL = os.environ.get("CORTADEL_BASE_URL", "http://localhost:3001")
API_KEY = os.environ.get("CORTADEL_API_KEY")  # None when the server has auth disabled


async def main() -> None:
    """Teach the agent something, then prove it remembers in a fresh session."""
    # One provider per end user: a Cortadel client is bound to a single user id at construction,
    # so scoping is structural. The `async with` closes the client the provider created.
    async with CortadelContextProvider(
        base_url=BASE_URL,
        user_id=USER_ID,
        api_key=API_KEY,
        top_k=5,  # the default; the knob you will reach for first
        # Uncomment to rerank retrieved memories with the server's cross-encoder:
        # rerank="cross_encoder",
        # Failures fail open by default. Uncomment to see them as they happen:
        # on_error=lambda exc: print(f"(cortadel unavailable: {exc})"),
    ) as memory:
        agent = Agent(
            # `OpenAIChatClient`'s first parameter is `model` (positional-or-keyword).
            client=OpenAIChatClient("gpt-4o-mini"),
            instructions=(
                "You are a helpful assistant with long-term memory. "
                "Use what you remember about the user, and say so when you are relying on it."
            ),
            # (B) Automatic memory: recall before each call, store after each turn.
            context_providers=[memory],
            # (A) Agent-invoked memory: the same client, exposed as tools it can call itself.
            tools=cortadel_memory_tools(memory.client),
        )

        # -- Session one: tell it something worth keeping ---------------------------------
        first = AgentSession()
        print("--- Session one ---")

        reply = await agent.run(
            "I'm Alex. I ship releases on Fridays and I strongly prefer dark mode in every tool.",
            session=first,
        )
        print("agent:", reply.text)

        reply = await agent.run("I also can't stand meetings before 10am.", session=first)
        print("agent:", reply.text)

        # Give the server's extraction pipeline a moment to distil facts from those turns.
        print("\n(waiting for Cortadel to extract facts...)")
        await asyncio.sleep(8)

        # -- Session two: a brand-new conversation ----------------------------------------
        # Nothing is carried over in-process: a fresh AgentSession has empty history and empty
        # provider state. Anything the agent knows here came back out of Cortadel.
        second = AgentSession()
        print("\n--- Session two (fresh session, same user) ---")

        reply = await agent.run(
            "When should we schedule the release call? Keep my preferences in mind.",
            session=second,
        )
        print("agent:", reply.text)

        # -- What is actually stored --------------------------------------------------------
        # `memory.client` is a plain Cortadel client; the whole SDK surface is available.
        print("\n--- Stored memories ---")
        stored = await memory.client.list()
        for item in stored.items:
            print(f"  [{item.id}] {item.content}")

        health = await memory.client.health()
        # health() does not raise when the server is degraded — check the status yourself.
        print(f"\nCortadel status: {health.status}")


if __name__ == "__main__":
    asyncio.run(main())
