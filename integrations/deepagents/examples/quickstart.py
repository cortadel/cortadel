"""Single-user deep agent with Cortadel long-term memory.

Two turns on two *different* threads. The second turn has no conversational history to draw on —
anything the agent still knows came out of Cortadel.

Run it:

    # 1. A Cortadel server. Self-hosted:
    #      docker compose up          -> http://localhost:3001
    #    or the hosted service at https://app.cortadel.ai (then set CORTADEL_API_KEY).
    # 2. A model key for whichever provider you point `MODEL` at.
    export ANTHROPIC_API_KEY=...
    export CORTADEL_BASE_URL=http://localhost:3001
    uv run python examples/quickstart.py
"""

from __future__ import annotations

import os

from deepagents import create_deep_agent

from cortadel_deepagents import CortadelMemoryMiddleware

MODEL = os.environ.get("MODEL", "anthropic:claude-sonnet-4-6")
CORTADEL_URL = os.environ.get("CORTADEL_BASE_URL", "http://localhost:3001")

# Test-scoped user id. Every memory written by this script is namespaced under it, so it never
# touches real data and is trivial to clean up.
USER_ID = "e2e-deepagents-quickstart"


def report(error: Exception) -> None:
    """Where a memory failure goes. In a real deployment: your error tracker."""
    print(f"[cortadel] memory unavailable: {error}")


def main() -> None:
    memory = CortadelMemoryMiddleware(
        base_url=CORTADEL_URL,
        user_id=USER_ID,
        # api_key=os.environ["CORTADEL_API_KEY"],  # needed only when the server has auth on
        top_k=5,  # the default; recalled per turn and injected into the system prompt
        tags=["deepagents-quickstart"],
        # Memory fails open (`raise_on_error=False` by default), so a Cortadel outage still lets
        # the agent answer. `on_error` is how you find out it happened; without it the failure is
        # a `logging` warning instead.
        on_error=report,
    )

    agent = create_deep_agent(
        model=MODEL,
        system_prompt="You are a concise engineering assistant.",
        # This is the whole integration: one entry in the middleware list. `create_deep_agent`
        # keeps its own stack (filesystem, subagents, summarization) and slots ours in.
        middleware=[memory],
    )

    try:
        # --- Turn 1: tell the agent something worth remembering. -------------------------------
        # `after_agent` sends this exchange to Cortadel's `add_conversation`, which distils
        # durable facts out of it in the background.
        first = agent.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "For release notes I want three bullets maximum, no marketing "
                            "language, and the breaking changes listed first."
                        ),
                    }
                ]
            },
            {"configurable": {"thread_id": "quickstart-thread-1"}},
        )
        print("turn 1:", first["messages"][-1].text)

        # --- Turn 2: a brand-new thread, so no conversational history at all. ------------------
        # `before_agent` searches Cortadel with this message and injects the hits into the
        # system prompt, so the agent still knows the preferences stated above.
        second = agent.invoke(
            {"messages": [{"role": "user", "content": "Draft release notes for v2.0."}]},
            {"configurable": {"thread_id": "quickstart-thread-2"}},
        )
        print("turn 2:", second["messages"][-1].text)
    finally:
        # Closes the clients the middleware constructed. (A `client=` you supplied yourself is
        # left alone -- you own its lifecycle.)
        memory.close()


if __name__ == "__main__":
    main()
