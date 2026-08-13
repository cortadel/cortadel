"""One graph, many users — a hand-built StateGraph with templated namespaces.

Two things this shows that the prebuilt-agent example does not:

1. **The current, non-deprecated LangGraph API.** `create_react_agent` moved to
   `langchain.agents.create_agent` in LangGraph 1.0; a plain `StateGraph` never went anywhere, and
   `CortadelMemory`'s nodes are ordinary node callables, so they drop straight in.
2. **Multi-tenancy.** The namespace is a template, `("memories", "{user_id}")`, resolved per
   invocation from `config["configurable"]`. `namespace_user_id(-1)` then turns the resolved
   namespace back into the Cortadel user id, and the store keeps one client per user — which is
   required, because a Cortadel client is bound to a single user at construction.

Run it:

    docker compose up                      # from the cortadel repo root -> http://localhost:3001
    export ANTHROPIC_API_KEY=...
    uv run --with cortadel-langgraph --with "langchain[anthropic]" python examples/03_multi_user_graph.py
"""
from __future__ import annotations

import os
from typing import Annotated

from langchain.chat_models import init_chat_model
from langchain_core.messages import AnyMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

from cortadel_langgraph import CortadelMemory, CortadelStore, namespace_user_id

BASE_URL = os.environ.get("CORTADEL_URL", "http://localhost:3001")
API_KEY = os.environ.get("CORTADEL_API_KEY")

# One store for every user. The callable picks the Cortadel user id out of the namespace.
store = CortadelStore(BASE_URL, namespace_user_id(-1), api_key=API_KEY)

# `{user_id}` is filled from config["configurable"]["user_id"] on every call.
memory = CortadelMemory(store, namespace=("memories", "{user_id}"))

model = init_chat_model("anthropic:claude-sonnet-4-5")


class State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    # `recall_node` writes here by default. No reducer, so each turn overwrites it and the
    # injected memory block never accumulates in state — the same schema create_react_agent
    # builds for itself when it has a pre_model_hook.
    llm_input_messages: list[AnyMessage]


def call_model(state: State) -> dict:
    # Use what recall handed us when it ran; fall back to the raw transcript otherwise.
    messages = state.get("llm_input_messages") or state["messages"]
    return {"messages": [model.invoke(messages)]}


builder = StateGraph(State)
builder.add_node("recall", memory.recall_node)  # before the model: inject relevant memories
builder.add_node("model", call_model)
builder.add_node("remember", memory.remember_node)  # after the turn: persist it to Cortadel
builder.add_edge(START, "recall")
builder.add_edge("recall", "model")
builder.add_edge("model", "remember")
builder.add_edge("remember", END)

graph = builder.compile(checkpointer=InMemorySaver())


def say(text: str, *, user_id: str, thread_id: str) -> None:
    print(f"\n[{user_id}] you: {text}")
    result = graph.invoke(
        {"messages": [HumanMessage(text)]},
        # thread_id scopes the short-term transcript; user_id scopes the long-term memory.
        # They are independent: a user has many threads, and memory crosses all of them.
        config={"configurable": {"thread_id": thread_id, "user_id": user_id}},
    )
    print(f"[{user_id}] agent: {result['messages'][-1].content}")


def main() -> None:
    alice = "e2e-langgraph-alice"
    bob = "e2e-langgraph-bob"

    if store.health(("memories", alice)) is None:
        raise SystemExit(f"No Cortadel server at {BASE_URL}. Start one with `docker compose up`.")

    say("I'm a vegetarian and I bike to work.", user_id=alice, thread_id="a1")
    say("I eat steak twice a week and I drive.", user_id=bob, thread_id="b1")

    print("\n(waiting for Cortadel to extract facts...)")
    import time

    time.sleep(5)

    # New threads. Each user's memories are namespaced to them, so neither answer can leak the
    # other's facts.
    say("Suggest somewhere for me to have lunch.", user_id=alice, thread_id="a2")
    say("Suggest somewhere for me to have lunch.", user_id=bob, thread_id="b2")


if __name__ == "__main__":
    try:
        main()
    finally:
        store.close()
