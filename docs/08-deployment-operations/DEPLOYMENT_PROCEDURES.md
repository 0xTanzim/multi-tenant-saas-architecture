# Production Deployment Procedures

**Deployment Target:** AWS EC2 (4GB RAM minimum) + AWS RDS PostgreSQL (t3.small or larger)

## Architecture

```
                    ┌──────────────────────────────────────────┐
                    │      EC2 Instance (4GB minimum)           │
                    │                                          │
   Internet ──────►│  ┌────────┐    ┌─────┐    ┌───────┐     │
                    │  │ Nginx  │───►│ API │───►│ Redis │     │
                    │  │  :80   │    │:8444│    │ :6379 │     │
                    │  │ :443   │    └──┬──┘    └───────┘     │
                    │  │(SSL)   │───►┌──┴──┐                   │
                    │  └────────┘    │ Web │                   │
                    │                │:3001│                   │
                    │                └─────┘                   │
                    └────────────┬─────────────────────────────┘
                                 │ VPC Internal
                                 ▼
                          ┌─────────────┐
                          │  AWS RDS    │
                          │ PostgreSQL  │
                          │  (managed)  │
                          └─────────────┘
```

### Memory Budget (4GB EC2)

| Service       | Allocation | Reserved   | Purpose           |
| ------------- | ---------- | ---------- | ----------------- |
| API (NestJS)  | 1024M      | 512M       | Backend + V8 heap |
| Web (Next.js) | 768M       | 256M       | SSR + V8 heap     |
| Redis         | 384M       | 128M       | Cache + sessions  |
| Nginx         | 128M       | 64M        | Reverse proxy     |
| **Total**     | **~2.3GB** | **~1.7GB** | OS + buffer       |

---

## Prerequisites

- Docker Engine ≥ 24.x + Docker Compose V2
- AWS RDS PostgreSQL instance (externally provisioned and accessible)
- Security groups configured:
  - EC2 → RDS on port 5432
  - Internet → EC2 on ports 80, 443, 22 (SSH)
