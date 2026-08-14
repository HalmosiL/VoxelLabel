# Build context is the repo root (see docker-compose.yml), because this
# service depends on the local libs/shared-models and libs/shared-auth
# packages.
FROM python:3.11-slim

WORKDIR /app

COPY libs/shared-models /libs/shared-models
COPY libs/shared-auth /libs/shared-auth

COPY services/data-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir -e /libs/shared-models -e /libs/shared-auth

COPY services/data-service/app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
