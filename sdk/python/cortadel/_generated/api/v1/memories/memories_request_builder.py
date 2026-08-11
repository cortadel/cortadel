from __future__ import annotations
from collections.abc import Callable
from dataclasses import dataclass, field
from kiota_abstractions.base_request_builder import BaseRequestBuilder
from kiota_abstractions.base_request_configuration import RequestConfiguration
from kiota_abstractions.default_query_parameters import QueryParameters
from kiota_abstractions.get_path_parameters import get_path_parameters
from kiota_abstractions.method import Method
from kiota_abstractions.request_adapter import RequestAdapter
from kiota_abstractions.request_information import RequestInformation
from kiota_abstractions.request_option import RequestOption
from kiota_abstractions.serialization import Parsable, ParsableFactory
from typing import Any, Optional, TYPE_CHECKING, Union
from warnings import warn

if TYPE_CHECKING:
    from ....models.create_memory_request import CreateMemoryRequest
    from ....models.delete_memories_request import DeleteMemoriesRequest
    from ....models.delete_memories_response import DeleteMemoriesResponse
    from ....models.error_response import ErrorResponse
    from ....models.memory_created_response import MemoryCreatedResponse
    from ....models.memory_list_paged_response import MemoryListPagedResponse
    from ....models.validation_problem_details import ValidationProblemDetails
    from .from_conversation.from_conversation_request_builder import FromConversationRequestBuilder
    from .item.with_memory_item_request_builder import WithMemoryItemRequestBuilder
    from .search.search_request_builder import SearchRequestBuilder

