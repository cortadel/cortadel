"""CortadelStore on its own — no LLM, no API keys, just a Cortadel server.

The fastest way to see what the integration actually does. `CortadelStore` is a real LangGraph
`BaseStore`, so everything here is plain LangGraph store API; the only Cortadel-specific line is
the constructor.

Run it:

    docker compose up                      # from the cortadel repo root -> http://localhost:3001
    uv run --with cortadel-langgraph python examples/01_store_quickstart.py

Against the hosted service instead:

    CORTADEL_URL=https://app.cortadel.ai CORTADEL_API_KEY=... python examples/01_store_quickstart.py
"""
from __future__ import annotations

import os

from cortadel_langgraph import CortadelStore, namespace_user_id

BASE_URL = os.environ.get("CORTADEL_URL", "http://localhost:3001")
API_KEY = os.environ.get("CORTADEL_API_KEY")  # self-hosted Cortadel defaults to auth disabled

# `namespace_user_id(-1)` reads the Cortadel user id off the last namespace label, so the
# LangGraph-idiomatic ("memories", "<user>") layout maps straight onto Cortadel's per-user
# namespacing. Pass a plain string instead if your process only ever serves one user.
#
# The store fails open: if Cortadel is unreachable every call below degrades to an empty result
# and logs a warning. Pass `on_error=lambda exc: ...` to route those into your own telemetry, or
# `raise_on_error=True` to make them fatal.
store = CortadelStore(BASE_URL, namespace_user_id(-1), api_key=API_KEY)

# Test data always uses the e2e-* prefix — this writes to a real server.
NAMESPACE = ("memories", "e2e-langgraph-quickstart")


def main() -> None:
    health = store.health(NAMESPACE)
    if health is None:
        raise SystemExit(f"No Cortadel server at {BASE_URL}. Start one with `docker compose up`.")
    print(f"Server status: {health.status}")

    # 1. Write. The value is a dict, as BaseStore requires; the "content" key is what Cortadel
    #    stores as the memory text (see `text_keys`). Anything else rides along as metadata.
    print("\nStoring memories...")
    store.put(NAMESPACE, "pref-1", {"content": "Prefers dark mode in every editor.", "topic": "ui"})
    store.put(NAMESPACE, "pref-2", {"content": "Ships releases on Fridays, never on Mondays."})
    store.put(NAMESPACE, "pref-3", {"content": "Is allergic to shellfish."})

    # 2. Search. With a query this is Cortadel's hybrid BM25 + vector search — so it finds the
    #    release-cadence memory even though the query shares no words with it. (`limit=` here is
    #    BaseStore's own keyword; the package's own option is spelled `top_k`.)
    print("\nSearching for 'when do they deploy?'")
    for item in store.search(NAMESPACE, query="when do they deploy?", limit=3):
        print(f"  {item.value['content']!r}  score={item.score}  key={item.key}")

    # 3. Get. Note the key: `put` used "pref-1", but Cortadel minted its own id. The store bridges
    #    the two for this process, and `value["id"]` is always the real Cortadel id — the durable
    #    one to hold on to.
    found = store.get(NAMESPACE, "pref-1")
    if found is not None:
        print(f"\nget('pref-1') -> {found.value['content']!r} (cortadel id {found.value['id']})")

    # 4. List everything (a query-less search is a plain listing, newest-first from the server).
    print("\nEverything stored for this user:")
    for item in store.search(NAMESPACE, limit=10):
        print(f"  {item.value['content']!r}")

    # 5. Clean up. Deleting by the Cortadel id always works; deleting by the caller's key works
    #    too, for as long as this process is alive.
    print("\nCleaning up...")
    for item in store.search(NAMESPACE, limit=50):
        store.delete(NAMESPACE, item.key)
    print("Done.")


if __name__ == "__main__":
    try:
        main()
    finally:
        # Each distinct user id gets its own client (and its own background thread) — close them.
        store.close()
