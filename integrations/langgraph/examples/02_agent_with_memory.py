"""A LangGraph agent that remembers across conversations.

This wires up all three capabilities at once:

* `store=`            — Cortadel as the agent's long-term memory backend (`BaseStore`)
* `tools=`            — `search_memory` / `add_memories`, for when the agent decides to look
* `pre/post_model_hook` — automatic recall and persistence, for when it doesn't

The point of the demo is the *second* run: it uses a different `thread_id`, so the checkpointer
gives it an empty transcript, and anything the agent still knows came from Cortadel.

Run it:

    docker compose up                      # from the cortadel repo root -> http://localhost:3001
    export ANTHROPIC_API_KEY=...           # or swap the model line for any LangChain chat model
    uv run --with cortadel-langgraph --with "langchain[anthropic]" python examples/02_agent_with_memory.py
"""
from __future__ import annotations

import os

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.prebuilt import create_react_agent

from cortadel_langgraph import CortadelMemory, CortadelStore, create_memory_tools

BASE_URL = os.environ.get("CORTADEL_URL", "http://localhost:3001")
API_KEY = os.environ.get("CORTADEL_API_KEY")

USER_ID = "e2e-langgraph-agent-demo"  # e2e-* — this writes to a real server
NAMESPACE = ("memories", USER_ID)

store = CortadelStore(BASE_URL, USER_ID, api_key=API_KEY)

# Automatic memory. `recall_node` searches Cortadel with the user's message and prepends the hits
# for this model call only (via `llm_input_messages`, which create_react_agent treats as
# ephemeral), so recalled memories never pile up in the transcript. `remember_node` hands each
# finished turn to Cortadel's conversation-ingest pipeline, which distils the durable facts.
memory = CortadelMemory(store, namespace=NAMESPACE)

agent = create_react_agent(
    model="anthropic:claude-sonnet-4-5",
    # The explicit tools are complementary, not redundant: the hooks cover "what is relevant to
    # what was just said", the tools cover "go and look something specific up / write this down".
    tools=create_memory_tools(store=store, namespace=NAMESPACE),
    prompt="You are a helpful assistant with a long memory. Be concise.",
    store=store,
    pre_model_hook=memory.pre_model_hook,
    post_model_hook=memory.post_model_hook,
    checkpointer=InMemorySaver(),
)


def say(text: str, thread_id: str) -> None:
    print(f"\n[thread {thread_id}] you: {text}")
    result = agent.invoke(
        {"messages": [HumanMessage(text)]},
        config={"configurable": {"thread_id": thread_id}},
    )
    print(f"[thread {thread_id}] agent: {result['messages'][-1].content}")


def main() -> None:
    if store.health(NAMESPACE) is None:
        raise SystemExit(f"No Cortadel server at {BASE_URL}. Start one with `docker compose up`.")

    # --- Conversation one -------------------------------------------------------------------
    say("Hi! I'm Robin. I only ship releases on Fridays, and I'm allergic to shellfish.", "conv-1")
    say("What's a good rule of thumb for release notes?", "conv-1")

    # Cortadel's extraction pipeline runs off the request path, so give it a moment before the
    # facts from conversation one become searchable.
    print("\n(waiting for Cortadel to extract facts from conversation one...)")
    import time

    time.sleep(5)

    # --- Conversation two: a brand-new thread, so the transcript is empty -------------------
    # Anything the agent knows here came out of Cortadel, not out of the checkpointer.
    say("When should we schedule the next deploy? And where should we get lunch?", "conv-2")


if __name__ == "__main__":
    try:
        main()
    finally:
        store.close()
