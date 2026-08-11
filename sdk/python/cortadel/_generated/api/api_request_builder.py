from __future__ import annotations
from collections.abc import Callable
from kiota_abstractions.base_request_builder import BaseRequestBuilder
from kiota_abstractions.get_path_parameters import get_path_parameters
from kiota_abstractions.request_adapter import RequestAdapter
from typing import Any, Optional, TYPE_CHECKING, Union

if TYPE_CHECKING:
    from .health.health_request_builder import HealthRequestBuilder
    from .v1.v1_request_builder import V1RequestBuilder

class ApiRequestBuilder(BaseRequestBuilder):
    """
    Builds and executes requests for operations under /api
    """
    def __init__(self,request_adapter: RequestAdapter, path_parameters: Union[str, dict[str, Any]]) -> None:
        """
        Instantiates a new ApiRequestBuilder and sets the default values.
        param path_parameters: The raw url or the url-template parameters for the request.
        param request_adapter: The request adapter to use to execute the requests.
        Returns: None
        """
        super().__init__(request_adapter, "{+baseurl}/api", path_parameters)
    
    @property
    def health(self) -> HealthRequestBuilder:
        """
        The health property
        """
        from .health.health_request_builder import HealthRequestBuilder

        return HealthRequestBuilder(self.request_adapter, self.path_parameters)
    
    @property
    def v1(self) -> V1RequestBuilder:
        """
        The v1 property
        """
        from .v1.v1_request_builder import V1RequestBuilder

        return V1RequestBuilder(self.request_adapter, self.path_parameters)
    

