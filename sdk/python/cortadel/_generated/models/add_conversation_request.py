from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .conversation_message_item import ConversationMessageItem

@dataclass
class AddConversationRequest(Parsable):
    """
    Distill a multi-turn conversation into atomic facts and store each one, applyingthe same intent classification, deduplication, and background entity extractionas bulk/create. On empty extraction, nothing is stored.
    """
    # When true, extract facts about the assistant instead of the user. Defaults to false.
    is_agent_memory: Optional[bool] = None
    # Conversation turns, in order (1-500 items).
    messages: Optional[list[ConversationMessageItem]] = None
    # Optional project scope (e.g. repo name).
    project: Optional[str] = None
    # Optional session id to group these facts under (existing :CONTAINS session path).
    session_id: Optional[str] = None
    # Tags for scoped retrieval, applied to every stored fact.
    tags: Optional[list[str]] = None
    # Optional producer-local transcript file path (pointer anchor, binds from"transcript_path"). Stored verbatim as the transcript_path attribute on everyfact extracted from this conversation.
    transcript_path: Optional[str] = None
    # User identifier who owns the extracted memories.
    user_id: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> AddConversationRequest:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: AddConversationRequest
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return AddConversationRequest()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        from .conversation_message_item import ConversationMessageItem

        from .conversation_message_item import ConversationMessageItem

        fields: dict[str, Callable[[Any], None]] = {
            "is_agent_memory": lambda n : setattr(self, 'is_agent_memory', n.get_bool_value()),
            "messages": lambda n : setattr(self, 'messages', n.get_collection_of_object_values(ConversationMessageItem)),
            "project": lambda n : setattr(self, 'project', n.get_str_value()),
            "session_id": lambda n : setattr(self, 'session_id', n.get_str_value()),
            "tags": lambda n : setattr(self, 'tags', n.get_collection_of_primitive_values(str)),
            "transcript_path": lambda n : setattr(self, 'transcript_path', n.get_str_value()),
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
        writer.write_bool_value("is_agent_memory", self.is_agent_memory)
        writer.write_collection_of_object_values("messages", self.messages)
        writer.write_str_value("project", self.project)
        writer.write_str_value("session_id", self.session_id)
        writer.write_collection_of_primitive_values("tags", self.tags)
        writer.write_str_value("transcript_path", self.transcript_path)
        writer.write_str_value("user_id", self.user_id)
    

