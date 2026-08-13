"""``CortadelMemory`` — the automatic recall-then-persist path."""
from __future__ import annotations

import pytest
from conftest import NAMESPACE, USER, Backend, hit
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.store.memory import InMemoryStore

from cortadel_langgraph import CortadelMemory, CortadelStore

THREAD = {"configurable": {"thread_id": "t-1"}}


@pytest.fixture
def memory(store: CortadelStore) -> CortadelMemory:
    return CortadelMemory(store, namespace=NAMESPACE)


def state(*messages) -> dict:
    return {"messages": list(messages)}


# ── Retrieve -> inject ───────────────────────────────────────────────────────────────────────


def test_recall_searches_with_the_latest_user_message(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [hit("m1", "Ships on Fridays.")]

    memory.recall_node(state(HumanMessage("when does she ship?", id="h1")), THREAD)

    assert fake_cortadel.first("search")[0] == "when does she ship?"


def test_recall_prepends_the_memories_as_a_system_message(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [hit("m1", "Ships on Fridays."), hit("m2", "Prefers dark mode.")]
    human = HumanMessage("what do you know?", id="h1")

    update = memory.recall_node(state(human), THREAD)

    injected = update["llm_input_messages"]
    assert isinstance(injected[0], SystemMessage)
    assert "- Ships on Fridays." in injected[0].content
    assert "- Prefers dark mode." in injected[0].content
    # The original transcript follows, untouched.
    assert injected[1:] == [human]


def test_recall_writes_to_the_ephemeral_channel_not_to_messages(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    """This is what stops recalled memories accumulating in the transcript turn after turn."""
    fake_cortadel.search_hits = [hit("m1", "A fact.")]
    update = memory.recall_node(state(HumanMessage("hi", id="h1")), THREAD)
    assert set(update) == {"llm_input_messages"}
    assert "messages" not in update


def test_recall_injects_nothing_when_there_are_no_memories(
    memory: CortadelMemory,
) -> None:
    human = HumanMessage("hi", id="h1")
    update = memory.recall_node(state(human), THREAD)
    assert update["llm_input_messages"] == [human]


def test_recall_is_skipped_when_the_conversation_has_no_user_message(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    update = memory.recall_node(state(SystemMessage("you are a bot", id="s1")), THREAD)
    assert fake_cortadel.count("search") == 0
    assert len(update["llm_input_messages"]) == 1


def test_recall_searches_once_per_user_turn_not_once_per_model_call(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    """In a tool loop the model is called repeatedly; the memory block must be reused."""
    fake_cortadel.search_hits = [hit("m1", "A fact.")]
    human = HumanMessage("do the thing", id="h1")
    tool_call = AIMessage(
        "", id="a1", tool_calls=[{"name": "t", "args": {}, "id": "c1", "type": "tool_call"}]
    )
    observation = ToolMessage("done", tool_call_id="c1", id="t1")

    first = memory.recall_node(state(human), THREAD)
    second = memory.recall_node(state(human, tool_call, observation), THREAD)

    assert fake_cortadel.count("search") == 1
    assert first["llm_input_messages"][0].content == second["llm_input_messages"][0].content


def test_a_new_user_turn_triggers_a_fresh_search(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [hit("m1", "A fact.")]
    first = HumanMessage("first", id="h1")
    memory.recall_node(state(first), THREAD)
    memory.recall_node(state(first, AIMessage("ok", id="a1"), HumanMessage("second", id="h2")), THREAD)

    assert fake_cortadel.count("search") == 2
    assert fake_cortadel.calls[1][2][0] == "second"


def test_separate_threads_do_not_share_a_recall_cache(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [hit("m1", "A fact.")]
    same_text = "hello"
    memory.recall_node(state(HumanMessage(same_text, id="h1")), {"configurable": {"thread_id": "a"}})
    memory.recall_node(state(HumanMessage(same_text, id="h1")), {"configurable": {"thread_id": "b"}})
    assert fake_cortadel.count("search") == 2


def test_recall_can_be_turned_off(store: CortadelStore, fake_cortadel: Backend) -> None:
    memory = CortadelMemory(store, namespace=NAMESPACE, recall=False)
    human = HumanMessage("hi", id="h1")
    assert memory.recall_node(state(human), THREAD)["llm_input_messages"] == [human]
    assert fake_cortadel.count("search") == 0


def test_the_injection_target_is_configurable(store: CortadelStore, fake_cortadel: Backend) -> None:
    fake_cortadel.search_hits = [hit("m1", "A fact.")]
    memory = CortadelMemory(store, namespace=NAMESPACE, output_key="context", header="Known:")
    update = memory.recall_node(state(HumanMessage("hi", id="h1")), THREAD)
    assert set(update) == {"context"}
    assert update["context"][0].content.startswith("Known:")


def test_top_k_bounds_how_many_memories_are_injected(
    store: CortadelStore, fake_cortadel: Backend
) -> None:
    memory = CortadelMemory(store, namespace=NAMESPACE, top_k=3)
    memory.recall_node(state(HumanMessage("hi", id="h1")), THREAD)
    assert fake_cortadel.first("search")[1].top_k == 3


def test_top_k_defaults_to_five_for_automatic_injection(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    """Every turn pays for this search, so the automatic path is deliberately narrower than the
    explicit ``search_memory`` tool (which defaults to the SDK's own 10)."""
    memory.recall_node(state(HumanMessage("hi", id="h1")), THREAD)
    assert fake_cortadel.first("search")[1].top_k == 5


def test_recall_handles_content_block_messages(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    human = HumanMessage(content=[{"type": "text", "text": "block content"}], id="h1")
    memory.recall_node(state(human), THREAD)
    assert fake_cortadel.first("search")[0] == "block content"


# ── Persist after the turn ───────────────────────────────────────────────────────────────────


def test_a_finished_turn_is_handed_to_add_conversation(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    memory.remember_node(
        state(HumanMessage("hi", id="h1"), AIMessage("hello", id="a1")), THREAD
    )

    messages, options = fake_cortadel.first("add_conversation")
    assert [(m.role, m.content) for m in messages] == [("user", "hi"), ("assistant", "hello")]
    # Producer-side turn ids ride along as pointer anchors on the extracted facts.
    assert [m.uuid for m in messages] == ["h1", "a1"]
    assert options.session_id == "t-1"


def test_persistence_is_a_side_effect_not_a_state_update(memory: CortadelMemory) -> None:
    update = memory.remember_node(state(HumanMessage("hi", id="h1"), AIMessage("yo", id="a1")), THREAD)
    assert update == {}


def test_nothing_is_persisted_mid_tool_loop(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    pending = AIMessage(
        "", id="a1", tool_calls=[{"name": "t", "args": {}, "id": "c1", "type": "tool_call"}]
    )
    memory.remember_node(state(HumanMessage("hi", id="h1"), pending), THREAD)
    memory.remember_node(
        state(HumanMessage("hi", id="h1"), pending, ToolMessage("done", tool_call_id="c1", id="t1")),
        THREAD,
    )
    assert fake_cortadel.count("add_conversation") == 0


def test_tool_traffic_is_excluded_from_what_is_persisted(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    memory.remember_node(
        state(
            HumanMessage("hi", id="h1"),
            AIMessage("", id="a1", tool_calls=[{"name": "t", "args": {}, "id": "c1", "type": "tool_call"}]),
            ToolMessage("raw tool payload", tool_call_id="c1", id="t1"),
            AIMessage("the answer", id="a2"),
        ),
        THREAD,
    )
    messages, _options = fake_cortadel.first("add_conversation")
    assert [(m.role, m.content) for m in messages] == [("user", "hi"), ("assistant", "the answer")]


def test_each_message_is_persisted_at_most_once(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    turn_one = [HumanMessage("hi", id="h1"), AIMessage("hello", id="a1")]
    memory.remember_node(state(*turn_one), THREAD)

    turn_two = turn_one + [HumanMessage("and again", id="h2"), AIMessage("sure", id="a2")]
    memory.remember_node(state(*turn_two), THREAD)

    assert fake_cortadel.count("add_conversation") == 2
    second_call = [call for call in fake_cortadel.calls if call[1] == "add_conversation"][1]
    assert [m.content for m in second_call[2][0]] == ["and again", "sure"]


def test_a_repeated_call_on_an_unchanged_transcript_stores_nothing_new(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    messages = state(HumanMessage("hi", id="h1"), AIMessage("hello", id="a1"))
    memory.remember_node(messages, THREAD)
    memory.remember_node(messages, THREAD)
    assert fake_cortadel.count("add_conversation") == 1


def test_a_trimmed_transcript_falls_back_to_the_current_turn_only(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    """If the cursor message is gone (summarised away), do not replay the whole history."""
    memory.remember_node(state(HumanMessage("hi", id="h1"), AIMessage("hello", id="a1")), THREAD)
    memory.remember_node(
        state(
            AIMessage("...summary...", id="s9"),
            HumanMessage("new question", id="h2"),
            AIMessage("new answer", id="a2"),
        ),
        THREAD,
    )
    second_call = [call for call in fake_cortadel.calls if call[1] == "add_conversation"][1]
    assert [m.content for m in second_call[2][0]] == ["new question", "new answer"]


def test_separate_threads_keep_separate_cursors(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    turn = state(HumanMessage("hi", id="h1"), AIMessage("hello", id="a1"))
    memory.remember_node(turn, {"configurable": {"thread_id": "a"}})
    memory.remember_node(turn, {"configurable": {"thread_id": "b"}})
    assert fake_cortadel.count("add_conversation") == 2


def test_persistence_can_be_turned_off(store: CortadelStore, fake_cortadel: Backend) -> None:
    memory = CortadelMemory(store, namespace=NAMESPACE, persist=False)
    memory.remember_node(state(HumanMessage("hi", id="h1"), AIMessage("yo", id="a1")), THREAD)
    assert fake_cortadel.count("add_conversation") == 0


def test_project_and_tags_are_forwarded(store: CortadelStore, fake_cortadel: Backend) -> None:
    memory = CortadelMemory(store, namespace=NAMESPACE, project="demo", tags=["agent"])
    memory.remember_node(state(HumanMessage("hi", id="h1"), AIMessage("yo", id="a1")), THREAD)
    _messages, options = fake_cortadel.first("add_conversation")
    assert options.project == "demo"
    assert options.tags == ["agent"]


# ── Degradation ──────────────────────────────────────────────────────────────────────────────


def test_an_unreachable_server_leaves_the_transcript_intact(fake_cortadel: Backend) -> None:
    from cortadel import CortadelError

    store = CortadelStore("http://localhost:3001", USER)  # fails open by default
    fake_cortadel.failures["search"] = CortadelError(0, "transport_error", "connection refused")
    fake_cortadel.failures["add_conversation"] = CortadelError(0, "transport_error", "refused")
    memory = CortadelMemory(store, namespace=NAMESPACE)
    human = HumanMessage("hi", id="h1")

    assert memory.recall_node(state(human), THREAD)["llm_input_messages"] == [human]
    assert memory.remember_node(state(human, AIMessage("yo", id="a1")), THREAD) == {}


def test_no_store_at_all_is_survivable(caplog: pytest.LogCaptureFixture) -> None:
    memory = CortadelMemory(namespace=NAMESPACE)  # no store, and not inside a graph
    human = HumanMessage("hi", id="h1")
    with caplog.at_level("WARNING", logger="cortadel_langgraph"):
        assert memory.recall_node(state(human), THREAD)["llm_input_messages"] == [human]
        assert memory.remember_node(state(human, AIMessage("yo", id="a1")), THREAD) == {}
    assert any("found no store" in record.getMessage() for record in caplog.records)


def test_a_non_cortadel_store_still_recalls_but_cannot_persist(
    caplog: pytest.LogCaptureFixture,
) -> None:
    plain = InMemoryStore()
    plain.put(NAMESPACE, "k1", {"content": "Ships on Fridays."})
    memory = CortadelMemory(plain, namespace=NAMESPACE)

    with caplog.at_level("WARNING", logger="cortadel_langgraph"):
        recalled = memory.recall_node(state(HumanMessage("hi", id="h1")), THREAD)
        assert memory.remember_node(state(HumanMessage("hi", id="h1"), AIMessage("yo", id="a1")), THREAD) == {}

    # Recall works against any BaseStore...
    assert "Ships on Fridays." in recalled["llm_input_messages"][0].content
    # ...but add_conversation is Cortadel-only, and that is said out loud exactly once.
    messages = [r.getMessage() for r in caplog.records if "add_conversation" in r.getMessage()]
    assert len(messages) == 1
    assert "InMemoryStore" in messages[0]


# ── Hook plumbing ────────────────────────────────────────────────────────────────────────────


def test_the_hooks_are_runnables_usable_as_pre_and_post_model_hooks(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [hit("m1", "A fact.")]

    pre = memory.pre_model_hook.invoke(state(HumanMessage("hi", id="h1")), config=THREAD)
    post = memory.post_model_hook.invoke(
        state(HumanMessage("hi", id="h1"), AIMessage("yo", id="a1")), config=THREAD
    )

    assert memory.pre_model_hook.get_name() == "cortadel_recall"
    assert memory.post_model_hook.get_name() == "cortadel_remember"
    assert isinstance(pre["llm_input_messages"][0], SystemMessage)
    assert post == {}
    assert fake_cortadel.count("add_conversation") == 1


async def test_the_hooks_also_work_asynchronously(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [hit("m1", "A fact.")]

    pre = await memory.pre_model_hook.ainvoke(state(HumanMessage("hi", id="h1")), config=THREAD)
    await memory.post_model_hook.ainvoke(
        state(HumanMessage("hi", id="h1"), AIMessage("yo", id="a1")), config=THREAD
    )

    assert isinstance(pre["llm_input_messages"][0], SystemMessage)
    # The async hooks must use the async Cortadel client, never the blocking one.
    assert {c["kind"] for c in fake_cortadel.constructed} == {"async"}
    assert fake_cortadel.count("add_conversation") == 1


async def test_the_async_recall_caches_per_turn_too(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    fake_cortadel.search_hits = [hit("m1", "A fact.")]
    human = HumanMessage("hi", id="h1")
    await memory.arecall_node(state(human), THREAD)
    await memory.arecall_node(state(human, AIMessage("part", id="a1")), THREAD)
    assert fake_cortadel.count("search") == 1


@pytest.mark.parametrize(
    "node", ["recall_node", "arecall_node", "remember_node", "aremember_node"]
)
def test_every_node_spells_its_config_annotation_the_way_langgraph_demands(
    memory: CortadelMemory, node: str
) -> None:
    """LangGraph string-compares this annotation and warns on anything else.

    ``langgraph/_internal/_runnable.py``'s ``KWARGS_CONFIG_KEYS`` accepts exactly
    ``RunnableConfig``/``Optional[RunnableConfig]`` (as objects or as those literal strings). Since
    this package uses ``from __future__ import annotations``, every annotation reaches LangGraph as
    a *string* — so ``RunnableConfig | None`` would warn on every graph build even though it means
    the same thing.
    """
    import inspect

    annotation = inspect.signature(getattr(memory, node)).parameters["config"].annotation
    assert annotation == "Optional[RunnableConfig]"


def test_a_pydantic_style_state_object_is_accepted(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    class State:
        messages = [HumanMessage("attribute access", id="h1")]

    memory.recall_node(State(), THREAD)
    assert fake_cortadel.first("search")[0] == "attribute access"


def test_running_without_a_thread_id_still_works(
    memory: CortadelMemory, fake_cortadel: Backend
) -> None:
    memory.remember_node(state(HumanMessage("hi", id="h1"), AIMessage("yo", id="a1")), None)
    _messages, options = fake_cortadel.first("add_conversation")
    assert options.session_id is None
