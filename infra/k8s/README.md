# Kubernetes manifests

Deployment/Service manifests for the four application services, plus
namespace, shared config, and ingress routing.

## Apply order

```bash
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f secret.example.yaml   # copy to secret.yaml with real values first, or use External Secrets Operator
kubectl apply -f ingestion-service.yaml
kubectl apply -f data-service.yaml
kubectl apply -f annotation-service.yaml
kubectl apply -f admin-service.yaml
kubectl apply -f ingress.yaml
```

## Intentionally not included here

**Postgres, Redis, MinIO, Keycloak.** For local development, run these via
the root `docker-compose.yml` instead. For a production cluster:

- **Postgres**: use a managed service (RDS/Cloud SQL) or the
  CloudNativePG operator -- not a hand-rolled StatefulSet. Backup, HA and
  patching are not worth re-implementing.
- **Redis**: managed (ElastiCache/Memorystore) or the Bitnami/Redis
  Operator Helm chart.
- **MinIO**: cloud S3 if running in a cloud provider; the MinIO Operator
  if self-hosting.
- **Keycloak**: the official Keycloak Operator, with its own HA Postgres,
  not `start-dev` mode (which is dev-only, in-memory by default).

Wiring these in is deliberately deferred until the target environment
(cloud vs. on-prem) is decided -- see `ARCHITECTURE.md`.

## Images

Each `image:` field is a placeholder (`REPLACE_WITH_REGISTRY/...`) -- fill
in your container registry once CI is set up to build and push the four
service images (see each `services/*/Dockerfile`).
