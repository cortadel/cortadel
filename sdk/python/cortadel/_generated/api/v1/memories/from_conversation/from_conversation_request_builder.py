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
    from .....models.add_conversation_request import AddConversationRequest
    from .....models.conversation_ingest_response import ConversationIngestResponse
    from .....models.error_response import ErrorResponse
    from .....models.validation_problem_details import ValidationProblemDetails

class FromConversationRequestBuilder(BaseRequestBuilder):
    """
    Builds and executes requests for operations under /api/v1/memories/from-conversation
    """
    def __init__(self,request_adapter: RequestAdapter, path_parameters: Union[str, dict[str, Any]]) -> None:
        """
        Instantiates a new FromConversationRequestBuilder and sets the default values.
        param path_parameters: The raw url or the url-template parameters for the request.
        param request_adapter: The request adapter to use to execute the requests.
        Returns: None
        """
        super().__init__(request_adapter, "{+baseurl}/api/v1/memories/from-conversation", path_parameters)
    
    async def post(self,body: AddConversationRequest, request_configuration: Optional[RequestConfiguration[QueryParameters]] = None) -> Optional[ConversationIngestResponse]:
        """
        Distill a multi-turn conversation into atomic facts and store each one,applying the same intent classification, deduplication, and background entityextraction as the bulk/create endpoints. On empty extraction, nothing isstored — no raw un-atomized turns are persisted; the caller can retry viabulk/create with its own text.
        param body: Distill a multi-turn conversation into atomic facts and store each one, applyingthe same intent classification, deduplication, and background entity extractionas bulk/create. On empty extraction, nothing is stored.
        param request_configuration: Configuration for the request such as headers, query parameters, and middleware options.
        Returns: Optional[ConversationIngestResponse]
        """
        if body is None:
            raise TypeError("body cannot be null.")
        request_info = self.to_post_request_information(
            body, request_configuration
        )
        from .....models.error_response import ErrorResponse
        from .....models.validation_problem_details import ValidationProblemDetails

        error_mapping: dict[str, type[ParsableFactory]] = {
            "400": ValidationProblemDetails,
            "401": ErrorResponse,
            "500": ErrorResponse,
        }
        if not self.request_adapter:
            raise Exception("Http core is null") 
        from .....models.conversation_ingest_response import ConversationIngestResponse

        return await self.request_adapter.send_async(request_info, ConversationIngestResponse, error_mapping)
    
    def to_post_request_information(self,body: AddConversationRequest, request_configuration: Optional[RequestConfiguration[QueryParameters]] = None) -> RequestInformation:
        """
        Distill a multi-turn conversation into atomic facts and store each one,applying the same intent classification, deduplication, and background entityextraction as the bulk/create endpoints. On empty extraction, nothing isstored — no raw un-atomized turns are persisted; the caller can retry viabulk/create with its own text.
        param body: Distill a multi-turn conversation into atomic facts and store each one, applyingthe same intent classification, deduplication, and background entity extractionas bulk/create. On empty extraction, nothing is stored.
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
    
    def with_url(self,raw_url: str) -> FromConversationRequestBuilder:
        """
        Returns a request builder with the provided arbitrary URL. Using this method means any other path or query parameters are ignored.
        param raw_url: The raw URL to use for the request builder.
        Returns: FromConversationRequestBuilder
        """
        if raw_url is None:
            raise TypeError("raw_url cannot be null.")
        return FromConversationRequestBuilder(self.request_adapter, raw_url)
    
    @dataclass
    class FromConversationRequestBuilderPostRequestConfiguration(RequestConfiguration[QueryParameters]):
        """
        Configuration for the request such as headers, query parameters, and middleware options.
        """
        warn("This class is deprecated. Please use the generic RequestConfiguration class generated by the generator.", DeprecationWarning)
    

