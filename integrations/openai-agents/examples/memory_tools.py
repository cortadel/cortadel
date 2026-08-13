"""Explicit memory: the agent decides when to search and when to store.

Use this shape when you want memory to be *visible* — an auditable tool call in the trace rather
than an invisible prompt injection — or when only some turns should touch memory at all.

``cortadel_memory_tools`` returns two ordinary ``FunctionTool`` objects, so they slot into
``Agent(tools=[...])` like any other tool and show up in traces and tool-approval flows.

Run it
------
    docker compose up            # from the repo root → http://localhost:3001
    export OPENAI_API_KEY=sk-...
    python examples/memory_tools.py

The two shapes compose: pass ``tools=session.tools()`` alongside a ``CortadelSession`` to give an
agent both automatic recall and an explicit "look it up again" escape hatch.
"""

from __future__ import annotations

import asyncio
import os

from agents import Agent, Runner

from cortadel_openai_agents import cortadel_memory_tools

BASE_URL = os.environ.get("CORTADEL_BASE_URL", "http://localhost:3001")
USER_ID = "e2e-openai-agents-tools"


async def main() -> None:
    agent = Agent(
        name="Assistant",
        instructions=(
            "You have a long-term memory. Call `search_memory` before answering questions about "
            "the user, and call `add_memories` when they tell you something durable about "
            "themselves. Keep replies to one sentence."
        ),
        # Tools are bound to one user id at construction, because a Cortadel client is.
        # Build one toolset per user you serve.
        tools=cortadel_memory_tools(USER_ID, base_url=BASE_URL),
    )

    # The model should choose `add_memories` here.
    stored = await Runner.run(agent, "For future reference: I'm allergic to peanuts.")
    print("store >", stored.final_output)

    await asyncio.sleep(5)  # let the extraction pipeline settle

    # …and `search_memory` here.
    recalled = await Runner.run(agent, "Is there anything you should know before ordering me lunch?")
    print("recall >", recalled.final_output)


if __name__ == "__main__":
    asyncio.run(main())
