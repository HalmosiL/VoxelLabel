"""Object storage (MinIO) being unreachable answers 503, not 500.

With storage down, every request that touched it -- a DICOM upload, a
document, an export -- answered a bare 500 after several seconds of
retries (I-08). install_storage_error_handlers(app) maps boto's
connection-level errors once for a whole service to a 503 that says
storage is unavailable. A refusal from storage itself (ClientError, e.g.
a missing key) is left alone: that is the endpoint's to answer.

A no-op in a service without botocore."""
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)

STORAGE_DOWN = "File storage is unavailable right now -- try again in a minute."


def install_storage_error_handlers(app: FastAPI) -> None:
    try:
        from botocore.exceptions import ConnectionError as BotoConnectionError
        from botocore.exceptions import HTTPClientError
    except ImportError:
        return

    async def storage_down(request: Request, exc: Exception) -> JSONResponse:
        log.warning("object storage unreachable (%s %s): %s", request.method, request.url.path, exc)
        return JSONResponse(status_code=503, content={"detail": STORAGE_DOWN})

    # EndpointConnectionError / ConnectTimeoutError are ConnectionErrors;
    # ReadTimeoutError / ConnectionClosedError are HTTPClientErrors.
    for error in (BotoConnectionError, HTTPClientError):
        app.add_exception_handler(error, storage_down)
