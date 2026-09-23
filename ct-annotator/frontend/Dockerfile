FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./

# Where the browser reaches Keycloak, admin-ui and this app's own
# backend -- Vite inlines these at build time (src/config.ts), so
# they're build args, passed from .env by docker-compose.yml.
ARG VITE_KEYCLOAK_URL=http://localhost:8080
ARG VITE_KEYCLOAK_REALM=ct-platform
ARG VITE_KEYCLOAK_CLIENT_ID=ct-platform
ARG VITE_ADMIN_UI_URL=http://localhost:5173
ARG VITE_ANNOTATOR_API=http://localhost:8010
# Empty by default -- set only when this app is mounted under a
# sub-path of a shared origin (vite.config.ts's `base` + main.tsx's
# router basename both read it).
ARG VITE_BASE_PATH=/
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL \
    VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM \
    VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID \
    VITE_ADMIN_UI_URL=$VITE_ADMIN_UI_URL \
    VITE_ANNOTATOR_API=$VITE_ANNOTATOR_API \
    VITE_BASE_PATH=$VITE_BASE_PATH
# The build stamped on every usage event (vite.config.ts); empty falls
# back to package version + build time. CI passes the commit.
ARG APP_VERSION=
ENV APP_VERSION=$APP_VERSION
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
