"""Cortadel × Pydantic AI — a memory that survives between runs.

What this shows: two *separate* agent runs, with no message history threaded between them. The
second run has no idea what the first one said — except that Cortadel remembered it.

Run it:

    # 1. Start Cortadel (from the repo root):
    #      docker compose up            ->  http://localhost:3001
    #    ...or point base_url at the hosted service: https://app.cortadel.ai
    # 2. Give your model provider a key:
    export OPENAI_API_KEY=...
    # 3. Go:
    uv run python examples/quickstart.py

Nothing here is Cortadel-specific plumbing: `CortadelMemory` is a pydantic-ai capability, so it
goes in `capabilities=[...]` alongside anything else you use.
"""

from __future__ import annotations

import asyncio
import os

from pydantic_ai import Agent

from cortadel_pydantic_ai import CortadelMemory

# `e2e-*` marks disposable test data. Use a real, stable id for a real user.
USER_ID = "e2e-pydantic-ai-quickstart"


async def main() -> None:
    memory = CortadelMemory(
        base_url=os.getenv("CORTADEL_BASE_URL", "http://localhost:3001"),
        user_id=USER_ID,
        # Omit when your server has auth disabled (the self-hosted default).
        api_key=os.getenv("CORTADEL_API_KEY"),
        # Print anything that goes wrong instead of letting it pass silently. Either way the
        # agent keeps running — memory failures never take a run down. Pass
        # `raise_on_error=True` alongside this if you would rather the run failed loudly.
        on_error=lambda exc: print(f"  [memory unavailable: {exc}]"),
    )

    agent = Agent(
        "openai:gpt-5",
        instructions="You are a concise assistant.",
        capabilities=[memory],
    )

    # --- Run 1 -----------------------------------------------------------------------
    # Nothing is known yet, so nothing is injected. On the way out, `after_run` sends the
    # turn to Cortadel, which extracts the durable facts from it in the background.
    print("run 1 >", "I'm allergic to peanuts, and I always want measurements in metric.")
    first = await agent.run("I'm allergic to peanuts, and I always want measurements in metric.")
    print("      <", first.output, "\n")

    # Cortadel extracts facts off the request path, so give it a moment before asking.
    await asyncio.sleep(2)

    # --- Run 2 -----------------------------------------------------------------------
    # A brand-new run. No `message_history=`, so the only way the model can know about the
    # allergy is the recall that `get_instructions()` performed before the model was called.
    print("run 2 >", "Suggest a dessert I can make, with quantities.")
    second = await agent.run("Suggest a dessert I can make, with quantities.")
    print("      <", second.output, "\n")

    # The model can also search memory itself when it decides it needs to — `search_memory`
    # and `add_memories` are ordinary tools it can call.
    print("run 3 >", "What do you already know about me? Use your memory tool.")
    third = await agent.run("What do you already know about me? Use your memory tool.")
    print("      <", third.output)

    # Optional: release the pooled HTTP connections on shutdown.
    await memory.aclose()


if __name__ == "__main__":
    asyncio.run(main())
