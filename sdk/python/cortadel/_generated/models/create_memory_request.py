from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .create_memory_request_metadata import CreateMemoryRequest_metadata

@dataclass
class CreateMemoryRequest(Parsable):
    """
    Create a new memory.
    """
    # Optional application name creating the memory.
    app: Optional[str] = None
    # Whether to infer entities and categories automatically. When false,            stores the text verbatim and skips background entity/category extraction;            dedup still applies.
    infer: Optional[bool] = None
    # Optional caller-provided cognitive type (episodic|semantic|            procedural). Invalid/blank values are ignored and the server falls back to            auto-classification.
    memory_type: Optional[str] = None
    # Optional metadata key-value pairs.
    metadata: Optional[CreateMemoryRequest_metadata] = None
    # Memory text content to store.
    text: Optional[str] = None
    # User identifier who owns this memory.
    user_id: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> CreateMemoryRequest:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: CreateMemoryRequest
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return CreateMemoryRequest()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        from .create_memory_request_metadata import CreateMemoryRequest_metadata

        from .create_memory_request_metadata import CreateMemoryRequest_metadata

        fields: dict[str, Callable[[Any], None]] = {
            "app": lambda n : setattr(self, 'app', n.get_str_value()),
            "infer": lambda n : setattr(self, 'infer', n.get_bool_value()),
            "memory_type": lambda n : setattr(self, 'memory_type', n.get_str_value()),
            "metadata": lambda n : setattr(self, 'metadata', n.get_object_value(CreateMemoryRequest_metadata)),
            "text": lambda n : setattr(self, 'text', n.get_str_value()),
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
        writer.write_str_value("app", self.app)
        writer.write_bool_value("infer", self.infer)
        writer.write_str_value("memory_type", self.memory_type)
        writer.write_object_value("metadata", self.metadata)
        writer.write_str_value("text", self.text)
        writer.write_str_value("user_id", self.user_id)
    

