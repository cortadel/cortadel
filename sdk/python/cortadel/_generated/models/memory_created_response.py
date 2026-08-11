from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class MemoryCreatedResponse(Parsable):
    """
    Response returned after creating a memory.
    """
    # Application name that created this memory.
    app_name: Optional[str] = None
    # Text content of the created memory.
    content: Optional[str] = None
    # ISO 8601 creation timestamp.
    created_at: Optional[str] = None
    # Event type indicating what happened (e.g. "SKIP_DUPLICATE").
    event: Optional[str] = None
    # Unique identifier of the created memory.
    id: Optional[str] = None
    # Metadata JSON string.
    metadata: Optional[str] = None
    # State of the created memory (e.g. "active").
    state: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> MemoryCreatedResponse:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: MemoryCreatedResponse
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return MemoryCreatedResponse()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "app_name": lambda n : setattr(self, 'app_name', n.get_str_value()),
            "content": lambda n : setattr(self, 'content', n.get_str_value()),
            "created_at": lambda n : setattr(self, 'created_at', n.get_str_value()),
            "event": lambda n : setattr(self, 'event', n.get_str_value()),
            "id": lambda n : setattr(self, 'id', n.get_str_value()),
            "metadata": lambda n : setattr(self, 'metadata', n.get_str_value()),
            "state": lambda n : setattr(self, 'state', n.get_str_value()),
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
        writer.write_str_value("content", self.content)
        writer.write_str_value("created_at", self.created_at)
        writer.write_str_value("event", self.event)
        writer.write_str_value("id", self.id)
        writer.write_str_value("metadata", self.metadata)
        writer.write_str_value("state", self.state)
    

