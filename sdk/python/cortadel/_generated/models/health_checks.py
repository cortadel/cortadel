from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .embedding_check import EmbeddingCheck
    from .indexes_check import IndexesCheck
    from .memgraph_check import MemgraphCheck

@dataclass
class HealthChecks(Parsable):
    """
    Container for individual health checks.
    """
    # Embedding provider health check result.
    embeddings: Optional[EmbeddingCheck] = None
    # Vector-index status from the startup embedding-guard report (informational — never fails health).
    indexes: Optional[IndexesCheck] = None
    # Memgraph database health check result.
    memgraph: Optional[MemgraphCheck] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> HealthChecks:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: HealthChecks
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return HealthChecks()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        from .embedding_check import EmbeddingCheck
        from .indexes_check import IndexesCheck
        from .memgraph_check import MemgraphCheck

        from .embedding_check import EmbeddingCheck
        from .indexes_check import IndexesCheck
        from .memgraph_check import MemgraphCheck

        fields: dict[str, Callable[[Any], None]] = {
            "embeddings": lambda n : setattr(self, 'embeddings', n.get_object_value(EmbeddingCheck)),
            "indexes": lambda n : setattr(self, 'indexes', n.get_object_value(IndexesCheck)),
            "memgraph": lambda n : setattr(self, 'memgraph', n.get_object_value(MemgraphCheck)),
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
        writer.write_object_value("embeddings", self.embeddings)
        writer.write_object_value("indexes", self.indexes)
        writer.write_object_value("memgraph", self.memgraph)
    

