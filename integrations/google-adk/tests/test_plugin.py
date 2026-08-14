# Copyright 2026 Cortadel
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import annotations

import inspect
from typing import Optional

from conftest import FakeClientFactory
from conftest import make_event
from conftest import make_hit
from conftest import make_session
from cortadel_google_adk import CortadelMemoryOptions
from cortadel_google_adk import CortadelMemoryPlugin
from cortadel_google_adk import CortadelMemoryService
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import InvocationContext
from google.adk.memory import InMemoryMemoryService
from google.adk.models.llm_request import LlmRequest
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.sessions import InMemorySessionService
from google.adk.sessions.session import Session
from google.genai import types
import pytest


def build(factory: FakeClientFactory, **kwargs) -> CortadelMemoryService:
    return CortadelMemoryService(
        "http://localhost:3001",
        options=CortadelMemoryOptions(client_factory=factory),
        **kwargs,
    )


def invocation(
    session: Session,
    *,
    invocation_id: str = "inv-1",
    memory_service: object = None,
    user_text: Optional[str] = None,
) -> InvocationContext:
    return InvocationContext(
        session_service=InMemorySessionService(),
        session=session,
        invocation_id=invocation_id,
        memory_service=memory_service,
        user_content=(
            types.Content(role="user", parts=[types.Part(text=user_text)])
            if user_text is not None
            else None
        ),
    )


# ---------------------------------------------------------------------------
# Interface conformance
# ---------------------------------------------------------------------------


def test_is_a_base_plugin() -> None:
    assert issubclass(CortadelMemoryPlugin, BasePlugin)
    assert CortadelMemoryPlugin().name == "cortadel_memory"


@pytest.mark.parametrize(
    "method", ["after_run_callback", "before_model_callback", "close"]
)
def test_callback_signatures_match_base_plugin(method: str) -> None:
    ours = inspect.signature(getattr(CortadelMemoryPlugin, method))
    theirs = inspect.signature(getattr(BasePlugin, method))
    assert list(ours.parameters) == list(theirs.parameters), f"{method} drifted"


# ---------------------------------------------------------------------------
# Persist
# ---------------------------------------------------------------------------


async def test_after_run_persists_only_this_invocation(factory: FakeClientFactory) -> None:
    session = make_session(
        make_event(author="user", text="turn one", event_id="e1", invocation_id="inv-0"),
        make_event(author="agent", text="reply one", event_id="e2", invocation_id="inv-0"),
        make_event(author="user", text="turn two", event_id="e3", invocation_id="inv-1"),
        make_event(author="agent", text="reply two", event_id="e4", invocation_id="inv-1"),
    )
    service = build(factory)
    plugin = CortadelMemoryPlugin(service)

    await plugin.after_run_callback(invocation_context=invocation(session))

    (call,) = factory.only().calls_to("add_conversation")
    assert [m.content for m in call.args[0]] == ["turn two", "reply two"]
    assert call.options.session_id == "sess-1"


async def test_after_run_is_a_noop_without_matching_events(
    factory: FakeClientFactory,
) -> None:
    session = make_session(
        make_event(author="user", text="old", event_id="e1", invocation_id="inv-0")
    )
    plugin = CortadelMemoryPlugin(build(factory))

    await plugin.after_run_callback(invocation_context=invocation(session))

    assert factory.clients == {}


async def test_after_run_borrows_the_runner_memory_service(
    factory: FakeClientFactory,
) -> None:
    """With no explicit service, the plugin uses the Runner's — if it is ours."""
    session = make_session(make_event(author="user", text="hello", event_id="e1"))
    service = build(factory)
    plugin = CortadelMemoryPlugin()

    await plugin.after_run_callback(
        invocation_context=invocation(session, memory_service=service)
    )

    assert len(factory.only().calls_to("add_conversation")) == 1


async def test_after_run_does_nothing_for_a_foreign_memory_service(
    factory: FakeClientFactory,
) -> None:
    session = make_session(make_event(author="user", text="hello", event_id="e1"))
    plugin = CortadelMemoryPlugin()

    await plugin.after_run_callback(
        invocation_context=invocation(session, memory_service=InMemoryMemoryService())
    )

    assert factory.clients == {}


async def test_persist_can_be_disabled(factory: FakeClientFactory) -> None:
    session = make_session(make_event(author="user", text="hello", event_id="e1"))
    plugin = CortadelMemoryPlugin(build(factory), persist=False)

    await plugin.after_run_callback(invocation_context=invocation(session))

    assert factory.clients == {}