class MemoriesRequestBuilder(BaseRequestBuilder):
    """
    Builds and executes requests for operations under /api/v1/memories
    """
    def __init__(self,request_adapter: RequestAdapter, path_parameters: Union[str, dict[str, Any]]) -> None:
        """
        Instantiates a new MemoriesRequestBuilder and sets the default values.
        param path_parameters: The raw url or the url-template parameters for the request.
        param request_adapter: The request adapter to use to execute the requests.
        Returns: None
        """
        super().__init__(request_adapter, "{+baseurl}/api/v1/memories{?app_id*,as_of*,categories*,include_superseded*,memory_type*,page*,search_query*,size*}", path_parameters)
    
    def by_memory_id(self,memory_id: str) -> WithMemoryItemRequestBuilder:
        """
        Gets an item from the cortadel._generated.api.v1.memories.item collection
        param memory_id: Memory identifier.
        Returns: WithMemoryItemRequestBuilder
        """
        if memory_id is None:
            raise TypeError("memory_id cannot be null.")
        from .item.with_memory_item_request_builder import WithMemoryItemRequestBuilder

        url_tpl_params = get_path_parameters(self.path_parameters)
        url_tpl_params["memoryId"] = memory_id
        return WithMemoryItemRequestBuilder(self.request_adapter, url_tpl_params)
    
    async def delete(self,body: DeleteMemoriesRequest, request_configuration: Optional[RequestConfiguration[QueryParameters]] = None) -> Optional[DeleteMemoriesResponse]:
        """
        Delete one or more memories by their identifiers.
        param body: Delete one or more memories.
        param request_configuration: Configuration for the request such as headers, query parameters, and middleware options.
        Returns: Optional[DeleteMemoriesResponse]
        """
        if body is None:
            raise TypeError("body cannot be null.")
        request_info = self.to_delete_request_information(
            body, request_configuration
        )
        from ....models.error_response import ErrorResponse
        from ....models.validation_problem_details import ValidationProblemDetails

        error_mapping: dict[str, type[ParsableFactory]] = {
            "400": ValidationProblemDetails,
            "401": ErrorResponse,
            "500": ErrorResponse,
        }
        if not self.request_adapter:
            raise Exception("Http core is null") 
        from ....models.delete_memories_response import DeleteMemoriesResponse

        return await self.request_adapter.send_async(request_info, DeleteMemoriesResponse, error_mapping)
    
    async def get(self,request_configuration: Optional[RequestConfiguration[MemoriesRequestBuilderGetQueryParameters]] = None) -> Optional[MemoryListPagedResponse]:
        """
        List memories with pagination, filtering, and optional text search.
        param request_configuration: Configuration for the request such as headers, query parameters, and middleware options.
        Returns: Optional[MemoryListPagedResponse]
        """
        request_info = self.to_get_request_information(
            request_configuration
        )
        from ....models.error_response import ErrorResponse
        from ....models.validation_problem_details import ValidationProblemDetails

        error_mapping: dict[str, type[ParsableFactory]] = {
            "400": ValidationProblemDetails,
            "401": ErrorResponse,
            "500": ErrorResponse,
        }
        if not self.request_adapter:
            raise Exception("Http core is null") 
        from ....models.memory_list_paged_response import MemoryListPagedResponse

        return await self.request_adapter.send_async(request_info, MemoryListPagedResponse, error_mapping)
    
    async def post(self,body: CreateMemoryRequest, request_configuration: Optional[RequestConfiguration[QueryParameters]] = None) -> Optional[MemoryCreatedResponse]:
        """
        Create a new memory for a user, with automatic deduplication.
        param body: Create a new memory.
        param request_configuration: Configuration for the request such as headers, query parameters, and middleware options.
        Returns: Optional[MemoryCreatedResponse]
        """
        if body is None:
            raise TypeError("body cannot be null.")
        request_info = self.to_post_request_information(
            body, request_configuration
        )
        from ....models.error_response import ErrorResponse
        from ....models.validation_problem_details import ValidationProblemDetails

        error_mapping: dict[str, type[ParsableFactory]] = {
            "400": ValidationProblemDetails,
            "401": ErrorResponse,
            "403": ErrorResponse,
            "500": ErrorResponse,
        }
        if not self.request_adapter:
            raise Exception("Http core is null") 
        from ....models.memory_created_response import MemoryCreatedResponse

        return await self.request_adapter.send_async(request_info, MemoryCreatedResponse, error_mapping)
    
    def to_delete_request_information(self,body: DeleteMemoriesRequest, request_configuration: Optional[RequestConfiguration[QueryParameters]] = None) -> RequestInformation:
        """
        Delete one or more memories by their identifiers.
        param body: Delete one or more memories.
        param request_configuration: Configuration for the request such as headers, query parameters, and middleware options.
        Returns: RequestInformation
        """
        if body is None:
            raise TypeError("body cannot be null.")
        request_info = RequestInformation(Method.DELETE, self.url_template, self.path_parameters)
        request_info.configure(request_configuration)
        request_info.headers.try_add("Accept", "application/json")
        request_info.set_content_from_parsable(self.request_adapter, "application/json", body)
        return request_info
    
    def to_get_request_information(self,request_configuration: Optional[RequestConfiguration[MemoriesRequestBuilderGetQueryParameters]] = None) -> RequestInformation:
        """
        List memories with pagination, filtering, and optional text search.
        param request_configuration: Configuration for the request such as headers, query parameters, and middleware options.
        Returns: RequestInformation
        """
        request_info = RequestInformation(Method.GET, '{+baseurl}/api/v1/memories?user_id={user_id}{&app_id*,as_of*,categories*,include_superseded*,memory_type*,page*,search_query*,size*}', self.path_parameters)
        request_info.configure(request_configuration)
        request_info.headers.try_add("Accept", "application/json")
        return request_info
    
    def to_post_request_information(self,body: CreateMemoryRequest, request_configuration: Optional[RequestConfiguration[QueryParameters]] = None) -> RequestInformation:
        """
        Create a new memory for a user, with automatic deduplication.
        param body: Create a new memory.
        param request_configuration: Configuration for the request such as headers, query parameters, and middleware options.
        Returns: RequestInformation
        """
        if body is None:
            raise TypeError("body cannot be null.")
        request_info = RequestInformation(Method.POST, self.url_template, self.path_parameters)
        request_info.configure(request_configuration)
        request_info.headers.try_add("Accept", "application/json")
        request_info.set_content_from_parsable(self.request_adapter, "application/json", body)
        return request_info
    
    def with_url(self,raw_url: str) -> MemoriesRequestBuilder:
        """
        Returns a request builder with the provided arbitrary URL. Using this method means any other path or query parameters are ignored.
        param raw_url: The raw URL to use for the request builder.
        Returns: MemoriesRequestBuilder
        """
        if raw_url is None:
            raise TypeError("raw_url cannot be null.")
        return MemoriesRequestBuilder(self.request_adapter, raw_url)
    
    @property
    def from_conversation(self) -> FromConversationRequestBuilder:
        """
        The fromConversation property
        """
        from .from_conversation.from_conversation_request_builder import FromConversationRequestBuilder

        return FromConversationRequestBuilder(self.request_adapter, self.path_parameters)
    
    @property
    def search(self) -> SearchRequestBuilder:
        """
        The search property
        """
        from .search.search_request_builder import SearchRequestBuilder

        return SearchRequestBuilder(self.request_adapter, self.path_parameters)
    
    @dataclass
    class MemoriesRequestBuilderDeleteRequestConfiguration(RequestConfiguration[QueryParameters]):
        """
        Configuration for the request such as headers, query parameters, and middleware options.
        """
        warn("This class is deprecated. Please use the generic RequestConfiguration class generated by the generator.", DeprecationWarning)
    
    @dataclass
    class MemoriesRequestBuilderGetQueryParameters():
        """
        List memories with pagination, filtering, and optional text search.
        """
        # Optional app identifier to filter by.
        app_id: Optional[str] = None

        # Optional temporal filter for valid-at date.
        as_of: Optional[str] = None

        # Comma-separated category names to filter by.
        categories: Optional[str] = None

        # Set to "true" to include superseded memories.
        include_superseded: Optional[str] = None

        # Optional cognitive-type filter (episodic|semantic|procedural); invalid values are ignored.
        memory_type: Optional[str] = None

        # Page number (default 1).
        page: Optional[int] = None

        # Optional text query for hybrid search.
        search_query: Optional[str] = None

        # Page size (default 10, max 100).
        size: Optional[int] = None

        # User identifier.
        user_id: Optional[str] = None

    
    @dataclass
    class MemoriesRequestBuilderGetRequestConfiguration(RequestConfiguration[MemoriesRequestBuilderGetQueryParameters]):
        """
        Configuration for the request such as headers, query parameters, and middleware options.
        """
        warn("This class is deprecated. Please use the generic RequestConfiguration class generated by the generator.", DeprecationWarning)
    
    @dataclass
    class MemoriesRequestBuilderPostRequestConfiguration(RequestConfiguration[QueryParameters]):
        """
        Configuration for the request such as headers, query parameters, and middleware options.
        """
        warn("This class is deprecated. Please use the generic RequestConfiguration class generated by the generator.", DeprecationWarning)
    

