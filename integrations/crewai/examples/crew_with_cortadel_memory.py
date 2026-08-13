"""End-to-end: a CrewAI crew whose long-term memory lives in Cortadel.

Run it twice. The first run has nothing to remember; the second answers from
what the first one learned, because the memories outlived the process.

Prerequisites
-------------
1. A running Cortadel server. Self-host it with `docker compose up` from the
   Cortadel repo (serves http://localhost:3001), or point at the hosted
   service, https://app.cortadel.ai, with an API key.
2. An LLM key for CrewAI's own agents, e.g. `export OPENAI_API_KEY=...`.
   (Cortadel does its own embedding and extraction server-side; this key is
   only for the agents themselves.)

Usage
-----
    export OPENAI_API_KEY=...
    export CORTADEL_BASE_URL=http://localhost:3001     # optional, this is the default
    python crew_with_cortadel_memory.py
"""

from __future__ import annotations

import logging
import os

from crewai import Agent, Crew, Task

from cortadel_crewai import CortadelConversationListener, CortadelMemory

# Every Cortadel client is bound to ONE user id at construction — there is no
# per-call user parameter. Build one CortadelMemory per user you serve.
USER_ID = "e2e-crewai-demo"
BASE_URL = os.environ.get("CORTADEL_BASE_URL", "http://localhost:3001")


def report_memory_failure(exc: BaseException) -> None:
    """Observe Cortadel failures without letting them stop the crew.

    `raise_on_error` defaults to False, so an unreachable server degrades the
    agent to "no memories" rather than crashing it. `on_error` is how you still
    find out — point it at Sentry, a metric, or your own logger. Setting it
    replaces the package's default warning log.
    """
    logging.getLogger("my-app").error("Cortadel is degraded: %s", exc)


def build_crew() -> tuple[Crew, CortadelMemory]:
    memory = CortadelMemory(
        base_url=BASE_URL,
        user_id=USER_ID,
        # api_key="...",            # only needed when the server enforces auth
        rerank="cross_encoder",     # let Cortadel rerank with its cross-encoder
        dedupe_window=50,           # don't re-inject facts recalled a moment ago
        on_error=report_memory_failure,
    )

    engineer = Agent(
        role="Platform Engineer",
        goal="Answer infrastructure questions using what the team already decided",
        backstory=(
            "You have a long memory for architecture decisions and you never "
            "make the team relitigate a settled question."
        ),
        # Agent-level memory is a convenience for a plain kickoff(). It does NOT
        # survive Crew.copy() — BaseAgent.copy() re-validates the agent through
        # a model_dump() and CrewAI's discriminated union turns this back into a
        # plain crewai.Memory. kickoff_for_each(), train() and test() all copy,
        # so with those, rely on the Crew(memory=...) below instead.
        memory=memory,
    )

    task = Task(
        description=(
            "We are deploying the new billing service. Which cluster should it "
            "go to, and what did we decide about its database? If you do not "
            "know yet, say so plainly."
        ),
        expected_output="A short recommendation, citing the earlier decision if one exists.",
        agent=engineer,
    )

    # Crew-level memory is the one that always survives — Crew.copy() reattaches
    # the live instance, so kickoff_for_each()/train()/test() keep Cortadel.
    crew = Crew(agents=[engineer], tasks=[task], memory=memory)
    return crew, memory


def main() -> None:
    crew, memory = build_crew()

    # Optional third layer: persist every completed task through Cortadel's
    # extraction pipeline (add_conversation), so durable facts are distilled
    # out of the run without the agent having to call a tool.
    # Hold the reference — a garbage-collected listener stops working.
    listener = CortadelConversationListener(
        base_url=BASE_URL,
        user_id=USER_ID,
        session_id="billing-service-rollout",
        project="platform",
    )
    assert listener is not None

    # Seed a decision on the first run so the second run has something to find.
    memory.remember(
        "The billing service deploys to the eu-west staging cluster, "
        "backed by the shared Postgres instance rather than its own database."
    )

    print(crew.kickoff())

    # Show what Cortadel actually holds for this user.
    print("\n--- stored memories ---")
    for record in memory.list_records(limit=10):
        print(f"  [{record.id}] {record.content}")

    memory.close()


if __name__ == "__main__":
    main()
