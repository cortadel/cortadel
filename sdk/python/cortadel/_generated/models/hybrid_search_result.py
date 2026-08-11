from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .hybrid_search_result_attributes import HybridSearchResult_attributes

@dataclass
class HybridSearchResult(Parsable):
    # The app_name property
    app_name: Optional[str] = None
    # The attributes property
    attributes: Optional[HybridSearchResult_attributes] = None
    # The categories property
    categories: Optional[list[str]] = None
    # The content property
    content: Optional[str] = None
    # The created_at property
    created_at: Optional[str] = None
    # The gist property
    gist: Optional[str] = None
    # The global property
    global_: Optional[bool] = None
    # The id property
    id: Optional[str] = None
    # The member_ids property
    member_ids: Optional[list[str]] = None
    # The memory_type property
    memory_type: Optional[str] = None
    # The project_id property
    project_id: Optional[str] = None
    # The rrf_score property
    rrf_score: Optional[float] = None
    # The similar_ids property
    similar_ids: Optional[list[str]] = None
    # The source property
    source: Optional[str] = None
    # The tags property
    tags: Optional[list[str]] = None
    # The text_rank property
    text_rank: Optional[int] = None
    # The vector_rank property
    vector_rank: Optional[int] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> HybridSearchResult:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: HybridSearchResult
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return HybridSearchResult()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        from .hybrid_search_result_attributes import HybridSearchResult_attributes

        from .hybrid_search_result_attributes import HybridSearchResult_attributes

        fields: dict[str, Callable[[Any], None]] = {
            "app_name": lambda n : setattr(self, 'app_name', n.get_str_value()),
            "attributes": lambda n : setattr(self, 'attributes', n.get_object_value(HybridSearchResult_attributes)),
            "categories": lambda n : setattr(self, 'categories', n.get_collection_of_primitive_values(str)),
            "content": lambda n : setattr(self, 'content', n.get_str_value()),
            "created_at": lambda n : setattr(self, 'created_at', n.get_str_value()),
            "gist": lambda n : setattr(self, 'gist', n.get_str_value()),
            "global": lambda n : setattr(self, 'global_', n.get_bool_value()),
            "id": lambda n : setattr(self, 'id', n.get_str_value()),
            "member_ids": lambda n : setattr(self, 'member_ids', n.get_collection_of_primitive_values(str)),
            "memory_type": lambda n : setattr(self, 'memory_type', n.get_str_value()),
            "project_id": lambda n : setattr(self, 'project_id', n.get_str_value()),
            "rrf_score": lambda n : setattr(self, 'rrf_score', n.get_float_value()),
            "similar_ids": lambda n : setattr(self, 'similar_ids', n.get_collection_of_primitive_values(str)),
            "source": lambda n : setattr(self, 'source', n.get_str_value()),
            "tags": lambda n : setattr(self, 'tags', n.get_collection_of_primitive_values(str)),
            "text_rank": lambda n : setattr(self, 'text_rank', n.get_int_value()),
            "vector_rank": lambda n : setattr(self, 'vector_rank', n.get_int_value()),
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
        writer.write_object_value("attributes", self.attributes)
        writer.write_collection_of_primitive_values("categories", self.categories)
        writer.write_str_value("content", self.content)
        writer.write_str_value("created_at", self.created_at)
        writer.write_str_value("gist", self.gist)
        writer.write_bool_value("global", self.global_)
        writer.write_str_value("id", self.id)
        writer.write_collection_of_primitive_values("member_ids", self.member_ids)
        writer.write_str_value("memory_type", self.memory_type)
        writer.write_str_value("project_id", self.project_id)
        writer.write_float_value("rrf_score", self.rrf_score)
        writer.write_collection_of_primitive_values("similar_ids", self.similar_ids)
        writer.write_str_value("source", self.source)
        writer.write_collection_of_primitive_values("tags", self.tags)
        writer.write_int_value("text_rank", self.text_rank)
        writer.write_int_value("vector_rank", self.vector_rank)
    

