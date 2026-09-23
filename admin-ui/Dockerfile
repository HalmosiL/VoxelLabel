# Build context is the repo root (see docker-compose.yml).
FROM node:20-slim AS build
WORKDIR /app
COPY admin-ui/package.json admin-ui/package-lock.json ./
RUN npm ci
COPY admin-ui ./

# Where the browser reaches Keycloak, the four APIs and the viewer --
# Vite inlines these at build time (src/config.ts), so they're build
# args, passed from .env by docker-compose.yml. Defaults = local dev.
ARG VITE_KEYCLOAK_URL=http://localhost:8080
ARG VITE_KEYCLOAK_REALM=ct-platform
ARG VITE_KEYCLOAK_CLIENT_ID=ct-platform
ARG VITE_INGESTION_API=http://localhost:8001
ARG VITE_DATA_API=http://localhost:8002
ARG VITE_ANNOTATION_API=http://localhost:8003
ARG VITE_ADMIN_API=http://localhost:8004
ARG VITE_ANNOTATOR_UI_URL=http://localhost:5174
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL \
    VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM \
    VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID \
    VITE_INGESTION_API=$VITE_INGESTION_API \
    VITE_DATA_API=$VITE_DATA_API \
    VITE_ANNOTATION_API=$VITE_ANNOTATION_API \
    VITE_ADMIN_API=$VITE_ADMIN_API \
    VITE_ANNOTATOR_UI_URL=$VITE_ANNOTATOR_UI_URL
# The build stamped on every usage event (vite.config.ts); empty falls
# back to package version + build time. CI passes the commit.
ARG APP_VERSION=
ENV APP_VERSION=$APP_VERSION
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY admin-ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
