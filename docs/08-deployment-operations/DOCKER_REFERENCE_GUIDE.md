# Docker Reference Guide

Complete reference for Docker commands, Dockerfile patterns, and production deployment with Docker Compose.

## Table of Contents

1. [Deployment Readiness Scorecard](#1-deployment-readiness-scorecard)
2. [Production Architecture](#2-production-architecture)
3. [Docker Images Inventory](#3-docker-images-inventory)
4. [Docker Compose Configuration](#4-docker-compose-configuration)
5. [Common Docker Commands](#5-common-docker-commands)
6. [Dockerfile Best Practices](#6-dockerfile-best-practices)
7. [Environment Variables with Docker](#7-environment-variables-with-docker)
8. [Health Checks](#8-health-checks)
9. [Resource Limits](#9-resource-limits)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Deployment Readiness Scorecard

Use this checklist to verify your Docker setup is production-ready:

| Component               | Status     | Notes                                      |
| ----------------------- | ---------- | ------------------------------------------ |
| Dockerfile (API)        | ✓ REQUIRED | Multi-stage build, Alpine base             |
| Dockerfile (Web)        | ✓ REQUIRED | Standalone Next.js, optimized              |
| docker-compose.prod.yml | ✓ REQUIRED | All services configured                    |
| nginx config            | ✓ REQUIRED | Reverse proxy, security headers, WebSocket |
| Redis persistence       | ✓ REQUIRED | AOF enabled, memory limits set             |
| Health checks           | ✓ REQUIRED | All services have health check endpoints   |
| Resource limits         | ✓ REQUIRED | Memory + CPU limits set per service        |
| Log rotation            | ✓ REQUIRED | json-file driver with max-size             |
| SSL/HTTPS               | ○ OPTIONAL | Can use Let's Encrypt or ALB               |
| Networking              | ✓ REQUIRED | Only Nginx exposes ports externally        |

**Overall:** ~80% ready after Dockerfile completion. Remaining 20% is configuration tuning.

---

## 2. Production Architecture

```
                        Internet
                           │
                    ┌──────┴──────┐
                    │   EC2 (4GB) │
                    │             │
  ┌─────────────────┼─────────────┼─────────────────┐
  │ docker-compose  │             │                  │
  │                 │             │                  │
  │         ┌───────▼────────┐    │                  │
  │         │     Nginx      │:80 │ :443 (optional)  │
  │         │   (reverse     │    │ (SSL termination)│
  │         │    proxy)      │    │                  │
  │         └───┬────────┬───┘    │                  │
  │    /api/*   │        │  /*    │                  │
  │   ┌─────────▼──┐  ┌──▼──────┐ │                  │
  │   │  API       │  │   Web   │ │                  │
  │   │  NestJS    │  │ Next.js │ │                  │
  │   │  :8444     │  │  :3001  │ │                  │
  │   └──────┬─────┘  └─────────┘ │                  │
  │          │                     │                  │
  │   ┌──────▼──────┐              │                  │
  │   │   Redis     │              │                  │
  │   │   :6379     │              │                  │
  │   └─────────────┘              │                  │
  └──────────────────────────────┬──┘                  │
           │                     │                    │
      ┌────▼─────────────────────▼──┐                │
      │   AWS RDS PostgreSQL        │                │
      │   (external, managed)       │                │
      │   Port 5432 (VPC internal)  │                │
      └─────────────────────────────┘                │
```

**Memory Budget (4GB EC2):**

| Service       | Allocation | Reserved | Total      |
| ------------- | ---------- | -------- | ---------- |
| API (NestJS)  | 1024M      | 512M     | 1536M      |
| Web (Next.js) | 768M       | 256M     | 1024M      |
| Redis         | 384M       | 128M     | 512M       |
| Nginx         | 128M       | —        | 128M       |
| **Subtotal**  | **2304M**  | **896M** | **~2.3GB** |
| OS overhead   | —          | —        | ~500M      |
| **TOTAL**     | —          | —        | **~2.8GB** |

**All services fit comfortably in 4GB with ~1.2GB buffer.**

---

## 3. Docker Images Inventory

| Image | Source        | Base                | Size   | Use Case         |
| ----- | ------------- | ------------------- | ------ | ---------------- |
| API   | Build locally | `node:22-alpine`    | ~200MB | NestJS backend   |
| Web   | Build locally | `node:22-alpine`    | ~150MB | Next.js frontend |
| Redis | Docker Hub    | `redis:8.2-alpine`  | ~40MB  | In-memory cache  |
| Nginx | Docker Hub    | `nginx:1.27-alpine` | ~45MB  | Reverse proxy    |

**PostgreSQL is NOT in Docker** — it runs on AWS RDS (external service).

### Image Tags & Versioning

Production image tagging:

```bash
# Build with semantic version
docker build -t myapp-api:1.2.3 -f Dockerfile.api .
docker build -t myapp-web:1.2.3 -f Dockerfile.web .

# Also tag as latest
docker tag myapp-api:1.2.3 myapp-api:latest
docker tag myapp-web:1.2.3 myapp-web:latest

# Push to registry
docker push myapp-api:1.2.3
docker push myapp-web:1.2.3
```

---

## 4. Docker Compose Configuration

### docker-compose.prod.yml Structure

```yaml
version: '3.8'

services:
  nginx:
    image: nginx:1.27-alpine
    ports:
      - '80:80'
      - '443:443' # Uncomment for HTTPS
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./nginx/certs:/etc/nginx/certs:ro # For SSL certs
    depends_on:
      api:
        condition: service_healthy
      web:
        condition: service_healthy
    networks:
      - app_network
    restart: unless-stopped
    healthcheck:
      test:
        [
          'CMD',
          'wget',
          '--quiet',
          '--tries=1',
          '--spider',
          'http://localhost/nginx-health',
        ]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    env_file:
      - ./.env
    ports:
      - '8444:8444'
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - ./logs:/app/logs
    networks:
      - app_network
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:8444/health']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
    deploy:
      resources:
        limits:
          memory: 1024M
          cpus: '1'
        reservations:
          memory: 512M

  web:
    build:
      context: .
      dockerfile: Dockerfile.web
      args:
        - NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-http://localhost/api}
    env_file:
      - ./.env
    ports:
      - '3001:3001'
    depends_on:
      - api
    networks:
      - app_network
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:3001']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
    deploy:
      resources:
        limits:
          memory: 768M
          cpus: '0.5'
        reservations:
          memory: 256M

  redis:
    image: redis:8.2-alpine
    command: >
      redis-server
        --appendonly yes
        --requirepass ${REDIS_PASSWORD}
        --maxmemory 256mb
        --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    networks:
      - app_network
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'redis-cli', '-a', '${REDIS_PASSWORD}', 'ping']
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 384M
        reservations:
          memory: 128M

networks:
  app_network:
    driver: bridge

volumes:
  redis_data:
    driver: local
```

### Environment Variables in Compose

**Two methods to pass env vars to containers:**

```yaml
# Method 1: Load from .env file (Recommended)
services:
  api:
    env_file:
      - ./.env

# Method 2: Build-time arguments (for Next.js NEXT_PUBLIC_* vars)
services:
  web:
    build:
      args:
        - NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
```

**Important distinction:**

- **Runtime env vars** (`env_file`): Available inside container at runtime
- **Build-time args** (`build.args`): Baked into image at build time (cannot change after build)

---

## 5. Common Docker Commands

### Building Images

```bash
# Build single image
docker build -t myapp-api:latest -f Dockerfile.api .

# Build all images in docker-compose
docker compose -f docker-compose.prod.yml build

# Build without cache (force fresh build)
docker compose build --no-cache

# Build specific service
docker compose build web

# Build with build args
docker build --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t myapp-web .
```

### Managing Containers

```bash
# Start services
docker compose -f docker-compose.prod.yml up -d

# Stop services
docker compose -f docker-compose.prod.yml down

# Restart services
docker compose restart

# Restart specific service
docker compose restart api

# View running containers
docker compose ps

# View service logs
docker compose logs -f api
docker compose logs -f --tail=100 web

# Execute command in running container
docker compose exec api npm run migrate
```

### Debugging

```bash
# Inspect container
docker inspect <container_id>

# View environment inside container
docker exec <container_id> env | grep DATABASE

# Test connectivity between services
docker exec api_container ping redis

# Check network
docker network ls
docker network inspect app_network

# View volume
docker volume ls
docker volume inspect redis_data
```

### Cleanup

```bash
# Remove unused images
docker image prune -f

# Remove unused volumes
docker volume prune -f

# Remove build cache
docker builder prune -f

# Full cleanup (WARNING: removes all unused Docker objects)
docker system prune -a --volumes -f
```

---

## 6. Dockerfile Best Practices

### Multi-Stage Build Pattern (API/Backend)

```dockerfile
# Stage 1: Builder
FROM node:22-alpine AS builder

WORKDIR /build

# Copy dependency manifests
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build application
RUN pnpm run build

# Stage 2: Runtime
FROM node:22-alpine

WORKDIR /app

# Install production only
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --prod --frozen-lockfile

# Copy built application from builder
COPY --from=builder /build/dist ./dist

# Non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

EXPOSE 8444

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8444/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

CMD ["node", "dist/main.js"]
```

### Key Best Practices

1. **Use Alpine base images** — smaller, more secure
2. **Multi-stage builds** — separate build and runtime
3. **Minimize layer count** — fewer RUN commands
4. **Use .dockerignore** — exclude unnecessary files
5. **Run as non-root user** — better security
6. **Health checks** — allow orchestration to manage health
7. **Specific base image versions** — not `latest`

---

## 7. Environment Variables with Docker

### How Docker Loads Environment Variables

```yaml
# Priority order (lowest to highest):
# 1. Docker default values
# 2. Dockerfile ENV statements
# 3. docker-compose.yml env_file
# 4. docker-compose.yml environment section
# 5. .env file in current directory
# 6. Host OS environment variables
```

### Example: Complete Env Configuration

```yaml
services:
  api:
    # 1. Load from file (recommended)
    env_file:
      - ./.env

    # 2. Override specific values
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=${LOG_LEVEL:-info}

    # 3. Reference host env vars
    environment:
      - DATABASE_PASSWORD=${DB_PASSWORD}
```

### Build-Time vs Runtime Variables

```yaml
# Next.js example (build-time only)
services:
  web:
    build:
      context: .
      dockerfile: Dockerfile.web
      args:
        # These are baked into the image
        - NEXT_PUBLIC_API_URL=https://api.example.com
        - NEXT_PUBLIC_GOOGLE_MAPS_KEY=${GOOGLE_MAPS_KEY}

    # These are for runtime
    env_file:
      - ./.env
```

---

## 8. Health Checks

### Health Check Endpoints

Every service must expose a health endpoint:

```bash
# API health
GET /health
Response: {"status":"ok","timestamp":"2024-05-01T10:00:00Z"}

# Nginx health
GET /nginx-health
Response: OK

# Redis health
redis-cli ping
Response: PONG

# Web health
GET http://localhost:3001
Response: HTTP 200 (or redirect)
```

### Docker Healthcheck Configuration

```yaml
services:
  api:
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:8444/health']
      interval: 30s # Check every 30 seconds
      timeout: 10s # Timeout after 10 seconds
      retries: 3 # Mark unhealthy after 3 failures
      start_period: 30s # Grace period on startup
```

### Checking Health Status

```bash
# View health status
docker compose ps

# Manually test
curl http://localhost:8444/health
docker compose exec redis redis-cli ping
docker compose exec nginx wget -q -O- http://localhost/nginx-health
```

---

## 9. Resource Limits

### Memory Limits Configuration

```yaml
deploy:
  resources:
    limits:
      memory: 1024M # Hard limit (container killed if exceeded)
      cpus: '1' # CPU cores (1 = 1 vCPU)
    reservations:
      memory: 512M # Minimum guaranteed memory
      cpus: '0.5'
```

### Monitoring Resource Usage

```bash
# Real-time resource stats
docker stats

# Historical resource usage (if monitoring enabled)
docker container stats <container_id>

# Check container resource limits
docker inspect <container_id> | grep -A 10 "MemoryLimit"
```

### Setting Limits per Service

```yaml
services:
  api:
    deploy:
      resources:
        limits:
          memory: 1024M
        reservations:
          memory: 512M

  web:
    deploy:
      resources:
        limits:
          memory: 768M
        reservations:
          memory: 256M

  redis:
    deploy:
      resources:
        limits:
          memory: 384M
        reservations:
          memory: 128M
```

---

## 10. Troubleshooting

### Issue: Container exits immediately

**Diagnosis:**

```bash
# Check logs
docker logs <container_id>

# Check exit code
docker inspect <container_id> | grep ExitCode
```

**Fix:**

- Verify database connectivity (check DATABASE_URL)
- Check for missing environment variables
- Verify required services are healthy

### Issue: Health check failing

**Diagnosis:**

```bash
# Test endpoint manually
curl http://localhost:8444/health

# Check container logs
docker logs api_container | tail -50
```

**Fix:**

- Increase health check timeout if slow
- Verify service is actually responding
- Check firewall/network configuration

### Issue: Out of memory

**Diagnosis:**

```bash
docker stats
```

**Fix:**

- Increase memory limit in docker-compose
- Reduce number of concurrent requests
- Enable memory monitoring and caching

### Issue: High CPU usage

**Diagnosis:**

```bash
docker stats
```

**Fix:**

- Profile application (use `--inspect` flag)
- Check for infinite loops or busy-wait
- Optimize database queries

### Issue: Container won't start after env change

**Diagnosis:**

```bash
# Check if image exists
docker images | grep myapp

# Check compose config
docker compose config
```

**Fix:**

```bash
# Rebuild image if NEXT_PUBLIC_* vars changed
docker compose build --no-cache web

# Or restart after env changes
docker compose down
docker compose up -d
```

---

## Quick Reference: Common Scenarios

### Deploy new version

```bash
git pull
docker compose build
docker compose up -d --force-recreate
```

### Fix memory issue

```bash
# Check current usage
docker stats

# Update memory limit in docker-compose.prod.yml
# Rebuild and restart
docker compose up -d --force-recreate
```

### Tail logs from specific service

```bash
docker compose logs -f api --tail=50
```

### Access container shell

```bash
docker compose exec api sh
```

### Backup Redis data

```bash
docker exec redis_container redis-cli -a password BGSAVE
docker cp redis_container:/data/dump.rdb ./redis-backup.rdb
```

---

**Last Updated:** May 2026
**Status:** Production Ready
