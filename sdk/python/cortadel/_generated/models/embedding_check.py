from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class EmbeddingCheck(Parsable):
    """
    Embedding provider health check result.
    """
    # Embedding vector dimension.
    dim: Optional[int] = None
    # Error message if the check failed.
    error: Optional[str] = None
    # Round-trip latency in milliseconds.
    latency_ms: Optional[int] = None
    # Embedding model name.
    model: Optional[str] = None
    # Whether the embedding provider is operational.
    ok: Optional[bool] = None
    # Embedding provider name (e.g. "openai", "ollama").
    provider: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> EmbeddingCheck:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: EmbeddingCheck
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return EmbeddingCheck()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "dim": lambda n : setattr(self, 'dim', n.get_int_value()),
            "error": lambda n : setattr(self, 'error', n.get_str_value()),
            "latency_ms": lambda n : setattr(self, 'latency_ms', n.get_int_value()),
            "model": lambda n : setattr(self, 'model', n.get_str_value()),
            "ok": lambda n : setattr(self, 'ok', n.get_bool_value()),
            "provider": lambda n : setattr(self, 'provider', n.get_str_value()),
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
        writer.write_int_value("dim", self.dim)
        writer.write_str_value("error", self.error)
        writer.write_int_value("latency_ms", self.latency_ms)
        writer.write_str_value("model", self.model)
        writer.write_bool_value("ok", self.ok)
        writer.write_str_value("provider", self.provider)
    

