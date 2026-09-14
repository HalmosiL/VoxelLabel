"""Configuration for the CT annotator viewer's thin backend. Every
upstream URL defaults to the main platform's *published host* ports
(this service runs standalone, alongside that platform, not inside its
docker-compose network) -- matching how a browser already reaches those
same services today."""
import os

KEYCLOAK_ISSUER = os.environ.get("KEYCLOAK_ISSUER", "http://localhost:8080/realms/ct-platform")
KEYCLOAK_JWKS_URL = os.environ.get("KEYCLOAK_JWKS_URL", f"{KEYCLOAK_ISSUER}/protocol/openid-connect/certs")
KEYCLOAK_AUDIENCE = os.environ.get("KEYCLOAK_AUDIENCE", "ct-platform")

DATA_SERVICE_URL = os.environ.get("DATA_SERVICE_URL", "http://localhost:8002")
ANNOTATION_SERVICE_URL = os.environ.get("ANNOTATION_SERVICE_URL", "http://localhost:8003")
ADMIN_SERVICE_URL = os.environ.get("ADMIN_SERVICE_URL", "http://localhost:8004")

# Same shared bucket the main platform's ingestion-service/data-service/
# admin-service already use -- see backend/README.md for why this service
# writes there directly instead of proxying uploads through another
# service (no upload-capable endpoint exists there for this).
OBJECT_STORAGE_ENDPOINT = os.environ.get("OBJECT_STORAGE_ENDPOINT", "http://localhost:9000")
OBJECT_STORAGE_BUCKET = os.environ.get("OBJECT_STORAGE_BUCKET", "ct-pixel-data")
OBJECT_STORAGE_ACCESS_KEY = os.environ.get("OBJECT_STORAGE_ACCESS_KEY", "minioadmin")
OBJECT_STORAGE_SECRET_KEY = os.environ.get("OBJECT_STORAGE_SECRET_KEY", "minioadmin")

# How long a parsed pydicom Dataset stays cached in-process, keyed by
# instance id -- long enough that dragging a window/level slider doesn't
# re-download+re-decode the source file on every tick.
RENDER_CACHE_TTL_SECONDS = int(os.environ.get("RENDER_CACHE_TTL_SECONDS", "60"))

CORS_ALLOWED_ORIGINS = os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:5174").split(",")
