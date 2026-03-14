# Docker Deployment Strategy for Multi-Tenant SaaS

This document outlines containerization and deployment strategies for a multi-tenant SaaS system using Docker, ensuring tenant isolation, scalability, and operational simplicity.

## Table of Contents

1. [Single Container Architecture](#single-container-architecture)
2. [Multi-Stage Build Strategy](#multi-stage-build-strategy)
3. [Environment Configuration](#environment-configuration)
4. [Secrets Management](#secrets-management)
5. [Docker Compose Local Development](#docker-compose-local-development)
6. [Production Deployment](#production-deployment)
7. [Health Checks and Logging](#health-checks-and-logging)
8. [Resource Limits & Memory Management](#resource-limits--memory-management)

---

## Single Container Architecture

### Why One Container Per Service (Not Per Tenant)?

In multi-tenant SaaS, a **single application instance serves all tenants**. Each container runs the same application code but processes requests from different tenants via `tenant_id` headers or JWT claims.

```
┌─────────────────────────────────────────┐
│    Single API Container                  │
│  (same code, all tenants)                │
│                                          │
│  Handles requests:                       │
│  - Tenant A (headers: tenant_id=A)      │
│  - Tenant B (headers: tenant_id=B)      │
│  - Tenant C (headers: tenant_id=C)      │
│                                          │
│  All tenant isolation enforced in:       │
│  - Middleware (tenant validation)        │
│  - Repository queries (WHERE tenant_id)  │
│  - Caching (keys: tenant:{id}:...)      │
└─────────────────────────────────────────┘
```

**Benefits:**

- Simpler deployment (one image to maintain)
- Efficient resource usage (no N containers for N tenants)
- Easier debugging (single log stream per service)
- Faster scaling (spawn more API containers horizontally)

**Tenant Isolation Enforced At:**

- **Middleware**: Extract and validate tenant from JWT or headers
- **Repository Layer**: All queries include `WHERE tenant_id = ?`
- **Caching**: Cache keys prefixed with `tenant:{id}:`
- **Events/Webhooks**: Include `tenant_id` in all async messages
- **Logging**: Context includes `tenant_id` for tracing

---

## Multi-Stage Build Strategy

Multi-stage Docker builds reduce image size and improve build security by separating build artifacts from runtime environment.

### Dockerfile Pattern (API / Backend)

```dockerfile
# Stage 1: Dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@10.0.0
RUN pnpm install --frozen-lockfile --prod

# Stage 2: Builder
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm@10.0.0
RUN pnpm install --frozen-lockfile
# Copy all source
COPY . .
# Build TypeScript
RUN pnpm --filter @app/api build
RUN pnpm --filter @donebyme/db build

# Stage 3: Runtime
FROM node:22-alpine AS runtime
WORKDIR /app

# Health check tool
RUN apk add --no-cache tini curl

# Copy production dependencies from Stage 1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/pnpm-lock.yaml ./

# Copy built application from Stage 2
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/package.json ./

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001

# Copy only necessary files
COPY --chown=app:nodejs apps/api/package.json ./apps/api/
COPY --chown=app:nodejs packages/db/package.json ./packages/db/

USER app

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8444/health || exit 1

# Use tini to handle signals properly
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
```

### Dockerfile Pattern (Frontend / Web)

```dockerfile
# Stage 1: Builder
FROM node:22-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm@10.0.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# Build Next.js application
RUN pnpm --filter web build

# Stage 2: Runtime
FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini curl

COPY --from=builder /app/apps/web/.next ./.next
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/package.json ./
COPY --from=builder /app/node_modules ./node_modules

RUN addgroup -g 1001 -S nodejs && adduser -S app -u 1001
USER app

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/next", "start"]
```

**Multi-Stage Benefits:**

- **Smaller image size**: Only runtime dependencies included (~200MB vs. 800MB+)
- **Security**: Build tools not in production image
- **Layer caching**: Dependencies layer cached separately
- **Faster deployments**: Smaller pulls from registry

---

## Environment Configuration

### Configuration Hierarchy

```
System Environment (deployment platform)
        ↓
        .env file (mounted or embedded)
        ↓
        Application Startup
```

### Critical Environment Variables

**Database**

```bash
DATABASE_URL=postgresql://user:pass@host:5432/dbname
DATABASE_HOST=postgres-instance.rds.amazonaws.com
DATABASE_PORT=5432
DATABASE_NAME=donebyme_booking
DATABASE_USERNAME=app_user
DATABASE_PASSWORD=<secure-generated>
DATABASE_SSL=true  # For RDS
```

**API Configuration**

```bash
NODE_ENV=production
LOG_LEVEL=info
PORT=8444
JWT_SECRET=<base64-encoded-secret>
JWT_EXPIRY=1h
JWT_REFRESH_EXPIRY=7d
```

**Frontend Configuration**

```bash
NEXT_PUBLIC_API_URL=https://api.donebyme.com
NEXT_PUBLIC_APP_URL=https://donebyme.com
NODE_ENV=production
PORT=3001
```

**Cache & Sessions**

```bash
REDIS_URL=redis://user:pass@redis-host:6379
REDIS_PASSWORD=<secure>
CACHE_TTL=3600
SESSION_SECRET=<base64-encoded-secret>
```

**External Services**

```bash
AWS_ACCESS_KEY_ID=<aws-key>
AWS_SECRET_ACCESS_KEY=<aws-secret>
AWS_REGION=us-east-1
STRIPE_SECRET_KEY=<stripe-secret>
STRIPE_PUBLISHABLE_KEY=<stripe-public>
GOOGLE_OAUTH_CLIENT_ID=<google-id>
GOOGLE_OAUTH_CLIENT_SECRET=<google-secret>
```

**Feature Flags**

```bash
FEATURE_PAYMENTS=true
FEATURE_LOYALTY=true
FEATURE_STAFF_MANAGEMENT=true
FEATURE_MULTI_LOCATION=false
```

### Environment Variable Validation

Always validate environment on startup:

```typescript
// apps/api/src/main.ts
async function bootstrap() {
  const requiredVars = ['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV', 'REDIS_URL'];

  for (const envVar of requiredVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  const app = await NestFactory.create(AppModule);
  // ... rest of bootstrap
}
```

---

## Secrets Management

### Never Commit Secrets

**Forbidden:**

```bash
# ❌ NEVER commit to repo
DATABASE_PASSWORD=superSecretPassword123
JWT_SECRET=actual-jwt-secret-value
STRIPE_SECRET_KEY=sk_live_...
```

### Secret Storage Strategies

#### Local Development

```bash
# .env.local (git-ignored)
DATABASE_PASSWORD=dev_password_only
JWT_SECRET=dev-jwt-secret-change-in-prod
```

#### Staging/Production

**Option 1: AWS Secrets Manager**

```bash
# Store in AWS Secrets Manager
aws secretsmanager create-secret \
  --name donebyme/prod/database-password \
  --secret-string "secure-generated-password"

# Retrieve in container startup
SECRETS=$(aws secretsmanager get-secret-value \
  --secret-id donebyme/prod/database-password \
  --query SecretString --output text)
```

**Option 2: Kubernetes Secrets**

```bash
kubectl create secret generic donebyme-secrets \
  --from-literal=database-password='...' \
  --from-literal=jwt-secret='...'

# Reference in deployment
env:
  - name: DATABASE_PASSWORD
    valueFrom:
      secretKeyRef:
        name: donebyme-secrets
        key: database-password
```

**Option 3: Encrypted .env in Repository**

```bash
# Encrypt using git-crypt or similar
git-crypt init
echo '.env.prod' >> .gitattributes
echo '.env.prod filter=git-crypt diff=git-crypt' >> .gitattributes

# Commit only .env.prod (encrypted)
git add .env.prod
```

### Secret Rotation

**Quarterly Secret Rotation Policy:**

```bash
# 1. Generate new secret
NEW_JWT_SECRET=$(openssl rand -base64 64)

# 2. Update in AWS Secrets Manager
aws secretsmanager update-secret \
  --secret-id donebyme/prod/jwt-secret \
  --secret-string "$NEW_JWT_SECRET"

# 3. Redeploy containers
docker-compose up -d api web

# 4. Log rotation event
# Update security audit trail

# 5. Verify new secret in use
curl -v https://api.donebyme.com/health
```

---

## Docker Compose Local Development

See [code-examples/docker/docker-compose.yml](./code-examples/docker/docker-compose.yml) for full setup.

### Start Services

```bash
# Build images
docker compose build

# Start all services
docker compose up -d

# View logs
docker compose logs -f api web postgres redis

# Stop services
docker compose down

# Clean up volumes (WARNING: deletes data)
docker compose down -v
```

### Network Communication

```
api container (8444)
    ↓
postgres (5432) — via network alias "postgres"
redis (6379)    — via network alias "redis"

web container (3001)
    ↓
api (8444)      — via network alias "api"
```

### Debugging Containers

```bash
# Enter shell
docker compose exec api sh

# View environment
docker compose exec api printenv

# Check connectivity
docker compose exec api ping postgres
docker compose exec api redis-cli -h redis ping

# View database
docker compose exec postgres psql -U donebyme_user -d donebyme_booking -c "\dt"
```

---

## Production Deployment

### Prerequisites

- Docker Engine ≥ 24.x
- AWS RDS PostgreSQL instance (≥15.0)
- AWS ElastiCache Redis (optional, for scaling)
- EC2 instance (4GB+ RAM) or ECS/Fargate
- Security groups configured for inter-service communication

### Deployment Steps

#### 1. Build Images

```bash
# Build API image
docker build -t donebyme-api:v1.0.0 \
  -f Dockerfile.api \
  --build-arg NODE_ENV=production \
  .

# Build Web image
docker build -t donebyme-web:v1.0.0 \
  -f Dockerfile.web \
  --build-arg NODE_ENV=production \
  .

# Push to registry
docker push donebyme-api:v1.0.0
docker push donebyme-web:v1.0.0
```

#### 2. Run Migrations

```bash
# Run before deploying new version
docker run --rm \
  -e DATABASE_URL="postgresql://..." \
  donebyme-api:v1.0.0 \
  node -e "const db = require('./packages/db'); db.migrate();"
```

#### 3. Deploy Containers

```bash
# Pull latest images
docker pull donebyme-api:v1.0.0
docker pull donebyme-web:v1.0.0

# Create docker-compose override for prod
docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d

# Verify health
curl http://localhost:8444/health
curl http://localhost:3001/health
```

#### 4. Post-Deployment Verification

```bash
# Check service status
docker compose ps

# View logs for errors
docker compose logs -f api web

# Monitor resource usage
docker stats donebyme_api donebyme_web donebyme_postgres

# Smoke test critical flows
curl -X POST https://api.donebyme.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"..."}'
```

---

## Health Checks and Logging

### Health Check Endpoints

```typescript
// apps/api/src/health.controller.ts
@Controller('health')
export class HealthController {
  @Get()
  check(): object {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: this.dbService.isConnected,
        redis: this.cacheService.isConnected,
        memory: process.memoryUsage().heapUsedPercent,
      },
    };
  }
}

// apps/web/src/app/api/health/route.ts
export async function GET() {
  return Response.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.NEXT_PUBLIC_APP_VERSION,
  });
}
```

### Container Logging

```bash
# Stream logs from all services
docker compose logs -f

# Follow only API container
docker compose logs -f api

# View last 100 lines
docker compose logs --tail=100 api

# Export logs (structured)
docker logs donebyme_api 2>&1 | jq '.level, .message, .tenant_id'
```

### Centralized Logging Strategy

```typescript
// Structured logging with tenant context
logger.info({
  message: 'User logged in',
  tenant_id: request.tenant.id,
  user_id: request.user.id,
  ip_address: request.ip,
  timestamp: new Date().toISOString(),
});
```

---

## Resource Limits & Memory Management

### Container Resource Allocation

```yaml
# docker-compose.yml
services:
  api:
    mem_limit: 1024m
    cpus: 1.0
    environment:
      - NODE_OPTIONS=--max-old-space-size=768

  web:
    mem_limit: 768m
    cpus: 0.8
    environment:
      - NODE_OPTIONS=--max-old-space-size=512

  postgres:
    mem_limit: 2g
    cpus: 2.0

  redis:
    mem_limit: 512m
    cpus: 0.5
```

### Memory Leak Detection

```bash
# Monitor memory growth over time
docker stats --no-stream --format "table {{.Container}}\t{{.MemUsage}}" donebyme_api

# Generate heap dump if suspicious
docker exec donebyme_api node --inspect-brk=0.0.0.0:9229 apps/api/dist/main.js
```

### Node.js Garbage Collection Tuning

```bash
# Increase GC frequency for high-traffic services
NODE_OPTIONS="--max-old-space-size=1024 --gc-interval=1000"
```

---

## Summary

| Aspect               | Pattern                                                    |
| -------------------- | ---------------------------------------------------------- |
| **Tenant Isolation** | Single app container, tenant_id in all queries             |
| **Build Strategy**   | Multi-stage Docker builds for size/security                |
| **Configuration**    | Environment variables validated on startup                 |
| **Secrets**          | AWS Secrets Manager or encrypted .env                      |
| **Deployment**       | Docker Compose local, managed orchestration (ECS/K8s) prod |
| **Health Checks**    | HTTP endpoints, container healthchecks configured          |
| **Logging**          | Structured logs with tenant_id context                     |
| **Resources**        | Memory limits enforced, monitoring enabled                 |

---

## References

- [Multi-Stage Builds Documentation](https://docs.docker.com/build/building/multi-stage/)
- [Docker Compose Best Practices](https://docs.docker.com/compose/production/)
- [Environment Configuration](#environment-configuration)
- [Secrets Management](#secrets-management)
