"""End-to-end tests through a real compiled `create_deep_agent` graph.

No network and no LLM: the model is a fake that records the prompts it is given, and the Cortadel
client is the stub from `conftest`. What is real is everything in between — the DeepAgents
middleware stack, the LangGraph checkpointer, the tool node and its `ToolRuntime` injection.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from conftest import (
    OTHER_USER_ID,
    USER_ID,
    FakeCortadelClient,
    RecordingFakeChatModel,
    hit,
    transport_error,
)
from cortadel_deepagents import CortadelMemoryMiddleware
from deepagents import create_deep_agent
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver


@dataclass
class UserContext:
    """The typed run context a multi-user deep agent declares via `context_schema`."""

    user_id: str


def build_agent(
    middleware: CortadelMemoryMiddleware,
    responses: list[AIMessage],
    *,
    checkpointer: Any = None,
    context_schema: type | None = None,
) -> tuple[Any, RecordingFakeChatModel]:
    model = RecordingFakeChatModel(responses)
    agent = create_deep_agent(
        model=model,
        system_prompt="You are a test agent.",
        middleware=[middleware],
        checkpointer=checkpointer,
        context_schema=context_schema,
    )
    return agent, model


def turn(text: str) -> dict[str, Any]:
    return {"messages": [{"role": "user", "content": text}]}


def test_a_full_turn_recalls_injects_and_persists() -> None:
    client = FakeCortadelClient(
        hits=[hit("m1", "Prefers terse release notes.", created_at="2026-01-02T03:04:05Z")]
    )
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)
    agent, model = build_agent(middleware, [AIMessage(content="Here are the notes.")])

    result = agent.invoke(turn("draft the release notes"), {"configurable": {"thread_id": "t-1"}})

    # 1. Retrieved with the user's message.
    assert [call.query for call in client.searches] == ["draft the release notes"]
    # 2. Injected into the system prompt the model actually saw.
    prompt = model.system_prompts[0]
    assert "You are a test agent." in prompt
    assert "1. Prefers terse release notes. [recorded 2026-01-02]" in prompt
    # 3. Persisted after the turn, scoped to the LangGraph thread.
    assert [(m.role, m.content) for m in client.conversations[0].messages] == [
        ("user", "draft the release notes"),
        ("assistant", "Here are the notes."),
    ]
    assert client.conversations[0].options.session_id == "t-1"
    assert result["messages"][-1].text == "Here are the notes."


def test_private_state_stays_out_of_the_agents_output() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Fact.")])
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)
    agent, _ = build_agent(middleware, [AIMessage(content="ok")])

    result = agent.invoke(turn("hello"), {"configurable": {"thread_id": "t-1"}})

    assert not [key for key in result if key.startswith("cortadel_")]


def test_a_second_turn_on_the_same_thread_re_searches_but_does_not_re_ingest() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Fact.")])
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)
    agent, _ = build_agent(
        middleware,
        [AIMessage(content="first answer"), AIMessage(content="second answer")],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "t-1"}}

    agent.invoke(turn("first question"), config)
    agent.invoke(turn("second question"), config)

    assert [call.query for call in client.searches] == ["first question", "second question"]
    assert [[(m.role, m.content) for m in call.messages] for call in client.conversations] == [
        [("user", "first question"), ("assistant", "first answer")],
        [("user", "second question"), ("assistant", "second answer")],
    ]


def test_one_agent_serves_many_users_via_context_schema() -> None:
    clients: dict[str, FakeCortadelClient] = {}

    def factory(user_id: str) -> Any:
        clients[user_id] = FakeCortadelClient(
            user_id=user_id, hits=[hit("m1", f"A fact about {user_id}.")]
        )
        return clients[user_id]

    middleware = CortadelMemoryMiddleware(client_factory=factory, raise_on_error=True)
    agent, model = build_agent(
        middleware,
        [AIMessage(content="one"), AIMessage(content="two")],
        context_schema=UserContext,
    )

    agent.invoke(turn("hello"), {"configurable": {"thread_id": "t-1"}}, context=UserContext(user_id=USER_ID))
    agent.invoke(
        turn("hello"), {"configurable": {"thread_id": "t-2"}}, context=UserContext(user_id=OTHER_USER_ID)
    )

    assert set(clients) == {USER_ID, OTHER_USER_ID}
    assert len(clients[USER_ID].conversations) == 1
    assert len(clients[OTHER_USER_ID].conversations) == 1
    assert f"A fact about {USER_ID}." in model.system_prompts[0]
    assert f"A fact about {OTHER_USER_ID}." in model.system_prompts[1]


def test_the_agent_can_call_search_memory_itself() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode.")])
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)
    agent, _ = build_agent(
        middleware,
        [
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "search_memory", "args": {"query": "ui preferences"}, "id": "tc-1"}
                ],
            ),
            AIMessage(content="You prefer dark mode."),
        ],
    )

    result = agent.invoke(turn("what do you know about me?"), {"configurable": {"thread_id": "t-1"}})

    tool_messages = [m for m in result["messages"] if m.type == "tool"]
    assert len(tool_messages) == 1
    assert "1. Prefers dark mode." in tool_messages[0].text
    # The automatic recall plus the agent's own explicit lookup.
    assert [call.query for call in client.searches] == ["what do you know about me?", "ui preferences"]


def test_the_agent_can_call_add_memories_itself() -> None:
    client = FakeCortadelClient()
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)
    agent, _ = build_agent(
        middleware,
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "add_memories",
                        "args": {"memories": ["Prefers dark mode."]},
                        "id": "tc-1",
                    }
                ],
            ),
            AIMessage(content="Noted."),
        ],
    )

    agent.invoke(turn("remember I like dark mode"), {"configurable": {"thread_id": "t-1"}})

    assert [call.text for call in client.adds] == ["Prefers dark mode."]


def test_an_unreachable_cortadel_does_not_break_the_agent() -> None:
    # The whole point of degrading gracefully: the turn still completes.
    client = FakeCortadelClient(fail_with=transport_error())
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID)
    agent, model = build_agent(middleware, [AIMessage(content="still works")])

    result = agent.invoke(turn("hello"), {"configurable": {"thread_id": "t-1"}})

    assert result["messages"][-1].text == "still works"
    assert "no relevant memories recalled" in model.system_prompts[0]


async def test_the_async_agent_path_works_end_to_end() -> None:
    client = FakeCortadelClient(hits=[hit("m1", "Prefers dark mode.")])
    middleware = CortadelMemoryMiddleware(client=client, user_id=USER_ID, raise_on_error=True)
    agent, model = build_agent(middleware, [AIMessage(content="ok")])

    result = await agent.ainvoke(turn("what do I like?"), {"configurable": {"thread_id": "t-1"}})

    assert [call.query for call in client.searches] == ["what do I like?"]
    assert "1. Prefers dark mode." in model.system_prompts[0]
    assert [(m.role, m.content) for m in client.conversations[0].messages] == [
        ("user", "what do I like?"),
        ("assistant", "ok"),
    ]
    assert result["messages"][-1].text == "ok"
