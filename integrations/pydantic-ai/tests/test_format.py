"""Translation between pydantic-ai messages and Cortadel DTOs."""

from __future__ import annotations

from cortadel import SearchHit
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from conftest import any_ctx
from cortadel_pydantic_ai._format import (
    chat_messages_from,
    content_text,
    format_memories,
    query_from_context,
)


class TestContentText:
    def test_plain_string_is_stripped(self) -> None:
        assert content_text("  hello  ") == "hello"

    def test_none_is_empty(self) -> None:
        assert content_text(None) == ""

    def test_sequence_keeps_only_text_parts(self) -> None:
        # Multimodal prompts mix text with binary content; only the text is a storable fact.
        class NotText:
            pass

        assert content_text(["first", NotText(), "  second  ", ""]) == "first\nsecond"


class TestFormatMemories:
    def test_renders_a_bulleted_block_under_the_header(self) -> None:
        block = format_memories(
            [SearchHit(id="1", content="Likes dark mode."), SearchHit(id="2", content="Ships Fridays.")],
            "HEADER",
        )
        assert block == "HEADER\n\n- Likes dark mode.\n- Ships Fridays."

    def test_no_hits_returns_none_so_pydantic_ai_drops_the_instruction(self) -> None:
        assert format_memories([]) is None

    def test_blank_hits_return_none_rather_than_an_empty_section(self) -> None:
        assert format_memories([SearchHit(id="1", content="   ")]) is None

    def test_duplicate_content_is_collapsed(self) -> None:
        block = format_memories(
            [SearchHit(id="1", content="Same."), SearchHit(id="2", content="Same.")],
            "H",
        )
        assert block == "H\n\n- Same."


class TestChatMessagesFrom:
    def test_keeps_user_prompts_and_assistant_text(self) -> None:
        messages = [
            ModelRequest(parts=[UserPromptPart(content="I prefer metric units.")]),
            ModelResponse(parts=[TextPart(content="Noted.")]),
        ]
        assert [(m.role, m.content) for m in chat_messages_from(messages)] == [
            ("user", "I prefer metric units."),
            ("assistant", "Noted."),
        ]

    def test_drops_system_prompts_tool_calls_and_thinking(self) -> None:
        # Agent configuration and tool mechanics are not facts about the user.
        messages = [
            ModelRequest(
                parts=[
                    SystemPromptPart(content="You are helpful."),
                    UserPromptPart(content="Book it."),
                ]
            ),
            ModelResponse(
                parts=[
                    ThinkingPart(content="hmm"),
                    ToolCallPart(tool_name="book", args={"x": 1}, tool_call_id="c1"),
                ]
            ),
            ModelRequest(parts=[ToolReturnPart(tool_name="book", content="ok", tool_call_id="c1")]),
            ModelResponse(parts=[TextPart(content="Booked.")]),
        ]
        assert [(m.role, m.content) for m in chat_messages_from(messages)] == [
            ("user", "Book it."),
            ("assistant", "Booked."),
        ]

    def test_multiple_text_parts_join_into_one_assistant_message(self) -> None:
        messages = [ModelResponse(parts=[TextPart(content="A"), TextPart(content="B")])]
        assert [(m.role, m.content) for m in chat_messages_from(messages)] == [("assistant", "A\n\nB")]

    def test_empty_text_is_skipped(self) -> None:
        messages = [
            ModelRequest(parts=[UserPromptPart(content="   ")]),
            ModelResponse(parts=[TextPart(content="")]),
        ]
        assert chat_messages_from(messages) == []


class TestQueryFromContext:
    def test_prefers_the_run_prompt(self) -> None:
        ctx = any_ctx(prompt="what do you know about me?")
        assert query_from_context(ctx) == "what do you know about me?"

    def test_falls_back_to_the_last_user_message_in_history(self) -> None:
        ctx = any_ctx(
            prompt=None,
            messages=[
                ModelRequest(parts=[UserPromptPart(content="first")]),
                ModelResponse(parts=[TextPart(content="reply")]),
                ModelRequest(parts=[UserPromptPart(content="most recent")]),
            ],
        )
        assert query_from_context(ctx) == "most recent"

    def test_returns_empty_when_there_is_nothing_to_search_on(self) -> None:
        assert query_from_context(any_ctx()) == ""
