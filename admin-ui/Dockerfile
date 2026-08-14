# Build context is the repo root (see docker-compose.yml).
FROM node:20-slim AS build
WORKDIR /app
COPY admin-ui/package.json ./
RUN npm install
COPY admin-ui ./
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY admin-ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
