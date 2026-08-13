"""End-to-end: an agent that decides for itself when to use Cortadel memory.

Where `crew_with_cortadel_memory.py` makes memory automatic, this makes it
explicit: the agent gets `search_memory` and `add_memories` as ordinary CrewAI
tools and chooses when to call them. Useful when you want the memory traffic
visible in the agent's reasoning, or when you only want memory on some agents
in a crew.

The two approaches compose — nothing stops you passing `tools=cortadel_tools(...)`
*and* `memory=CortadelMemory(...)`.

Prerequisites
-------------
1. A running Cortadel server (`docker compose up` → http://localhost:3001, or
   the hosted service at https://app.cortadel.ai with an API key).
2. An LLM key for the agent itself, e.g. `export OPENAI_API_KEY=...`.

Usage
-----
    export OPENAI_API_KEY=...
    python agent_with_cortadel_tools.py
"""

from __future__ import annotations

import os

from crewai import Agent, Crew, Task

from cortadel_crewai import cortadel_tools

USER_ID = "e2e-crewai-demo"
BASE_URL = os.environ.get("CORTADEL_BASE_URL", "http://localhost:3001")


def main() -> None:
    # Both tools share one client, so one connection serves the whole agent.
    tools = cortadel_tools(
        base_url=BASE_URL,
        user_id=USER_ID,
        # api_key="...",   # only when the server enforces auth
    )

    support = Agent(
        role="Support Engineer",
        goal="Resolve customer issues without asking them to repeat themselves",
        backstory=(
            "You always search your memory before asking a question, and you "
            "write down anything worth knowing next time."
        ),
        tools=tools,
    )

    remember_task = Task(
        description=(
            "The customer just told us: their account is on the enterprise "
            "plan, they are in the eu-west region, and they only accept "
            "maintenance windows on Sunday mornings. Save what matters."
        ),
        expected_output="Confirmation of what was saved to memory.",
        agent=support,
    )

    recall_task = Task(
        description=(
            "We need to schedule downtime for this customer. Search your "
            "memory and propose a window that will actually work for them."
        ),
        expected_output="A proposed maintenance window justified by what you remembered.",
        agent=support,
    )

    crew = Crew(agents=[support], tasks=[remember_task, recall_task])
    print(crew.kickoff())


if __name__ == "__main__":
    main()
