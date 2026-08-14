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

"""Cortadel memory in a Google ADK agent, end to end.

The point of the script is the *second* session: it uses a brand-new session id,
so ADK's own session history is empty, and anything the agent still knows came
out of Cortadel.

Run it:

    # 1. A Cortadel server. Self-hosted:
    #      docker compose up          -> http://localhost:3001
    #    or hosted at https://app.cortadel.ai (then set CORTADEL_API_KEY).
    export CORTADEL_BASE_URL=http://localhost:3001

    # 2. A model for ADK. Either a Gemini API key...
    export GOOGLE_API_KEY=...
    #    ...or Vertex AI:
    #      export GOOGLE_GENAI_USE_VERTEXAI=TRUE
    #      export GOOGLE_CLOUD_PROJECT=... GOOGLE_CLOUD_LOCATION=...

    uv run python examples/quickstart.py

Nothing here writes to a real person's namespace: the user id is `e2e-*`, this
repo's convention for disposable test data.
"""

from __future__ import annotations

import asyncio

from cortadel_google_adk import CortadelMemoryPlugin
from cortadel_google_adk import CortadelMemoryService
from cortadel_google_adk import cortadel_memory_tools
from google.adk.agents import LlmAgent
from google.adk.apps import App
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import preload_memory
from google.genai import types

APP_NAME = "cortadel-adk-quickstart"
USER_ID = "e2e-adk-quickstart"
MODEL = "gemini-2.0-flash"


def build_runner(memory: CortadelMemoryService) -> Runner:
    agent = LlmAgent(
        name="assistant",
        model=MODEL,
        instruction=(
            "You are a helpful assistant with long-term memory of this user. "
            "Use what you remember. When the user tells you something durable "
            "about themselves or how they work, call add_memories to keep it."
        ),
        tools=[
            # ADK's own automatic-memory tool. It runs before every model call,
            # searches whatever memory service the Runner holds — Cortadel, here
            # — and injects the hits as transient context. No agent code needed.
            preload_memory,
            # Cortadel's model-callable tools. `add_memories` is the one ADK has
            # no built-in for: it lets the agent decide what is worth keeping.
            *cortadel_memory_tools(memory),
        ],
    )

    app = App(
        name=APP_NAME,
        root_agent=agent,
        plugins=[
            # ADK's runner never writes to memory by itself. This persists each
            # finished turn — only that turn's events, selected by invocation id.
            CortadelMemoryPlugin(),
        ],
    )

    return Runner(
        app=app,
        session_service=InMemorySessionService(),
        # One service for the whole tree: tools, preload_memory and the plugin
        # all share its client pool and its dedup ledger.
        memory_service=memory,
    )


async def say(runner: Runner, session_id: str, text: str) -> None:
    """Sends one message and prints the agent's final reply."""
    print(f"\n>>> {text}")
    async for event in runner.run_async(
        user_id=USER_ID,
        session_id=session_id,
        new_message=types.Content(role="user", parts=[types.Part(text=text)]),
    ):
        if event.is_final_response() and event.content and event.content.parts:
            reply = "".join(part.text for part in event.content.parts if part.text)
            if reply:
                print(f"<<< {reply.strip()}")


async def main() -> None:
    # base_url comes from $CORTADEL_BASE_URL (default http://localhost:3001),
    # api_key from $CORTADEL_API_KEY. Nothing is hard-coded.
    memory = CortadelMemoryService()

    # Fail fast with a clear message instead of silently degrading: the default
    # raise_on_error=False would otherwise make an unreachable server look like
    # an agent that simply forgot everything.
    health = await (await memory.client_for(APP_NAME, USER_ID)).health()
    print(f"Cortadel: {health.status}")

    runner = build_runner(memory)
    try:
        # --- Session one: tell the agent something worth keeping. ------------
        first = await runner.session_service.create_session(
            app_name=APP_NAME, user_id=USER_ID
        )
        print(f"\n=== session {first.id} ===")
        await say(runner, first.id, "I deploy to Cloud Run and I prefer Terraform over the console.")
        await say(runner, first.id, "Also, keep code reviews short — bullet points only.")

        # Extraction runs off the request path on the server, so give the write
        # pipeline a moment before reading it back.
        await asyncio.sleep(5)

        # --- Session two: a fresh session, so ADK's history is empty. --------
        second = await runner.session_service.create_session(
            app_name=APP_NAME, user_id=USER_ID
        )
        print(f"\n=== session {second.id} (new session, empty history) ===")
        await say(runner, second.id, "How should I ship my next service, and how do you want reviews?")

        # --- The same memory, read directly. ---------------------------------
        found = await memory.search_memory(
            app_name=APP_NAME, user_id=USER_ID, query="deployment and review preferences"
        )
        print(f"\n--- {len(found.memories)} memories in Cortadel ---")
        for entry in found.memories:
            text = "".join(part.text for part in entry.content.parts if part.text)
            score = (entry.custom_metadata or {}).get("rrf_score")
            print(f"  [{score}] {text}")
    finally:
        await runner.close()
        await memory.aclose()


if __name__ == "__main__":
    asyncio.run(main())
