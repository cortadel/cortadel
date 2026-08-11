from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.serialization import Parsable, ParseNode, SerializationWriter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .memory_list_item_response import MemoryListItemResponse

@dataclass
class MemoryListPagedResponse(Parsable):
    """
    Paginated list of memory list items.
    """
    # Memory items on the current page.
    items: Optional[list[MemoryListItemResponse]] = None
    # Current page number (1-based).
    page: Optional[int] = None
    # Total number of pages.
    pages: Optional[int] = None
    # Page size (items per page).
    size: Optional[int] = None
    # Total number of items across all pages.
    total: Optional[int] = None
    
    @staticmethod
    def create_from_discriminator_value(parse_node: ParseNode) -> MemoryListPagedResponse:
        """
        Creates a new instance of the appropriate class based on discriminator value
        param parse_node: The parse node to use to read the discriminator value and create the object
        Returns: MemoryListPagedResponse
        """
        if parse_node is None:
            raise TypeError("parse_node cannot be null.")
        return MemoryListPagedResponse()
    
    def get_field_deserializers(self,) -> dict[str, Callable[[ParseNode], None]]:
        """
        The deserialization information for the current model
        Returns: dict[str, Callable[[ParseNode], None]]
        """
        from .memory_list_item_response import MemoryListItemResponse

        from .memory_list_item_response import MemoryListItemResponse

        fields: dict[str, Callable[[Any], None]] = {
            "items": lambda n : setattr(self, 'items', n.get_collection_of_object_values(MemoryListItemResponse)),
            "page": lambda n : setattr(self, 'page', n.get_int_value()),
            "pages": lambda n : setattr(self, 'pages', n.get_int_value()),
            "size": lambda n : setattr(self, 'size', n.get_int_value()),
            "total": lambda n : setattr(self, 'total', n.get_int_value()),
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
        writer.write_collection_of_object_values("items", self.items)
        writer.write_int_value("page", self.page)
        writer.write_int_value("pages", self.pages)
        writer.write_int_value("size", self.size)
        writer.write_int_value("total", self.total)
    

