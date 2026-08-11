from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class ConversationMessageItem(Parsable):
    """
    Single turn in a conversation passed to `AddConversationRequest`.
    """
    # Message text.
    content: Optional[str] = None
    # Message role: "user", "assistant", or "system".
    role: Optional[str] = None
    # Optional producer-side turn uuid (pointer anchor, binds from "uuid"). Whenpresent, facts extracted from this turn carry it in source_turn_uuids.
    uuid: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> ConversationMessageItem:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: ConversationMessageItem
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return ConversationMessageItem()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "content": lambda n : setattr(self, 'content', n.get_str_value()),
            "role": lambda n : setattr(self, 'role', n.get_str_value()),
            "uuid": lambda n : setattr(self, 'uuid', n.get_str_value()),
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
        writer.write_str_value("content", self.content)
        writer.write_str_value("role", self.role)
        writer.write_str_value("uuid", self.uuid)
    

