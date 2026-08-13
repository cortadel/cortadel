"""The ``search_memory`` / ``add_memories`` tools: schema shape, behaviour, store resolution."""
from __future__ import annotations

import pytest
from conftest import NAMESPACE, USER, Backend, hit
from langchain_core.tools import BaseTool, StructuredTool
from langgraph.graph import END, START, StateGraph
from langgraph.store.memory import InMemoryStore
from typing_extensions import TypedDict

from cortadel_langgraph import (
    CortadelStore,
    create_add_memories_tool,
    create_memory_tools,
    create_search_memory_tool,
)


# ── Registration / schema shape ──────────────────────────────────────────────────────────────


def test_both_tools_are_langchain_tools_with_the_expected_names() -> None:
    tools = create_memory_tools(store=InMemoryStore())
    assert [tool.name for tool in tools] == ["search_memory", "add_memories"]
    for tool in tools:
        assert isinstance(tool, (BaseTool, StructuredTool))
        assert tool.description.strip()


def test_the_search_tool_advertises_a_usable_json_schema() -> None:
    schema = create_search_memory_tool(store=InMemoryStore()).args_schema.model_json_schema()
    assert set(schema["properties"]) == {"query", "top_k"}
    assert schema["required"] == ["query"]
    assert schema["properties"]["query"]["type"] == "string"
    assert schema["properties"]["top_k"]["maximum"] == 50
    # 10 is the Cortadel SDK's own SearchOptions.top_k default; an explicit search tool matches it.
    assert schema["properties"]["top_k"]["default"] == 10


def test_the_add_tool_advertises_a_list_of_strings() -> None:
    schema = create_add_memories_tool(store=InMemoryStore()).args_schema.model_json_schema()
    assert schema["required"] == ["memories"]
    assert schema["properties"]["memories"]["type"] == "array"
    assert schema["properties"]["memories"]["items"]["type"] == "string"


def test_both_tools_carry_a_sync_and_an_async_implementation() -> None:
    for tool in create_memory_tools(store=InMemoryStore()):
        assert tool.func is not None
        assert tool.coroutine is not None


def test_tool_names_and_descriptions_are_overridable() -> None:
    tool = create_search_memory_tool(
        store=InMemoryStore(), name="recall", description="Look things up."
    )
    assert tool.name == "recall"
    assert tool.description == "Look things up."


# ── Behaviour against a Cortadel store ───────────────────────────────────────────────────────