async def test_persist_never_raises_into_the_run(factory: FakeClientFactory) -> None:
    """Even a ``raise_on_error=True`` service must not break a finished run."""
    session = make_session(make_event(author="user", text="hello", event_id="e1"))
    service = build(factory, raise_on_error=True)
    await service.client_for(session.app_name, session.user_id)
    factory.only().raises = RuntimeError("server on fire")
    plugin = CortadelMemoryPlugin(service)

    await plugin.after_run_callback(invocation_context=invocation(session))


async def test_plugin_and_manual_ingest_do_not_double_write(
    factory: FakeClientFactory,
) -> None:
    session = make_session(make_event(author="user", text="hello", event_id="e1"))
    service = build(factory)
    plugin = CortadelMemoryPlugin(service)

    await plugin.after_run_callback(invocation_context=invocation(session))
    # A user who also calls ctx.add_session_to_memory() by hand.
    await service.add_session_to_memory(session)

    assert len(factory.only().calls_to("add_conversation")) == 1


# ---------------------------------------------------------------------------
# Inject
# ---------------------------------------------------------------------------


async def test_inject_is_off_by_default(factory: FakeClientFactory) -> None:
    factory.hits = [make_hit(content="The user prefers Terraform.")]
    request = LlmRequest()
    plugin = CortadelMemoryPlugin(build(factory))

    result = await plugin.before_model_callback(
        callback_context=CallbackContext(invocation(make_session(), user_text="how do I ship?")),
        llm_request=request,
    )

    assert result is None
    assert not request.config.system_instruction
    assert factory.clients == {}


async def test_inject_appends_memories_to_the_system_instruction(
    factory: FakeClientFactory,
) -> None:
    factory.hits = [
        make_hit(memory_id="m1", content="The user prefers Terraform."),
        make_hit(memory_id="m2", content="The user deploys to Cloud Run."),
    ]
    request = LlmRequest()
    plugin = CortadelMemoryPlugin(build(factory), inject=True)

    result = await plugin.before_model_callback(
        callback_context=CallbackContext(invocation(make_session(), user_text="how do I ship?")),
        llm_request=request,
    )

    assert result is None, "injection must never short-circuit the model call"
    instruction = str(request.config.system_instruction)
    assert "- The user prefers Terraform." in instruction
    assert "- The user deploys to Cloud Run." in instruction
    assert "<CORTADEL_MEMORY>" in instruction
    # The user's message is what we searched for.
    (call,) = factory.only().calls_to("search")
    assert call.args == ("how do I ship?",)


async def test_inject_skips_when_there_is_nothing_to_inject(
    factory: FakeClientFactory,
) -> None:
    request = LlmRequest()
    plugin = CortadelMemoryPlugin(build(factory), inject=True)

    await plugin.before_model_callback(
        callback_context=CallbackContext(invocation(make_session(), user_text="hello")),
        llm_request=request,
    )

    assert not request.config.system_instruction


async def test_inject_skips_when_there_is_no_user_text(factory: FakeClientFactory) -> None:
    factory.hits = [make_hit()]
    request = LlmRequest()
    plugin = CortadelMemoryPlugin(build(factory), inject=True)

    await plugin.before_model_callback(
        callback_context=CallbackContext(invocation(make_session())),
        llm_request=request,
    )

    assert not request.config.system_instruction
    assert factory.clients == {}


async def test_inject_survives_a_dead_backend(factory: FakeClientFactory) -> None:
    service = build(factory, raise_on_error=True)
    session = make_session()
    await service.client_for(session.app_name, session.user_id)
    factory.only().raises = RuntimeError("server on fire")
    request = LlmRequest()
    plugin = CortadelMemoryPlugin(service, inject=True)

    result = await plugin.before_model_callback(
        callback_context=CallbackContext(invocation(session, user_text="hi")),
        llm_request=request,
    )

    assert result is None
    assert not request.config.system_instruction


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


async def test_close_closes_a_plugin_owned_service(factory: FakeClientFactory) -> None:
    service = build(factory)
    await service.client_for("app", "e2e-user")
    plugin = CortadelMemoryPlugin(service)

    await plugin.close()

    assert factory.only().closed is True


async def test_close_leaves_a_borrowed_service_alone(factory: FakeClientFactory) -> None:
    session = make_session(make_event(author="user", text="hello", event_id="e1"))
    service = build(factory)
    plugin = CortadelMemoryPlugin()
    await plugin.after_run_callback(
        invocation_context=invocation(session, memory_service=service)
    )

    await plugin.close()

    # The Runner owns that service; closing it here would break the next run.
    assert factory.only().closed is False
