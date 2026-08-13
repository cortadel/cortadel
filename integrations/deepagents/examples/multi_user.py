"""One compiled deep agent serving several users, each with their own Cortadel memory.

A Cortadel client is bound to one `user_id` at construction, so this is the pattern that matters
for anything multi-tenant: compile the agent once, declare a `context_schema` carrying the user
id, and let the middleware resolve and cache a client per user. Memories never cross users.

Run it:

    export ANTHROPIC_API_KEY=...
    export CORTADEL_BASE_URL=http://localhost:3001
    uv run python examples/multi_user.py
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from deepagents import create_deep_agent

from cortadel_deepagents import CortadelMemoryMiddleware

MODEL = os.environ.get("MODEL", "anthropic:claude-sonnet-4-6")
CORTADEL_URL = os.environ.get("CORTADEL_BASE_URL", "http://localhost:3001")


@dataclass
class UserContext:
    """Run-scoped context. LangGraph exposes this to middleware as `runtime.context`.

    The field name must match the middleware's `user_id_key` (default `"user_id"`). Add whatever
    else your agent needs alongside it.
    """

    user_id: str


def main() -> None:
    # Note: no `user_id=` here. Leaving it unset is what puts the middleware in multi-user mode --
    # every run must then carry an id, and a run that carries none proceeds without memory rather
    # than falling back to somebody else's namespace.
    memory = CortadelMemoryMiddleware(
        base_url=CORTADEL_URL,
        # api_key=os.environ["CORTADEL_API_KEY"],
        top_k=5,
        # Cross-thread recall is the default (`scope_recall_to_session=False`): each user's
        # memories follow them between conversations, but never leak to another user.
    )

    agent = create_deep_agent(
        model=MODEL,
        system_prompt="You are a concise engineering assistant.",
        middleware=[memory],
        context_schema=UserContext,
    )

    try:
        for user_id, message in (
            ("e2e-deepagents-alice", "I always want SI units in any table you produce."),
            ("e2e-deepagents-bob", "I work in imperial units, never metric."),
        ):
            result = agent.invoke(
                {"messages": [{"role": "user", "content": message}]},
                {"configurable": {"thread_id": f"{user_id}-thread-1"}},
                # The user id travels with the run, not with the agent.
                context=UserContext(user_id=user_id),
            )
            print(f"{user_id}: {result['messages'][-1].text}")

        # A fresh thread for one of them. Only that user's memories are recalled -- the other's
        # contradictory preference is in a different Cortadel namespace and is never visible.
        follow_up = agent.invoke(
            {"messages": [{"role": "user", "content": "Give me a table of the sensor readings."}]},
            {"configurable": {"thread_id": "e2e-deepagents-alice-thread-2"}},
            context=UserContext(user_id="e2e-deepagents-alice"),
        )
        print("alice, new thread:", follow_up["messages"][-1].text)
    finally:
        # Closes every per-user client the middleware built.
        memory.close()


if __name__ == "__main__":
    main()