def test_search_returns_the_memories_as_tool_text(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    fake_cortadel.search_hits = [
        hit("m1", "Ships on Fridays.", score=0.87),
        hit("m2", "Prefers dark mode.", score=0.42),
    ]
    tool = create_search_memory_tool(store=store, namespace=NAMESPACE)

    output = tool.invoke({"query": "how does she work?"})

    assert "1. Ships on Fridays. (relevance 0.870)" in output
    assert "2. Prefers dark mode. (relevance 0.420)" in output
    assert fake_cortadel.first("search")[0] == "how does she work?"


def test_search_says_so_when_there_is_nothing(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    tool = create_search_memory_tool(store=store, namespace=NAMESPACE)
    assert tool.invoke({"query": "anything?"}) == "No relevant memories found."


def test_search_passes_the_models_top_k_through(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    tool = create_search_memory_tool(store=store, namespace=NAMESPACE, top_k=5)
    tool.invoke({"query": "q", "top_k": 3})
    assert fake_cortadel.first("search")[1].top_k == 3


def test_search_falls_back_to_the_configured_top_k(fake_cortadel: Backend) -> None:
    """Regression: pydantic fills the omitted argument from the *schema* default, before the
    closure's own default is ever consulted — so ``_search_schema`` must rebuild the model with
    the same field name the function takes. Rename one without the other and this configured
    value is silently ignored."""
    store = CortadelStore("http://localhost:3001", USER)
    tool = create_search_memory_tool(store=store, namespace=NAMESPACE, top_k=7)
    assert tool.args_schema.model_json_schema()["properties"]["top_k"]["default"] == 7
    tool.invoke({"query": "q"})
    assert fake_cortadel.first("search")[1].top_k == 7


def test_create_memory_tools_forwards_top_k_to_the_search_tool(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    search, _add = create_memory_tools(store=store, namespace=NAMESPACE, top_k=4)
    search.invoke({"query": "q"})
    assert fake_cortadel.first("search")[1].top_k == 4


def test_add_memories_writes_one_memory_per_fact(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    tool = create_add_memories_tool(store=store, namespace=NAMESPACE)

    output = tool.invoke({"memories": ["Ships on Fridays.", "Prefers dark mode."]})

    assert output == "Stored 2 memories."
    assert fake_cortadel.count("add") == 2
    assert fake_cortadel.first("add")[0] == "Ships on Fridays."


def test_add_memories_ignores_blank_entries(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    tool = create_add_memories_tool(store=store, namespace=NAMESPACE)
    assert tool.invoke({"memories": ["  ", ""]}) == (
        "Nothing to store: no non-empty memories were provided."
    )
    assert fake_cortadel.count("add") == 0


def test_a_server_failure_reaches_the_model_as_a_plain_no_results_answer(
    fake_cortadel: Backend,
) -> None:
    from cortadel import CortadelError

    store = CortadelStore("http://localhost:3001", USER)  # fails open by default
    fake_cortadel.failures["search"] = CortadelError(0, "transport_error", "down")
    tool = create_search_memory_tool(store=store, namespace=NAMESPACE)

    # The agent keeps running; it just learns there is nothing to recall.
    assert tool.invoke({"query": "q"}) == "No relevant memories found."


# ── Portability: the tools speak BaseStore, not Cortadel ─────────────────────────────────────


def test_the_tools_work_against_any_basestore() -> None:
    store = InMemoryStore()
    add = create_add_memories_tool(store=store, namespace=("memories", USER))
    search = create_search_memory_tool(store=store, namespace=("memories", USER))

    add.invoke({"memories": ["Ships on Fridays."]})

    assert "Ships on Fridays." in search.invoke({"query": "shipping"})


# ── Store resolution ─────────────────────────────────────────────────────────────────────────


def test_a_tool_with_no_store_explains_itself_outside_a_graph() -> None:
    tool = create_search_memory_tool()
    with pytest.raises(RuntimeError, match="No store is available"):
        tool.invoke({"query": "q"})


class _State(TypedDict):
    result: str


def test_a_tool_with_no_store_finds_the_compiled_one(fake_cortadel: Backend) -> None:
    """The idiomatic wiring: compile the graph with the store, and the tools just work."""
    store = CortadelStore("http://localhost:3001", USER)
    fake_cortadel.search_hits = [hit("m1", "Ships on Fridays.")]
    tool = create_search_memory_tool(namespace=NAMESPACE)  # note: no store=

    def node(state: _State) -> _State:
        return {"result": tool.invoke({"query": "how does she work?"})}

    graph = StateGraph(_State).add_node("node", node)
    graph.add_edge(START, "node")
    graph.add_edge("node", END)

    output = graph.compile(store=store).invoke({"result": ""})

    assert "Ships on Fridays." in output["result"]
    assert fake_cortadel.count("search") == 1


def test_a_templated_namespace_resolves_from_the_runnable_config(fake_cortadel: Backend) -> None:
    """One tool, many users: {user_id} comes from config['configurable'] on each call."""
    store = CortadelStore("http://localhost:3001", lambda ns: ns[-1])
    tool = create_search_memory_tool(store=store, namespace=("memories", "{user_id}"))

    def node(state: _State) -> _State:
        return {"result": tool.invoke({"query": "q"})}

    graph = StateGraph(_State).add_node("node", node)
    graph.add_edge(START, "node")
    graph.add_edge("node", END)
    compiled = graph.compile()

    compiled.invoke({"result": ""}, config={"configurable": {"user_id": USER}})

    assert fake_cortadel.users() == [USER]


def test_an_unresolvable_namespace_placeholder_says_what_is_missing(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    tool = create_search_memory_tool(store=store, namespace=("memories", "{user_id}"))

    def node(state: _State) -> _State:
        return {"result": tool.invoke({"query": "q"})}

    graph = StateGraph(_State).add_node("node", node)
    graph.add_edge(START, "node")
    graph.add_edge("node", END)

    with pytest.raises(ValueError, match="missing 'user_id'"):
        graph.compile().invoke({"result": ""})


# ── Async ────────────────────────────────────────────────────────────────────────────────────


async def test_the_tools_run_asynchronously(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER)
    fake_cortadel.search_hits = [hit("m1", "An async fact.")]
    search = create_search_memory_tool(store=store, namespace=NAMESPACE)
    add = create_add_memories_tool(store=store, namespace=NAMESPACE)

    assert "An async fact." in await search.ainvoke({"query": "q"})
    assert await add.ainvoke({"memories": ["Another fact."]}) == "Stored 1 memory."
    # Async calls must go through the async Cortadel client, never the blocking one.
    assert {c["kind"] for c in fake_cortadel.constructed} == {"async"}