- Domain name with DNS configured (A records pointing to EC2 IP)
- SSL certificate (from Let's Encrypt or AWS ACM)

---

## Quick Start (5 Steps)

### 1. Clone Repository and Navigate

```bash
git clone <your-repo-url> /opt/app
cd /opt/app
```

### 2. Configure Environment

```bash
# Copy template
cp .env.example .env

# Edit with production values
nano .env
```

**Critical variables to set:**

- `DATABASE_URL` — Your RDS PostgreSQL connection string
- `JWT_SECRET` — Generate: `openssl rand -base64 64`
- `REDIS_PASSWORD` — Strong random password
- `FRONTEND_URL` — Your domain (https://yourdomain.com)
- `CORS_ORIGINS` — Allowed origins (your domain)
- AWS credentials (S3, SES, if used)
- Third-party keys (Stripe, Google OAuth, Firebase, etc.)

### 3. Build Docker Images

```bash
# Build all images (no cache)
docker compose -f docker-compose.prod.yml build

# Alternatively, use deployment script if available
./scripts/deploy-prod.sh build
```

### 4. Start Services

```bash
# Start all services (detached)
docker compose -f docker-compose.prod.yml up -d

# Verify all are healthy
docker compose -f docker-compose.prod.yml ps
```

### 5. Run Database Migrations

```bash
# From inside API container
docker exec -it api_container_name pnpm --filter @app/db db:migrate

# Or from local machine with DATABASE_URL set
DATABASE_URL="your-connection-string" pnpm --filter @app/db db:migrate
```

---

## Deployment Script Commands

If `./scripts/deploy-prod.sh` is available:

```bash
./scripts/deploy-prod.sh build           # Build all images (no cache)
./scripts/deploy-prod.sh up              # Start services (detached)
./scripts/deploy-prod.sh down            # Stop all services
./scripts/deploy-prod.sh restart [svc]   # Restart all or specific service
./scripts/deploy-prod.sh logs [svc]      # Tail logs
./scripts/deploy-prod.sh status          # Health + memory usage
./scripts/deploy-prod.sh update          # git pull → rebuild → restart
```

---

## Docker Images

| Image | Dockerfile          | Base           | Purpose          |
| ----- | ------------------- | -------------- | ---------------- |
| API   | `Dockerfile.api`    | node:22-alpine | NestJS backend   |
| Web   | `Dockerfile.web`    | node:22-alpine | Next.js frontend |
| Redis | `redis:8.2-alpine`  | Alpine Linux   | In-memory cache  |
| Nginx | `nginx:1.27-alpine` | Alpine Linux   | Reverse proxy    |

All images use minimal Alpine base for security and size.

---

## Service Networking

All services communicate on internal `app_network` bridge. Only Nginx exposes port 80/443 to host.

| Route             | Destination | Purpose                    |
| ----------------- | ----------- | -------------------------- |
| `/api/*`          | API (:8444) | Backend API calls          |
| `/health`         | API         | Health check endpoint      |
| `/socket.io/*`    | API         | WebSocket connections      |
| `/_next/static/*` | Web         | Static assets (cached 1yr) |
| `/_next/image`    | Web         | Image optimization         |
| `/sw.js`          | Web         | Service worker             |
| `/*`              | Web         | Catch-all frontend routes  |

---

## SSL/HTTPS Setup

### Option A: Let's Encrypt with Certbot (Recommended for simple setups)

```bash
# Install certbot on EC2
sudo apt install certbot    # Ubuntu/Debian
# or
sudo dnf install certbot    # Amazon Linux

# Stop nginx temporarily
docker compose -f docker-compose.prod.yml stop nginx

# Get certificate
sudo certbot certonly --standalone -d yourdomain.com -d www.yourdomain.com

# Certificate files created:
# /etc/letsencrypt/live/yourdomain.com/fullchain.pem
# /etc/letsencrypt/live/yourdomain.com/privkey.pem

# Copy to nginx directory
mkdir -p nginx/certs
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem nginx/certs/
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem nginx/certs/
sudo chown app_user:app_user nginx/certs/*
```

Update `nginx/default.conf` to add HTTPS block:

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Redirect HTTP to HTTPS
    error_page 497 https://$server_name$request_uri;

    # ... location blocks (same as port 80) ...
}
```

Update `docker-compose.prod.yml` to expose 443 and mount certs:

```yaml
nginx:
  ports:
    - '80:80'
    - '443:443'
  volumes:
    - ./nginx/certs:/etc/nginx/certs:ro
```

Restart nginx:

```bash
docker compose -f docker-compose.prod.yml up -d nginx
```

### Option B: AWS Application Load Balancer (Recommended for high-availability)

- Place ALB in front of EC2 with ACM certificate
- ALB terminates SSL and forwards HTTP to EC2:80
- Better for auto-scaling and zero-downtime deployments
- See AWS documentation for ALB setup

---

## Monitoring & Troubleshooting

### Health Checks

```bash
# All services
docker compose -f docker-compose.prod.yml ps

# API health
curl http://localhost:8444/health
# Expected: {"status":"ok"}

# Web health
curl -I http://localhost:3001
# Expected: HTTP/1.1 200 or 307

# Redis health
docker exec redis_container redis-cli -a <password> ping
# Expected: PONG

# Nginx health
curl http://localhost/nginx-health
# Expected: "OK" or similar
```

### View Logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f redis
docker compose -f docker-compose.prod.yml logs -f nginx
```

### Common Issues & Fixes

| Symptom                    | Root Cause                                         | Fix                                                                                |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| API returns 502            | API container crashed                              | Check logs: `docker logs api_container`. Restart: `docker compose restart api`     |
| Web shows 502              | Backend unreachable                                | Verify `BACKEND_URL=http://api:8444` in web env. Check API health.                 |
| Redis connection refused   | Redis password wrong or not set                    | Verify `REDIS_PASSWORD` matches in .env                                            |
| Database connection failed | RDS endpoint wrong or security group misconfigured | Check `DATABASE_URL`. Verify EC2 security group allows RDS access.                 |
| Memory errors              | Container memory limit exceeded                    | Check: `./scripts/deploy-prod.sh status`. Increase memory limit if needed.         |
| Build fails                | Missing dependencies or Docker image corrupted     | Clear cache: `docker builder prune -f`. Rebuild: `docker compose build --no-cache` |

---

## Updates & Deployments

### Standard Update Flow

```bash
# Pull latest code
git pull --ff-only

# Rebuild images
docker compose -f docker-compose.prod.yml build

# Update services
docker compose -f docker-compose.prod.yml up -d

# Run migrations if needed
docker exec api_container pnpm --filter @app/db db:migrate
```

### Zero-Downtime Deployment (Single Service)

```bash
# Update and recreate one service without affecting others
docker compose -f docker-compose.prod.yml up -d --no-deps api

# Verify health
sleep 10
curl http://localhost:8444/health
```

### Rollback Procedure

```bash
# If deployment fails, rollback to previous image tag
git checkout <previous-commit>
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker exec api_container pnpm --filter @app/db db:migrate
```

---

## Database Migrations

### Running Migrations

```bash
# Run pending migrations
docker exec api_container pnpm --filter @app/db db:migrate

# Or from local machine
DATABASE_URL="your-connection-string" pnpm --filter @app/db db:migrate
```

### Verifying Migrations

```bash
# Check database schema
docker exec postgres_container psql -U postgres -d app_db -c "\dt"

# Check migration history
docker exec api_container pnpm --filter @app/db db:status
```

### Emergency Rollback

```bash
# Only if migration caused critical issue
docker exec api_container pnpm --filter @app/db db:rollback

# Verify
docker exec postgres_container psql -U postgres -d app_db -c "\dt"
```

---

## Performance Optimization

### Memory Management

Monitor memory usage:

```bash
docker stats
```

If hitting limits:

1. Increase EC2 instance size
2. Reduce service memory allocations
3. Enable Redis eviction policies
4. Optimize API response caching

### Database Query Optimization

```bash
# Monitor slow queries
docker exec postgres_container psql -U postgres -d app_db -c "
  SELECT query, mean_time, calls FROM pg_stat_statements
  ORDER BY mean_time DESC LIMIT 10;
"
```

### Caching Strategy

- Use Redis for session storage
- Cache API responses (configurable TTL)
- Cache static assets (1 year via Nginx)
- Use database query result caching for read-heavy operations

---

## Backup & Recovery

### PostgreSQL RDS Automatic Backups

AWS RDS handles automated daily backups:

- Retention: 7 days (configurable)
- Point-in-time recovery: available
- Manual snapshots: can create anytime

Create manual snapshot before major deployments:

```bash
# Via AWS CLI
aws rds create-db-snapshot \
  --db-instance-identifier your-db-instance \
  --db-snapshot-identifier your-db-instance-backup-$(date +%Y%m%d-%H%M%S)
```

### Redis Data Backup

Redis runs with AOF (Append-Only File) persistence:

```bash
# Backup Redis data
docker exec redis_container redis-cli -a <password> BGSAVE
docker cp redis_container:/data/dump.rdb ./backups/redis-$(date +%Y%m%d-%H%M%S).rdb

# Restore Redis data
docker cp ./backups/redis-latest.rdb redis_container:/data/dump.rdb
docker compose restart redis
```

### Application Code Backup

Maintain backup of application code:

```bash
git tag release-$(date +%Y%m%d-%H%M%S)
git push origin release-*
```

---

## Security Checklist

- [ ] `.env` file contains all production secrets (never commit to git)
- [ ] JWT_SECRET is strong (64+ byte base64)
- [ ] Database password is strong (16+ characters, mixed case/numbers/symbols)
- [ ] Redis password is set and strong
- [ ] Security groups restrict access (no 0.0.0.0/0 on database)
- [ ] SSL/HTTPS configured and working
- [ ] CORS_ORIGINS restricted to known domains only
- [ ] Sensitive API keys (Stripe, Google, Firebase) verified
- [ ] Docker images scanned for vulnerabilities (optional: trivy scan)
- [ ] SSH key secured (chmod 600, not in repo)
- [ ] Regular backups verified and tested

---

## Scaling Considerations

See `KUBERNETES_SCALING_GUIDE.md` for:

- Horizontal scaling strategies
- Load balancing
- Database connection pooling
- Redis clustering

For AWS, consider:

- Auto Scaling Groups for EC2
- AWS Elastic Load Balancing
- AWS RDS read replicas for scaling reads
- AWS ElastiCache for distributed Redis

---

## Next Steps

1. Read [ENVIRONMENT_CONFIGURATION.md](ENVIRONMENT_CONFIGURATION.md) for detailed env setup
2. Read [DOCKER_REFERENCE_GUIDE.md](DOCKER_REFERENCE_GUIDE.md) for Docker specifics
3. Read [MONITORING_LOGGING_GUIDE.md](MONITORING_LOGGING_GUIDE.md) for observability
4. Read [BACKUP_DISASTER_RECOVERY.md](BACKUP_DISASTER_RECOVERY.md) for disaster planning
5. Read [CI_CD_PIPELINE.md](CI_CD_PIPELINE.md) for automated deployments

---

**Last Updated:** May 2026
**Status:** Production Ready
