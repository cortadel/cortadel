"""Namespace templating and user-id resolution.

LangGraph addresses long-term memory by *namespace* — a tuple of strings such as
``("memories", "alice")`` (see ``langgraph/store/base/__init__.py``, ``BaseStore.put``). Cortadel
addresses it by *user id*, fixed at client construction: "All calls are scoped to the userId given
at construction." Those two models meet here.

Two small utilities:

* :func:`resolve_namespace` expands ``{placeholder}`` labels from a ``RunnableConfig``'s
  ``configurable`` dict, so a single tool or node can serve every user — the same convention
  ``langmem.utils.NamespaceTemplate`` uses.
* :func:`namespace_user_id` builds the ``namespace -> user_id`` callable that
  :class:`~cortadel_langgraph.store.CortadelStore` uses to decide *which* Cortadel client a given
  namespace belongs to.
"""
from __future__ import annotations

import re
from typing import Any, Callable, Mapping, Optional, Sequence, Union

from langgraph.config import get_config

__all__ = [
    "DEFAULT_NAMESPACE",
    "NamespaceLike",
    "UserIdResolver",
    "as_namespace",
    "namespace_user_id",
    "resolve_namespace",
]

DEFAULT_NAMESPACE = ("memories", "{user_id}")
"""The namespace this package defaults to.

Mirrors the shape LangGraph's own long-term-memory docs and ``langmem`` use, and pairs with
``namespace_user_id(-1)`` so the trailing label *is* the Cortadel user id.
"""

NamespaceLike = Union[str, Sequence[str]]
"""A namespace, or a template for one. A bare ``str`` is treated as a one-label namespace."""

UserIdResolver = Union[str, Callable[[tuple[str, ...]], str]]
"""Either a fixed Cortadel user id, or a callable mapping a namespace to one."""

# Only a *whole* label may be a placeholder (``"{user_id}"``, never ``"user-{id}"``). Same
# restriction langmem imposes in ``NamespaceTemplate._get_key``; keeping it means a namespace label
# can never be half-literal, which would make the reverse mapping (namespace -> user id) ambiguous.
_PLACEHOLDER = re.compile(r"^\{(\w+)\}$")


def as_namespace(value: NamespaceLike) -> tuple[str, ...]:
    """Normalise a namespace-ish value to a tuple of labels."""
    if isinstance(value, str):
        return (value,)
    return tuple(str(label) for label in value)


def resolve_namespace(
    template: NamespaceLike,
    config: Optional[Mapping[str, Any]] = None,
) -> tuple[str, ...]:
    """Expand ``{placeholder}`` labels in ``template`` from a ``RunnableConfig``.

    Args:
        template: A namespace whose labels may be placeholders, e.g. ``("memories", "{user_id}")``.
        config: The runnable config to read ``configurable`` from. When ``None``, the ambient
            config is pulled via ``langgraph.config.get_config()`` — which only works inside a
            running graph node, tool, or task.

    Returns:
        The namespace with every placeholder substituted.

    Raises:
        ValueError: If a placeholder has no value, or if the ambient config is unavailable.
    """
    labels = as_namespace(template)
    placeholders = [
        (index, match.group(1))
        for index, label in enumerate(labels)
        if (match := _PLACEHOLDER.match(label))
    ]
    if not placeholders:
        return labels

    if config is None:
        try:
            config = get_config()
        except RuntimeError as exc:  # raised verbatim by langgraph.config.get_config
            wanted = ", ".join(name for _, name in placeholders)
            raise ValueError(
                f"Namespace {labels} needs {{{wanted}}} from the runnable config, but no config "
                "was passed and none is available. Either invoke this inside a LangGraph node "
                'with config={"configurable": {...}}, or pass a fully-resolved namespace.'
            ) from exc

    configurable = config.get("configurable") or {} if config else {}
    resolved = list(labels)
    missing: list[str] = []
    for index, name in placeholders:
        value = configurable.get(name)
        if value is None or value == "":
            missing.append(name)
        else:
            resolved[index] = str(value)
    if missing:
        raise ValueError(
            f"Namespace {labels} could not be resolved: "
            f"missing {', '.join(repr(name) for name in missing)} in config['configurable']. "
            f"Invoke with config={{'configurable': {{{missing[0]!r}: '...'}}}}."
        )
    return tuple(resolved)


def namespace_user_id(index: int = -1) -> Callable[[tuple[str, ...]], str]:
    """Build a ``namespace -> user_id`` resolver that reads one label of the namespace.

    ``namespace_user_id(-1)`` pairs with :data:`DEFAULT_NAMESPACE`: given ``("memories", "alice")``
    it yields ``"alice"``, so one :class:`~cortadel_langgraph.store.CortadelStore` can serve every
    user of a multi-tenant graph while still honouring Cortadel's one-client-per-user rule.

    Args:
        index: Position of the label holding the user id. Negative indices count from the end.
    """

    def _resolve(namespace: tuple[str, ...]) -> str:
        try:
            label = namespace[index]
        except IndexError as exc:
            raise ValueError(
                f"Namespace {namespace} has no label at index {index}, so no Cortadel user id "
                "could be derived from it."
            ) from exc
        if not label:
            raise ValueError(
                f"Namespace {namespace} has an empty label at index {index}; a Cortadel user id "
                "cannot be blank."
            )
        return label

    _resolve.__name__ = f"namespace_user_id({index})"
    return _resolve
