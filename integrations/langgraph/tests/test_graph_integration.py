"""End-to-end wiring: a real compiled ``StateGraph`` with recall and persist as nodes.

No LLM and no server — the "model" is a node that echoes what it was given — but the graph, the
checkpointer, the store injection and both memory nodes are the real ones. This is the test that
would catch a hook whose return shape LangGraph refuses to accept.
"""
from __future__ import annotations

from typing import Annotated

from conftest import NAMESPACE, USER, Backend, hit
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

from cortadel_langgraph import CortadelMemory, CortadelStore


class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    # Mirrors the schema create_react_agent builds for itself when a pre_model_hook is present:
    # no reducer, so each turn overwrites it and nothing accumulates.
    llm_input_messages: list[AnyMessage]
    seen: list[str]


def build(store: CortadelStore):
    memory = CortadelMemory(store, namespace=NAMESPACE)

    def model(state: AgentState) -> dict:
        # Whatever recall handed us is what the model would really have seen.
        given = state.get("llm_input_messages") or state["messages"]
        return {
            "messages": [AIMessage("acknowledged", id=f"a{len(state['messages'])}")],
            "seen": [type(message).__name__ for message in given],
        }

    graph = StateGraph(AgentState)
    graph.add_node("recall", memory.recall_node)
    graph.add_node("model", model)
    graph.add_node("remember", memory.remember_node)
    graph.add_edge(START, "recall")
    graph.add_edge("recall", "model")
    graph.add_edge("model", "remember")
    graph.add_edge("remember", END)
    return graph.compile(checkpointer=InMemorySaver())


def test_a_turn_recalls_before_the_model_and_persists_after(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER, raise_on_error=True)
    fake_cortadel.search_hits = [hit("m1", "Ships on Fridays.")]
    agent = build(store)
    config = {"configurable": {"thread_id": "t-1"}}

    result = agent.invoke({"messages": [HumanMessage("when does she ship?", id="h1")]}, config)

    # 1. The model saw the memory block prepended to the conversation...
    assert result["seen"] == ["SystemMessage", "HumanMessage"]
    # 2. ...which came from a real Cortadel search on the user's message...
    assert fake_cortadel.first("search")[0] == "when does she ship?"
    # 3. ...and the completed turn went to Cortadel's conversation-ingest pipeline.
    messages, options = fake_cortadel.first("add_conversation")
    assert [(m.role, m.content) for m in messages] == [
        ("user", "when does she ship?"),
        ("assistant", "acknowledged"),
    ]
    assert options.session_id == "t-1"
    # 4. The injected block never entered the durable transcript.
    assert [type(m).__name__ for m in result["messages"]] == ["HumanMessage", "AIMessage"]
    assert not any(isinstance(m, SystemMessage) for m in result["messages"])


def test_a_second_turn_persists_only_what_is_new(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER, raise_on_error=True)
    fake_cortadel.search_hits = [hit("m1", "Ships on Fridays.")]
    agent = build(store)
    config = {"configurable": {"thread_id": "t-1"}}

    agent.invoke({"messages": [HumanMessage("first question", id="h1")]}, config)
    agent.invoke({"messages": [HumanMessage("second question", id="h2")]}, config)

    ingests = [call for call in fake_cortadel.calls if call[1] == "add_conversation"]
    assert len(ingests) == 2
    assert [m.content for m in ingests[0][2][0]] == ["first question", "acknowledged"]
    assert [m.content for m in ingests[1][2][0]] == ["second question", "acknowledged"]
    # Two user turns, two searches — the second turn is not answered from the first turn's cache.
    assert fake_cortadel.count("search") == 2


def test_two_threads_are_two_conversations(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER, raise_on_error=True)
    agent = build(store)

    agent.invoke({"messages": [HumanMessage("hi", id="h1")]}, {"configurable": {"thread_id": "a"}})
    agent.invoke({"messages": [HumanMessage("hi", id="h2")]}, {"configurable": {"thread_id": "b"}})

    sessions = [
        call[2][1].session_id for call in fake_cortadel.calls if call[1] == "add_conversation"
    ]
    assert sessions == ["a", "b"]


def test_the_agent_still_answers_when_cortadel_is_down(fake_cortadel: Backend) -> None:
    """The whole point of the degradation policy: no memory, but the graph still completes."""
    from cortadel import CortadelError

    store = CortadelStore("http://localhost:3001", USER)  # fails open by default
    fake_cortadel.failures["search"] = CortadelError(0, "transport_error", "connection refused")
    fake_cortadel.failures["add_conversation"] = CortadelError(0, "transport_error", "refused")
    agent = build(store)

    result = agent.invoke(
        {"messages": [HumanMessage("hello", id="h1")]}, {"configurable": {"thread_id": "t-1"}}
    )

    assert result["seen"] == ["HumanMessage"]  # no memory block, because there is no memory
    assert result["messages"][-1].content == "acknowledged"


async def test_the_same_graph_runs_asynchronously(fake_cortadel: Backend) -> None:
    store = CortadelStore("http://localhost:3001", USER, raise_on_error=True)
    fake_cortadel.search_hits = [hit("m1", "Ships on Fridays.")]
    memory = CortadelMemory(store, namespace=NAMESPACE)

    async def model(state: AgentState) -> dict:
        given = state.get("llm_input_messages") or state["messages"]
        return {
            "messages": [AIMessage("acknowledged", id="a1")],
            "seen": [type(message).__name__ for message in given],
        }

    graph = StateGraph(AgentState)
    graph.add_node("recall", memory.arecall_node)
    graph.add_node("model", model)
    graph.add_node("remember", memory.aremember_node)
    graph.add_edge(START, "recall")
    graph.add_edge("recall", "model")
    graph.add_edge("model", "remember")
    graph.add_edge("remember", END)
    agent = graph.compile(checkpointer=InMemorySaver())

    result = await agent.ainvoke(
        {"messages": [HumanMessage("hi", id="h1")]}, {"configurable": {"thread_id": "t-1"}}
    )

    assert result["seen"] == ["SystemMessage", "HumanMessage"]
    assert fake_cortadel.count("add_conversation") == 1
    assert {c["kind"] for c in fake_cortadel.constructed} == {"async"}


def test_the_store_reaches_nodes_through_get_store(fake_cortadel: Backend) -> None:
    """CortadelMemory(store=None) picks up whatever the graph was compiled with."""
    store = CortadelStore("http://localhost:3001", USER, raise_on_error=True)
    fake_cortadel.search_hits = [hit("m1", "A fact.")]
    memory = CortadelMemory(namespace=NAMESPACE)  # note: no store=

    graph = StateGraph(AgentState)
    graph.add_node("recall", memory.recall_node)
    graph.add_edge(START, "recall")
    graph.add_edge("recall", END)

    result = graph.compile(store=store).invoke({"messages": [HumanMessage("hi", id="h1")]})

    assert isinstance(result["llm_input_messages"][0], SystemMessage)
    assert fake_cortadel.count("search") == 1
