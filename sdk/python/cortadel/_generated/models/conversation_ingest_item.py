from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class ConversationIngestItem(Parsable):
    """
    One fact distilled from a conversation and stored.
    """
    # Failure detail when `event` is `ERROR` (or another failed branch); absent otherwise.
    error: Optional[str] = None
    # What the store pipeline did, e.g. `ADD`, `SKIP_DUPLICATE`, or `ERROR`.
    event: Optional[str] = None
    # Id of the stored memory. Empty when the underlying pipeline event carries no id (e.g. `ERROR`, `INVALIDATE`).
    id: Optional[str] = None
    # The distilled fact text.
    memory: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> ConversationIngestItem:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: ConversationIngestItem
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return ConversationIngestItem()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "error": lambda n : setattr(self, 'error', n.get_str_value()),
            "event": lambda n : setattr(self, 'event', n.get_str_value()),
            "id": lambda n : setattr(self, 'id', n.get_str_value()),
            "memory": lambda n : setattr(self, 'memory', n.get_str_value()),
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
        writer.write_str_value("error", self.error)
        writer.write_str_value("event", self.event)
        writer.write_str_value("id", self.id)
        writer.write_str_value("memory", self.memory)
    

