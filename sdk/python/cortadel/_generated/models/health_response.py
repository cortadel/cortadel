from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.api_error import APIError
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .health_checks import HealthChecks

@dataclass
class HealthResponse(APIError, Parsable):
    """
    Health check response.
    """
    # ISO 8601 timestamp when the health check was performed.
    checked_at: Optional[str] = None
    # Container for individual health checks.
    checks: Optional[HealthChecks] = None
    # Overall status: `ok` when every check passed, `degraded` otherwise.
    status: Optional[str] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> HealthResponse:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: HealthResponse
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return HealthResponse()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        from .health_checks import HealthChecks

        from .health_checks import HealthChecks

        fields: dict[str, Callable[[Any], None]] = {
            "checked_at": lambda n : setattr(self, 'checked_at', n.get_str_value()),
            "checks": lambda n : setattr(self, 'checks', n.get_object_value(HealthChecks)),
            "status": lambda n : setattr(self, 'status', n.get_str_value()),
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
        writer.write_str_value("checked_at", self.checked_at)
        writer.write_object_value("checks", self.checks)
        writer.write_str_value("status", self.status)
    
    @property
    def primary_message(self) -> Optional[str]:
        """
        The primary error message.
        """
        return super().message

