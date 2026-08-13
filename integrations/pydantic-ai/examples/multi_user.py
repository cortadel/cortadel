"""Per-user memory in a multi-tenant agent.

A Cortadel client is bound to one user id at construction — no SDK method takes a user id — so
serving many users means one client per user. `CortadelMemory` handles that for you: pass a
callable `user_id` and it resolves the id per run from pydantic-ai's own dependency channel
(`ctx.deps`), keeping one pooled client per resolved id.

The important property: Alice's memories can never leak into Bob's run, because the two runs
resolve to two different clients against two different Cortadel namespaces.

Run it:

    export OPENAI_API_KEY=...
    uv run python examples/multi_user.py     # needs Cortadel on http://localhost:3001
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

from pydantic_ai import Agent, RunContext

from cortadel_pydantic_ai import CortadelMemory


@dataclass
class Deps:
    """Whatever your request handler already knows about the caller."""

    user_id: str
    tenant: str


def current_user(ctx: RunContext[Deps]) -> str:
    """Resolve the Cortadel namespace for this run.

    Namespacing the id by tenant is a good habit in a multi-tenant system: it keeps two
    customers' user ids from colliding inside one Cortadel deployment.
    """
    return f"{ctx.deps.tenant}-{ctx.deps.user_id}"


async def main() -> None:
    memory: CortadelMemory[Deps] = CortadelMemory(
        base_url=os.getenv("CORTADEL_BASE_URL", "http://localhost:3001"),
        api_key=os.getenv("CORTADEL_API_KEY"),
        user_id=current_user,
        # Tag everything this agent writes, so it can be retrieved (or audited) as a group.
        tags=["support-bot"],
        project="acme/support",
        # A support bot answers on the hot path: take the write off it. `aclose()` below is what
        # guarantees the backgrounded writes actually landed before the process goes away.
        await_persist=False,
    )

    agent = Agent(
        "openai:gpt-5",
        deps_type=Deps,
        instructions="You are a support assistant. Be concise.",
        capabilities=[memory],
    )

    alice = Deps(user_id="e2e-alice", tenant="e2e-acme")
    bob = Deps(user_id="e2e-bob", tenant="e2e-acme")

    # Each run reads and writes only its own user's memories.
    await agent.run("My deployment region is eu-west-1.", deps=alice)
    await agent.run("My deployment region is us-east-2.", deps=bob)

    await asyncio.sleep(2)  # extraction runs off the request path

    alice_answer = await agent.run("Which region am I in?", deps=alice)
    bob_answer = await agent.run("Which region am I in?", deps=bob)

    print("alice >", alice_answer.output)  # eu-west-1
    print("bob   >", bob_answer.output)  # us-east-2

    # Drains the backgrounded writes, then closes every pooled client (one per resolved user id).
    await memory.aclose()


if __name__ == "__main__":
    asyncio.run(main())
