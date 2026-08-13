"""Item parsing — the layer that decides what is a message and what is agent plumbing."""

from __future__ import annotations

from cortadel_openai_agents._items import (
    item_role,
    item_text,
    last_user_index,
    last_user_text,
    message_pairs,
)


def test_shorthand_and_expanded_message_shapes_are_both_recognised() -> None:
    assert item_role({"role": "user", "content": "hi"}) == "user"
    assert item_role({"type": "message", "role": "assistant", "content": []}) == "assistant"


def test_non_message_items_have_no_role() -> None:
    assert item_role({"type": "function_call", "call_id": "c", "name": "n", "arguments": "{}"}) is None
    assert item_role({"type": "reasoning", "id": "r", "summary": []}) is None
    assert item_role({"type": "function_call_output", "call_id": "c", "output": "x"}) is None
    assert item_role("not an item") is None


def test_text_is_flattened_across_content_parts() -> None:
    item = {
        "role": "assistant",
        "content": [
            {"type": "output_text", "text": "line one", "annotations": []},
            {"type": "output_text", "text": "line two", "annotations": []},
        ],
    }
    assert item_text(item) == "line one\nline two"


def test_non_text_parts_are_ignored() -> None:
    item = {
        "role": "user",
        "content": [
            {"type": "input_image", "image_url": "http://example.invalid/a.png"},
            {"type": "input_text", "text": "what is this?"},
        ],
    }
    assert item_text(item) == "what is this?"


def test_an_item_with_no_text_yields_an_empty_string() -> None:
    assert item_text({"role": "user", "content": []}) == ""
    assert item_text({"role": "user"}) == ""
    assert item_text({"role": "user", "content": "   "}) == ""


def test_message_pairs_keeps_order_and_drops_everything_unstorable() -> None:
    items = [
        {"role": "system", "content": "instructions"},
        {"role": "user", "content": "question"},
        {"type": "function_call", "call_id": "c", "name": "n", "arguments": "{}"},
        {"role": "assistant", "content": "answer"},
        {"role": "assistant", "content": ""},
    ]
    assert message_pairs(items) == [("user", "question"), ("assistant", "answer")]


def test_last_user_text_and_index_find_the_most_recent_question() -> None:
    items = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "reply"},
        {"role": "user", "content": "second"},
        {"type": "function_call", "call_id": "c", "name": "n", "arguments": "{}"},
    ]
    assert last_user_text(items) == "second"
    assert last_user_index(items) == 2


def test_no_user_message_means_no_query() -> None:
    assert last_user_text([{"role": "assistant", "content": "hello"}]) is None
    assert last_user_index([]) is None


def test_pydantic_style_items_are_accepted() -> None:
    """Sessions normally receive dicts, but a caller may hand us model objects."""

    class Model:
        def model_dump(self) -> dict:
            return {"role": "user", "content": "from a model"}

    assert item_role(Model()) == "user"
    assert item_text(Model()) == "from a model"
