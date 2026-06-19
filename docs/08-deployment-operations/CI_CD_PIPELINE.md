# CI/CD Pipeline Guide

Continuous Integration & Continuous Deployment strategies for automated, reliable deployments.

## Table of Contents

1. [CI/CD Architecture](#1-cicd-architecture)
2. [GitHub Actions Setup](#2-github-actions-setup)
3. [Build Pipeline](#3-build-pipeline)
4. [Test Pipeline](#4-test-pipeline)
5. [Deployment Pipeline](#5-deployment-pipeline)
6. [Rollback Procedures](#6-rollback-procedures)
7. [Secrets Management](#7-secrets-management)
8. [Monitoring Deployments](#8-monitoring-deployments)

---

## 1. CI/CD Architecture

### Complete Pipeline Flow

```
Git Push
   │
   ├─► Lint & Format Check
   │       ├─ ESLint
   │       ├─ Prettier
   │       └─ TypeScript
   │
   ├─► Unit Tests
   │       ├─ Jest (API)
   │       ├─ Vitest (Web)
   │       └─ Coverage > 80%
   │
   ├─► Build
   │       ├─ Docker build (API)
   │       ├─ Docker build (Web)
   │       └─ Push to registry
   │
   ├─► Integration Tests
   │       ├─ E2E tests
   │       ├─ Smoke tests
   │       └─ API contract tests
   │
   ├─► Security Scan
   │       ├─ Dependency check
   │       ├─ SAST (code analysis)
   │       └─ Container scan
   │
   ├─► Deploy to Staging
   │       ├─ Update environment
   │       ├─ Run migrations
   │       └─ Health checks
   │
   ├─► Staging Tests
   │       ├─ Smoke tests
   │       ├─ Performance tests
   │       └─ Manual approval
   │
   └─► Deploy to Production
           ├─ Blue-green deployment
           ├─ Canary release (10%)
           ├─ Health monitoring
           └─ Auto-rollback on failure
```

### Pipeline Tools

```
Version Control       ← GitHub / GitLab
    │
CI/CD Orchestrator   ← GitHub Actions / GitLab CI
    │
Build System         ← Docker / Buildpacks
    │
Test Framework       ← Jest / Vitest / Playwright
    │
Registry             ← Docker Hub / ECR / Artifact Registry
    │
Deployment           ← Docker Compose / CloudRun
    │
Monitoring           ← Prometheus / DataDog / CloudWatch
```

---

## 2. GitHub Actions Setup

### Workflow Structure

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main, staging]

env:
  REGISTRY: ghcr.io
  IMAGE_API: ${{ github.repository }}/api
  IMAGE_WEB: ${{ github.repository }}/web

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm run lint
      - run: pnpm run type-check

  test:
    runs-on: ubuntu-latest
    needs: lint
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test_db
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: DATABASE_URL=postgresql://postgres:test@localhost/test_db pnpm run test
      - uses: codecov/codecov-action@v4

  build:
    runs-on: ubuntu-latest
    needs: test
    if: github.event_name == 'push'
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile.api
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_API }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile.web
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_WEB }}:latest
          build-args: |
            NEXT_PUBLIC_API_URL=${{ secrets.NEXT_PUBLIC_API_URL }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy-staging:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/staging'
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging
        run: |
          ssh -i ${{ secrets.SSH_KEY }} \
            -o StrictHostKeyChecking=no \
            ${{ secrets.DEPLOY_USER }}@${{ secrets.STAGING_HOST }} << 'EOF'
            cd /app
            docker compose pull
            docker compose up -d
            docker compose exec -T api pnpm --filter @app/db db:migrate
          EOF

  deploy-production:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        run: |
          ssh -i ${{ secrets.SSH_KEY }} \
            -o StrictHostKeyChecking=no \
            ${{ secrets.DEPLOY_USER }}@${{ secrets.PROD_HOST }} << 'EOF'
            cd /app

            # Blue-green deployment
            docker compose -f docker-compose.prod.yml pull
            docker compose -f docker-compose.prod.yml up -d --no-deps api web

            # Wait for health
            sleep 20

            # Run migrations
            docker compose -f docker-compose.prod.yml exec -T api \
              pnpm --filter @app/db db:migrate

            # Health check
            curl -f http://localhost:8444/health || exit 1
          EOF

      - name: Verify deployment
        run: |
          curl -f https://yourdomain.com/api/health
          curl -f https://yourdomain.com
```

---

## 3. Build Pipeline

### Docker Layer Caching

```dockerfile
# Dockerfile.api (optimized)
FROM node:22-alpine AS builder

WORKDIR /build

# Copy dependency manifests first (cache layer)
COPY package.json pnpm-lock.yaml ./

# Install dependencies (cached if lock file unchanged)
RUN npm install -g pnpm && \
    pnpm install --frozen-lockfile

# Copy source code (changes frequently)
COPY . .

# Build application
RUN pnpm run build

# Runtime stage
FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && \
    pnpm install --prod --frozen-lockfile

COPY --from=builder /build/dist ./dist

USER node
EXPOSE 8444

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8444/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

CMD ["node", "dist/main.js"]
```

### Build Optimization

```yaml
# .github/workflows/build-optimized.yml
- name: Build with cache
  uses: docker/build-push-action@v5
  with:
    cache-from: type=gha # Use GitHub Actions cache
    cache-to: type=gha,mode=max
    # Significant speedup: 5 minutes → 1 minute on subsequent builds
```

### Image Size Optimization

```bash
# Monitor image sizes
docker image ls | grep myapp

# Reduce size
# ✓ Use Alpine base (40MB vs 900MB for standard Node)
# ✓ Multi-stage build (drop build tools from runtime)
# ✓ Remove unnecessary dependencies
# ✓ Use npm ci instead of npm install
# ✓ Disable npm/yarn caches

Result: API image ~200MB → ~85MB
```

---

## 4. Test Pipeline

### Test Strategy

```yaml
# Test pyramid
        ▲
       ╱ ╲          E2E (10 tests)
      ╱───╲
     ╱     ╲        Integration (50 tests)
    ╱───────╲
   ╱         ╲      Unit (500 tests)
  ╱───────────╲

Time: <1min  5min   15min  (goal: < 5min for PR feedback)
```

### Parallel Test Execution

```yaml
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package: [api, web, db]
    steps:
      - run: pnpm --filter @app/${{ matrix.package }} test --coverage

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test_db
    steps:
      - run: pnpm run test:integration

  e2e-tests:
    runs-on: ubuntu-latest
    needs: integration-tests
    steps:
      - run: pnpm run test:e2e
```

### Code Coverage Requirements

```yaml
- name: Upload coverage
  uses: codecov/codecov-action@v4
  with:
    file: ./coverage/coverage-final.json
    flags: unittests
    fail_ci_if_error: false

- name: Comment PR with coverage
  if: github.event_name == 'pull_request'
  uses: romeovs/lcov-reporter-action@v0.3.1
  with:
    lcov-file: ./coverage/lcov.info
```

---

## 5. Deployment Pipeline

### Staging Deployment

```bash
# Triggered on push to staging branch
1. Run all tests
2. Build Docker images
3. Push to registry
4. SSH to staging server
5. Pull images
6. Restart containers
7. Run database migrations
8. Health checks

Downtime: ~2 minutes
Rollback: git revert && git push
```

### Production Deployment (Blue-Green)

```bash
# Triggered on merge to main branch
# Manual approval required

1. Run full test suite
2. Build Docker images
3. Push to registry

4. BLUE (current version running)
   └─ All production traffic

5. Deploy GREEN (new version)
   ├─ Pull new images
   ├─ Start on different port (8445)
   ├─ Run migrations
   ├─ Health checks
   └─ Warming (load cache)

6. Switch router
   ├─ Update load balancer
   ├─ Route 100% traffic to GREEN
   └─ Monitor error rate

7. Keep BLUE running
   ├─ If errors detected
   ├─ Switch back to BLUE
   └─ Manual investigation

8. After 1 hour (stable)
   ├─ Tear down BLUE
   └─ Deployment complete

Downtime: 0 seconds (zero-downtime deployment)
Rollback: 30 seconds (switch back to BLUE)
```

### Canary Deployment (Safe Alternative)

```bash
# Route percentage of traffic to new version
1. Deploy new version (GREEN) → 10% traffic
2. Monitor metrics for 5 minutes
   - Error rate < 0.1%
   - Latency p99 < 1000ms
3. If good: 50% → 100%
4. If bad: Rollback to 0% → 100% to BLUE
```

---

## 6. Rollback Procedures

### Automatic Rollback

```yaml
- name: Monitor deployment
  run: |
    for i in {1..300}; do
      ERROR_RATE=$(curl http://localhost:8444/metrics | grep 'http_requests_total{status="5' | awk '{print $2}')
      if (( $(echo "$ERROR_RATE > 0.01" | bc -l) )); then
        echo "Error rate too high: $ERROR_RATE"
        docker compose -f docker-compose.prod.yml up -d api  # Rollback
        exit 1
      fi
      sleep 1
    done
```

### Manual Rollback

```bash
# Identify good commit
git log --oneline | head -10

# Revert deployment
git revert <bad-commit-hash>
git push origin main

# CI/CD automatically redeploys
# Deployment status: https://github.com/repo/actions
```

### Database Rollback

```bash
# If migration caused issues
docker exec api pnpm --filter @app/db db:rollback

# Or restore from backup
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier app-db \
  --target-db-instance-identifier app-db-recovered \
  --restore-time 2024-05-15T14:30:00Z
```

---

## 7. Secrets Management

### GitHub Secrets

```yaml
# .github/workflows/deploy.yml
- name: Deploy
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
  run: |
    # Secrets available as environment variables
    # Not printed in logs
```

### Create Repository Secrets

```bash
# Via GitHub CLI
gh secret set DATABASE_URL --body "postgresql://..."
gh secret set JWT_SECRET --body "..."

# Via GitHub UI
Settings → Secrets and variables → Actions → New repository secret
```

### Secret Rotation

```bash
# Update secret
gh secret set JWT_SECRET --body "new-secret"

# Redeploy to activate
git commit --allow-empty -m "Rotate secrets"
git push
```

---

## 8. Monitoring Deployments

### Deployment Dashboard

```
Recent Deployments:
├─ main → prod (v1.2.3) ✓ Deployed 2 hours ago
│  ├─ Tests: ✓ 1523 passed
│  ├─ Build: ✓ 3 minutes
│  ├─ Deploy: ✓ 2 minutes
│  ├─ Health: ✓ All green
│  └─ Errors: 0.01% (normal)
│
└─ staging → staging (v1.2.2) ✓ Deployed 15 minutes ago
   ├─ Tests: ✓ 1520 passed
   ├─ Build: ✓ 2 minutes
   └─ Deploy: ✓ 1 minute
```

### Post-Deployment Checks

```bash
# Automated health checks
1. Endpoint availability (all 200)
2. Database connectivity (query successful)
3. Cache connectivity (Redis ping)
4. External services (Stripe, Google Maps)
5. Error rate < 0.1%
6. Response time p99 < 1000ms

Failure → Automatic rollback
```

### Deployment Notifications

```yaml
- name: Notify Slack on deployment
  if: always()
  uses: slackapi/slack-github-action@v1.24.0
  with:
    payload: |
      {
        "text": "Deployment: ${{ job.status }}",
        "blocks": [
          {
            "type": "section",
            "text": {
              "type": "mrkdwn",
              "text": "*Deployment to Production*\n${{ job.status }}\nVersion: ${{ github.sha }}\nCommit: ${{ github.event.head_commit.message }}"
            }
          }
        ]
      }
```

---

## CI/CD Checklist

- [ ] GitHub Actions workflows configured
- [ ] Lint checks passing
- [ ] Unit tests > 80% coverage
- [ ] Integration tests passing
- [ ] Docker builds optimized
- [ ] Image registry configured
- [ ] Secrets securely managed
- [ ] Staging deployment automated
- [ ] Production deployment blue-green ready
- [ ] Rollback procedures tested
- [ ] Health checks configured
- [ ] Monitoring and alerting in place
- [ ] Deployment notifications setup
- [ ] Team trained on deployment process

---

**Last Updated:** May 2026
**Status:** Production Ready
