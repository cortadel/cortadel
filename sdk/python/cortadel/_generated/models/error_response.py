from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.api_error import APIError
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

@dataclass
class ErrorResponse(APIError, Parsable):
    """
    Unified API error response (RFC 7807 inspired).
    """
    # Short error code for client-side handling (e.g., "not_found", "validation_error", "internal_error").
    code: Optional[str] = None
    # Optional detailed information (stack trace in development, null in production).
    detail: Optional[str] = None
    # Human-readable error message.
    message: Optional[str] = None
    # HTTP status code.
    status: Optional[int] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> ErrorResponse:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: ErrorResponse
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return ErrorResponse()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        fields: dict[str, Callable[[Any], None]] = {
            "code": lambda n : setattr(self, 'code', n.get_str_value()),
            "detail": lambda n : setattr(self, 'detail', n.get_str_value()),
            "message": lambda n : setattr(self, 'message', n.get_str_value()),
            "status": lambda n : setattr(self, 'status', n.get_int_value()),
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
        writer.write_str_value("code", self.code)
        writer.write_str_value("detail", self.detail)
        writer.write_str_value("message", self.message)
        writer.write_int_value("status", self.status)
    
    @property
    def primary_message(self) -> Optional[str]:
        """
        The primary error message.
        """
        return super().message

