"""Automatic memory: the agent remembers across separate runs without being asked.

What this shows
---------------
Turn 1 tells the agent something. The run ends. Turn 2 is a *fresh* run that asks about it — and
the answer comes from Cortadel, not from conversation history, because we deliberately start
turn 2 with a brand-new session id (a new "chat window"). Short-term history is gone; long-term
memory is not.

Run it
------
1. Start Cortadel::

       docker compose up          # from the repo root → http://localhost:3001

   …or point ``CORTADEL_BASE_URL`` at the hosted service, ``https://app.cortadel.ai``, and set
   ``CORTADEL_API_KEY``.

2. Export an OpenAI key for the agent itself::

       export OPENAI_API_KEY=sk-...

3. ``python examples/quickstart.py``

Note the two wiring points on ``Runner.run``: ``session=`` stores the turn and holds history,
``run_config=`` installs the recall filter. Both come from the same object.
"""

from __future__ import annotations

import asyncio
import os

from agents import Agent, Runner

from cortadel_openai_agents import CortadelSession

BASE_URL = os.environ.get("CORTADEL_BASE_URL", "http://localhost:3001")

# One Cortadel client is bound to one user id, so one session serves exactly one user.
# `e2e-` marks this as disposable test data.
USER_ID = "e2e-openai-agents-quickstart"


async def main() -> None:
    agent = Agent(
        name="Assistant",
        instructions=(
            "You are a concise personal assistant. Recalled memories may appear in your "
            "instructions; use them silently."
        ),
    )

    # ---- Turn 1: a fact worth keeping ---------------------------------------------------
    async with CortadelSession(
        session_id="quickstart-chat-1", user_id=USER_ID, base_url=BASE_URL
    ) as session:
        first = await Runner.run(
            agent,
            "I use Neovim, and I always deploy on Tuesdays. Remember that.",
            session=session,
            run_config=session.run_config(),
        )
        print("turn 1 >", first.final_output)
        # Leaving the `async with` flushes anything still buffered and closes the client.

    # Cortadel extracts facts in the background, so give the pipeline a moment before asking.
    await asyncio.sleep(5)

    # ---- Turn 2: a NEW conversation, no shared history ----------------------------------
    async with CortadelSession(
        session_id="quickstart-chat-2", user_id=USER_ID, base_url=BASE_URL
    ) as session:
        # Nothing in this session's transcript mentions Neovim — only Cortadel does.
        assert await session.get_items() == []

        second = await Runner.run(
            agent,
            "What editor do I use, and when do I deploy?",
            session=session,
            run_config=session.run_config(),
        )
        print("turn 2 >", second.final_output)


if __name__ == "__main__":
    asyncio.run(main())
