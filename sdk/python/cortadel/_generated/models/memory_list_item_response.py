from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class MemoryListItemResponse(Parsable):
    """
    Memory item in a list/filter/search response.
    """
    # Application identifier (may be null).
    app_id: Optional[str] = None
    # Application name.
    app_name: Optional[str] = None
    # List of category names.
    categories: Optional[list[str]] = None
    # Memory text content.
    content: Optional[str] = None
    # Creation timestamp (Unix seconds).
    created_at: Optional[int] = None
    # Extraction pipeline status (done, pending, failed).
    extraction_status: Optional[str] = None
    # Unique memory identifier.
    id: Optional[str] = None
    # ISO 8601 timestamp at which this memory was invalidated/superseded.
    invalid_at: Optional[str] = None
    # Whether this is the current (non-superseded) version of the memory.
    is_current: Optional[bool] = None
    # True when this is a globally-shared memory owned by another user            (surfaced via global scope). Lets the UI badge it as shared/global.
    is_global: Optional[bool] = None
    # Cognitive type: episodic|semantic|procedural (coalesced to            'semantic' for legacy/untyped rows).
    memory_type: Optional[str] = None
    # Memory state (active, paused, etc.).
    state: Optional[str] = None
    # ISO 8601 timestamp from which this memory version is valid.
    valid_at: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> MemoryListItemResponse:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: MemoryListItemResponse
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return MemoryListItemResponse()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "app_id": lambda n : setattr(self, 'app_id', n.get_str_value()),
            "app_name": lambda n : setattr(self, 'app_name', n.get_str_value()),
            "categories": lambda n : setattr(self, 'categories', n.get_collection_of_primitive_values(str)),
            "content": lambda n : setattr(self, 'content', n.get_str_value()),
            "created_at": lambda n : setattr(self, 'created_at', n.get_int_value()),
            "extraction_status": lambda n : setattr(self, 'extraction_status', n.get_str_value()),
            "id": lambda n : setattr(self, 'id', n.get_str_value()),
            "invalid_at": lambda n : setattr(self, 'invalid_at', n.get_str_value()),
            "is_current": lambda n : setattr(self, 'is_current', n.get_bool_value()),
            "is_global": lambda n : setattr(self, 'is_global', n.get_bool_value()),
            "memory_type": lambda n : setattr(self, 'memory_type', n.get_str_value()),
            "state": lambda n : setattr(self, 'state', n.get_str_value()),
            "valid_at": lambda n : setattr(self, 'valid_at', n.get_str_value()),
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
        writer.write_str_value("app_id", self.app_id)
        writer.write_str_value("app_name", self.app_name)
        writer.write_collection_of_primitive_values("categories", self.categories)
        writer.write_str_value("content", self.content)
        writer.write_int_value("created_at", self.created_at)
        writer.write_str_value("extraction_status", self.extraction_status)
        writer.write_str_value("id", self.id)
        writer.write_str_value("invalid_at", self.invalid_at)
        writer.write_bool_value("is_current", self.is_current)
        writer.write_bool_value("is_global", self.is_global)
        writer.write_str_value("memory_type", self.memory_type)
        writer.write_str_value("state", self.state)
        writer.write_str_value("valid_at", self.valid_at)
    

