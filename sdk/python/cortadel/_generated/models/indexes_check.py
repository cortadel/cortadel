from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class IndexesCheck(Parsable):
    """
    Vector-index status from the startup embedding-guard report (informational — never fails health).
    """
    # Introspection error captured at startup, if any.
    error: Optional[str] = None
    # Dimension mismatches as "Label.property: index N != provider M" strings.
    mismatches: Optional[list[str]] = None
    # Normalized embedding model id.
    model: Optional[str] = None
    # Whether all vector indexes match the provider dimension and introspection succeeded.
    ok: Optional[bool] = None
    # Configured embedding provider dimension.
    provider_dim: Optional[int] = None
    # Indexes as "Label.property@dimension" strings.
    vector_indexes: Optional[list[str]] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> IndexesCheck:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: IndexesCheck
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return IndexesCheck()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "error": lambda n : setattr(self, 'error', n.get_str_value()),
            "mismatches": lambda n : setattr(self, 'mismatches', n.get_collection_of_primitive_values(str)),
            "model": lambda n : setattr(self, 'model', n.get_str_value()),
            "ok": lambda n : setattr(self, 'ok', n.get_bool_value()),
            "provider_dim": lambda n : setattr(self, 'provider_dim', n.get_int_value()),
            "vector_indexes": lambda n : setattr(self, 'vector_indexes', n.get_collection_of_primitive_values(str)),
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
        writer.write_collection_of_primitive_values("mismatches", self.mismatches)
        writer.write_str_value("model", self.model)
        writer.write_bool_value("ok", self.ok)
        writer.write_int_value("provider_dim", self.provider_dim)
        writer.write_collection_of_primitive_values("vector_indexes", self.vector_indexes)
    

