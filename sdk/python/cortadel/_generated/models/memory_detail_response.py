from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class MemoryDetailResponse(Parsable):
    """
    Single memory detail response (from GET /memories/:id).
    """
    # Application identifier (may be null).
    app_id: Optional[str] = None
    # Application name.
    app_name: Optional[str] = None
    # List of category names.
    categories: Optional[list[str]] = None
    # Creation timestamp (Unix seconds).
    created_at: Optional[int] = None
    # Unique memory identifier.
    id: Optional[str] = None
    # ISO 8601 timestamp at which this memory was invalidated/superseded.
    invalid_at: Optional[str] = None
    # Whether this is the current (non-superseded) version of the memory.
    is_current: Optional[bool] = None
    # True when this is a globally-shared memory owned by another user            (surfaced via global scope). Lets the UI badge it as shared/global.
    is_global: Optional[bool] = None
    # Memory state (active, paused, etc.).
    state: Optional[str] = None
    # Identifier of the newer memory that superseded this one.
    superseded_by: Optional[str] = None
    # Memory text content.
    text: Optional[str] = None
    # ISO 8601 timestamp from which this memory version is valid.
    valid_at: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> MemoryDetailResponse:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: MemoryDetailResponse
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return MemoryDetailResponse()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "app_id": lambda n : setattr(self, 'app_id', n.get_str_value()),
            "app_name": lambda n : setattr(self, 'app_name', n.get_str_value()),
            "categories": lambda n : setattr(self, 'categories', n.get_collection_of_primitive_values(str)),
            "created_at": lambda n : setattr(self, 'created_at', n.get_int_value()),
            "id": lambda n : setattr(self, 'id', n.get_str_value()),
            "invalid_at": lambda n : setattr(self, 'invalid_at', n.get_str_value()),
            "is_current": lambda n : setattr(self, 'is_current', n.get_bool_value()),
            "is_global": lambda n : setattr(self, 'is_global', n.get_bool_value()),
            "state": lambda n : setattr(self, 'state', n.get_str_value()),
            "superseded_by": lambda n : setattr(self, 'superseded_by', n.get_str_value()),
            "text": lambda n : setattr(self, 'text', n.get_str_value()),
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
        writer.write_int_value("created_at", self.created_at)
        writer.write_str_value("id", self.id)
        writer.write_str_value("invalid_at", self.invalid_at)
        writer.write_bool_value("is_current", self.is_current)
        writer.write_bool_value("is_global", self.is_global)
        writer.write_str_value("state", self.state)
        writer.write_str_value("superseded_by", self.superseded_by)
        writer.write_str_value("text", self.text)
        writer.write_str_value("valid_at", self.valid_at)
    

