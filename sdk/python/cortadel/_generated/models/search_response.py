from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .hybrid_search_result import HybridSearchResult

@dataclass
class SearchResponse(Parsable):
    """
    Search results response.
    """
    # The original search query string.
    query: Optional[str] = None
    # Ranked search result items.
    results: Optional[list[HybridSearchResult]] = None
    # Total number of results returned.
    total: Optional[int] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> SearchResponse:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: SearchResponse
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return SearchResponse()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        from .hybrid_search_result import HybridSearchResult

        from .hybrid_search_result import HybridSearchResult

        fields: dict[str, Callable[[Any], None]] = {
            "query": lambda n : setattr(self, 'query', n.get_str_value()),
            "results": lambda n : setattr(self, 'results', n.get_collection_of_object_values(HybridSearchResult)),
            "total": lambda n : setattr(self, 'total', n.get_int_value()),
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
        writer.write_str_value("query", self.query)
        writer.write_collection_of_object_values("results", self.results)
        writer.write_int_value("total", self.total)
    

