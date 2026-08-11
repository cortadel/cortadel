from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .conversation_ingest_item import ConversationIngestItem

@dataclass
class ConversationIngestResponse(Parsable):
    """
    Result of ingesting a conversation. The two members are mutually exclusive on thewire (matches the pre-existing untyped response, which sent one key or the other,never both): omit `no_facts_extracted` when facts were stored, omit`results` when nothing was extracted. Both are nullable so the server'sglobal `DefaultIgnoreCondition = WhenWritingNull` drops the unset one instead ofserializing it as `[]` / `false` alongside the other.
    """
    # True when the conversation yielded no storable facts; absent otherwise.
    no_facts_extracted: Optional[bool] = None
    # One entry per distilled fact. Absent when nothing was extracted.
    results: Optional[list[ConversationIngestItem]] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> ConversationIngestResponse:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: ConversationIngestResponse
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return ConversationIngestResponse()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        from .conversation_ingest_item import ConversationIngestItem

        from .conversation_ingest_item import ConversationIngestItem

        fields: dict[str, Callable[[Any], None]] = {
            "no_facts_extracted": lambda n : setattr(self, 'no_facts_extracted', n.get_bool_value()),
            "results": lambda n : setattr(self, 'results', n.get_collection_of_object_values(ConversationIngestItem)),
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
        writer.write_bool_value("no_facts_extracted", self.no_facts_extracted)
        writer.write_collection_of_object_values("results", self.results)
    

