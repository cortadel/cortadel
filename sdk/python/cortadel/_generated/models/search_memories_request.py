from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class SearchMemoriesRequest(Parsable):
    """
    Hybrid search request.
    """
    # Application name for access logging.
    app_name: Optional[str] = None
    # When true, expands query with LLM-generated synonyms before text search.
    expand_query: Optional[bool] = None
    # When true, include faded/stale memories that are normally hidden from searchresults (bypasses the opt-in hard-fade filter). Default false. Has no effectunless the server has fading enabled.
    include_faded: Optional[bool] = None
    # When true, also vector-searches session summaries and expands top matchesto their member memories. Useful when memories are fine-grained (per-turn,per-dialog) and the right episode is buried in many candidates.
    include_session_arm: Optional[bool] = None
    # Optional filter restricting results to a cognitive type            (episodic|semantic|procedural). Invalid/blank values are ignored (no filter).
    memory_type: Optional[str] = None
    # Search mode: hybrid, text, or vector.
    mode: Optional[str] = None
    # Natural language search query.
    query: Optional[str] = None
    # Rerank strategy: "cross_encoder" for LLM-based reranking, or null/empty to skip.
    rerank: Optional[str] = None
    # Optional session ID to restrict results to a specific session.
    session_id: Optional[str] = None
    # Optional ceiling on the estimated token size of the returned results. 0(default) means unbounded, though the server may still apply its ownconfigured default budget in that case. A positive value trims the rankedresult list to fit within N estimated tokens (lowest-ranked results droppedfirst; order is never changed), costed against whichever field the response'sdetail tier returns.
    token_budget: Optional[int] = None
    # Maximum number of results (1-50).
    top_k: Optional[int] = None
    # User identifier.
    user_id: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> SearchMemoriesRequest:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: SearchMemoriesRequest
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return SearchMemoriesRequest()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "app_name": lambda n : setattr(self, 'app_name', n.get_str_value()),
            "expand_query": lambda n : setattr(self, 'expand_query', n.get_bool_value()),
            "include_faded": lambda n : setattr(self, 'include_faded', n.get_bool_value()),
            "include_session_arm": lambda n : setattr(self, 'include_session_arm', n.get_bool_value()),
            "memory_type": lambda n : setattr(self, 'memory_type', n.get_str_value()),
            "mode": lambda n : setattr(self, 'mode', n.get_str_value()),
            "query": lambda n : setattr(self, 'query', n.get_str_value()),
            "rerank": lambda n : setattr(self, 'rerank', n.get_str_value()),
            "session_id": lambda n : setattr(self, 'session_id', n.get_str_value()),
            "token_budget": lambda n : setattr(self, 'token_budget', n.get_int_value()),
            "top_k": lambda n : setattr(self, 'top_k', n.get_int_value()),
            "user_id": lambda n : setattr(self, 'user_id', n.get_str_value()),
        }
        return fields
    
    def serialize(self,writer: SerializationWriter) -> None:
        """
        Serializes information the current object
        param writer: Serialization writer to use to serialize this model
        Returns: None
        """
        if writer is None:
            raise TypeError("writer cannot be null.")
        writer.write_str_value("app_name", self.app_name)
        writer.write_bool_value("expand_query", self.expand_query)
        writer.write_bool_value("include_faded", self.include_faded)
        writer.write_bool_value("include_session_arm", self.include_session_arm)
        writer.write_str_value("memory_type", self.memory_type)
        writer.write_str_value("mode", self.mode)
        writer.write_str_value("query", self.query)
        writer.write_str_value("rerank", self.rerank)
        writer.write_str_value("session_id", self.session_id)
        writer.write_int_value("token_budget", self.token_budget)
        writer.write_int_value("top_k", self.top_k)
        writer.write_str_value("user_id", self.user_id)
    

