# Build context is the repo root (see docker-compose.yml), because this
# service depends on the local libs/shared-models package -- same reason
# every other service's Dockerfile builds from the repo root.
FROM python:3.11-slim

WORKDIR /app

COPY libs/shared-models /libs/shared-models

COPY services/mcp-server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir -e /libs/shared-models

COPY services/mcp-server/app ./app

# Not a FastAPI app -- MCPServer.run() drives its own ASGI server
# directly (Streamable HTTP transport, see app/server.py).
CMD ["python", "-m", "app.server"]
