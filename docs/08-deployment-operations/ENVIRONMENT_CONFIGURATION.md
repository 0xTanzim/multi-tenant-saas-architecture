# Environment Configuration Guide

Complete reference for configuring your application across development, staging, and production environments.

## Table of Contents

1. [Environment Files Strategy](#1-environment-files-strategy)
2. [Complete Environment Variable Reference](#2-complete-environment-variable-reference)
3. [Database Configuration](#3-database-configuration)
4. [Redis Configuration](#4-redis-configuration)
5. [Production Security Checklist](#5-production-security-checklist)
6. [Common Configuration Patterns](#6-common-configuration-patterns)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Environment Files Strategy

### Single Source of Truth

This architecture uses **one primary `.env` file** as the canonical source of truth:

```
project-root/
├── .env                                    ← PRIMARY source of truth
├── .env.example                            ← Template (commit to repo)
└── apps/
    ├── api/
    │   └── .env.production                 ← Optional compatibility stubs
    └── web/
        └── .env.production                 ← Optional compatibility stubs
```

### Why One File?

| Approach             | Simplicity      | Security | Maintenance              | Verdict         |
| -------------------- | --------------- | -------- | ------------------------ | --------------- |
| **Root `.env` only** | ✅ Simple       | ✅ Good  | ✅ Easy                  | **RECOMMENDED** |
| Root + app overrides | ⚠️ Complex      | ⚠️ Risky | ❌ Hard                  | Not recommended |
| Separate per-app     | ❌ Very complex | ❌ Poor  | ❌ Maintenance nightmare | Avoid           |

**Benefits:**

- No drift between API and Web configurations
- Single deploy artifact (`.env` file)
- Easier debugging (no hidden precedence)
- Clearer permissions (one file to secure)

---

## 2. Complete Environment Variable Reference

### Root `.env` — Production Template

```env
# ═══════════════════════════════════════════════════════════════
# APPLICATION CORE
# ═══════════════════════════════════════════════════════════════
NODE_ENV=production
PORT=8444
APP_NAME=AppName
APP_VERSION=1.0.0

# ═══════════════════════════════════════════════════════════════
# DATABASE (AWS RDS PostgreSQL)
# ═══════════════════════════════════════════════════════════════
# Primary connection string (recommended method)
DATABASE_URL=postgresql://db_user:db_password@your-rds.rds.amazonaws.com:5432/app_database?sslmode=require

# Individual fields (used as fallback by some tools)
DATABASE_HOST=your-rds.rds.amazonaws.com
DATABASE_PORT=5432
DATABASE_USERNAME=db_user
DATABASE_PASSWORD=strong_password_here
DATABASE_NAME=app_database

# Performance tuning
DATABASE_POOL_SIZE=10
DATABASE_POOL_IDLE_TIMEOUT=900

# ═══════════════════════════════════════════════════════════════
# REDIS (Docker internal or AWS ElastiCache)
# ═══════════════════════════════════════════════════════════════
# For local Docker: use service name "redis"
# For AWS ElastiCache: use cluster endpoint
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=strong_redis_password
REDIS_DB=0
REDIS_TTL=3600

# ═══════════════════════════════════════════════════════════════
# JWT AUTHENTICATION
# ═══════════════════════════════════════════════════════════════
# Generate: openssl rand -base64 64
JWT_SECRET=your_64_byte_base64_secret_here
JWT_TOKEN_AUDIENCE=your-domain.com
JWT_TOKEN_ISSUER=your-domain.com
JWT_ACCESS_TOKEN_TTL=900          # 15 minutes (seconds)
JWT_REFRESH_TOKEN_TTL=604800       # 7 days (seconds)
BCRYPT_SALT_ROUNDS=12

# ═══════════════════════════════════════════════════════════════
# GOOGLE OAUTH
# ═══════════════════════════════════════════════════════════════
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=https://your-domain.com/api/auth/google/callback

# ═══════════════════════════════════════════════════════════════
# STRIPE PAYMENTS (if applicable)
# ═══════════════════════════════════════════════════════════════
STRIPE_SECRET_KEY=sk_live_your_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_secret_here
DEFAULT_CURRENCY=USD
STRIPE_WEBHOOK_ENDPOINT_SECRET=whsec_your_secret

# ═══════════════════════════════════════════════════════════════
# AWS SERVICES
# ═══════════════════════════════════════════════════════════════
AWS_REGION=eu-west-1
AWS_ACCESS_KEY_ID=AKIA_your_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key

# S3 File Storage
AWS_S3_BUCKET_NAME=your-app-uploads
AWS_S3_BASE_URL=https://your-app-uploads.s3.eu-west-1.amazonaws.com

# SES Email
SMTP_HOST=email-smtp.eu-west-1.amazonaws.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_ses_smtp_username
SMTP_PASSWORD=your_ses_smtp_password
SMTP_FROM_EMAIL=noreply@your-domain.com
SMTP_FROM_NAME=AppName

# ═══════════════════════════════════════════════════════════════
# GOOGLE MAPS (Server-Side API)
# ═══════════════════════════════════════════════════════════════
# Restrict by IP address in Google Cloud Console
GOOGLE_MAPS_API_KEY=your_server_side_key
MAPS_CACHE_TTL_DAYS=30
MAPS_DEFAULT_RADIUS_KM=10
MAPS_MAX_RADIUS_KM=50

# ═══════════════════════════════════════════════════════════════
# FIREBASE (Push Notifications)
# ═══════════════════════════════════════════════════════════════
# Paste the complete service account JSON as a single-line string
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"your-project","...":"..."}
FIREBASE_PROJECT_ID=your-firebase-project-id

# ═══════════════════════════════════════════════════════════════
# WEB PUSH (VAPID Keys)
# ═══════════════════════════════════════════════════════════════
# Generate: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_SUBJECT=mailto:notifications@your-domain.com

# ═══════════════════════════════════════════════════════════════
# URLS & CORS
# ═══════════════════════════════════════════════════════════════
FRONTEND_URL=https://your-domain.com
APP_URL=https://your-domain.com
WEB_APP_URL=https://your-domain.com
CORS_ORIGINS=https://your-domain.com,https://www.your-domain.com

# ═══════════════════════════════════════════════════════════════
# LOGGING & MONITORING
# ═══════════════════════════════════════════════════════════════
LOG_LEVEL=info
SENTRY_DSN=https://your_sentry_key@sentry.io/project-id
ENVIRONMENT=production

# ═══════════════════════════════════════════════════════════════
# FEATURE FLAGS (Optional)
# ═══════════════════════════════════════════════════════════════
FEATURE_NEW_DASHBOARD=true
FEATURE_BETA_API_V2=false
```

### Development `.env`

```env
NODE_ENV=development
PORT=8444
DATABASE_URL=postgresql://donebyme_user:donebyme_password@localhost:5432/donebyme_booking
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=donebyme_redis
JWT_SECRET=dev-secret-do-not-use-in-production
FRONTEND_URL=http://localhost:3001
APP_URL=http://localhost:3001
CORS_ORIGINS=http://localhost:3001,http://localhost:3000
LOG_LEVEL=debug
```

### Variable Categories & Counts

| Category             | Count  | Secrets | Public |
| -------------------- | ------ | ------- | ------ |
| Core & Runtime       | 4      | 0       | 4      |
| Database             | 6      | 3       | 3      |
| Redis                | 5      | 1       | 4      |
| JWT & Auth           | 6      | 1       | 5      |
| Google OAuth         | 3      | 1       | 2      |
| Stripe               | 3      | 2       | 1      |
| AWS Services         | 8      | 3       | 5      |
| Google Maps          | 3      | 1       | 2      |
| Firebase             | 2      | 1       | 1      |
| Web Push (VAPID)     | 3      | 2       | 1      |
| URLs & CORS          | 4      | 0       | 4      |
| Logging & Monitoring | 3      | 1       | 2      |
| **TOTAL**            | **53** | **19**  | **34** |

---

## 3. Database Configuration

### PostgreSQL Connection String Anatomy

```
postgresql://username:password@hostname:port/database?sslmode=require&pool_size=10

├─ postgresql://        ← Protocol (always postgresql:// for Postgres)
├─ username:password    ← Database credentials
├─ @hostname:port       ← Server address and port
├─ /database            ← Database name
└─ ?sslmode=require     ← Query parameters
   ├─ sslmode=require   ← Enforce SSL (recommended for production)
   └─ pool_size=10      ← Connection pooling
```

### Production RDS Setup

```env
# AWS RDS Endpoint Format
DATABASE_URL=postgresql://user:password@your-instance.xxxxx.region.rds.amazonaws.com:5432/dbname?sslmode=require
```

**Key requirements:**

- Always use `sslmode=require` for cloud databases
- Security group must allow inbound traffic on port 5432 from EC2 instance
- Database credentials stored in AWS Secrets Manager (optional but recommended)

### Local Development Setup

```env
DATABASE_URL=postgresql://app_user:app_password@localhost:5432/app_dev?sslmode=disable
```

**Note:** `sslmode=disable` is OK for local development, never for production.

### Connection Pooling

For applications with high connection load, configure pooling:

```env
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require&pool_size=20&max_lifetime=600000
```

| Parameter    | Value  | Purpose                           |
| ------------ | ------ | --------------------------------- |
| pool_size    | 10-20  | Number of persistent connections  |
| max_lifetime | 600000 | Max connection age (ms)           |
| idle_timeout | 600    | Idle connection timeout (seconds) |

---

## 4. Redis Configuration

### Docker-Internal Redis

When Redis runs as a Docker service on the same network:

```env
REDIS_HOST=redis                    # Service name (Docker DNS)
REDIS_PORT=6379                     # Default Redis port
REDIS_PASSWORD=strong_password      # Set in docker-compose.yml
REDIS_DB=0                         # Database number (0-15)
REDIS_TTL=3600                     # Default TTL (seconds)
```

### AWS ElastiCache

For managed Redis on AWS:

```env
REDIS_HOST=your-cluster.xxxxx.ng.0001.euw1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_PASSWORD=generated_by_aws
REDIS_DB=0
# ElastiCache often requires TLS
REDIS_TLS=true
```

### Connection Configuration

```env
# Redis connection string (alternative format)
REDIS_URL=redis://:password@host:6379/0

# Or individual parameters
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=password
REDIS_DB=0
REDIS_USERNAME=default            # For Redis 6+ with ACL
```

---

## 5. Production Security Checklist

### Secrets Management

- [ ] Never commit `.env` file to version control
- [ ] Add `.env` to `.gitignore`
- [ ] Use AWS Secrets Manager or HashiCorp Vault for secret rotation
- [ ] Rotate secrets quarterly
- [ ] Generate strong random values for all secrets

Generate secure secrets:

```bash
# JWT Secret
openssl rand -base64 64

# Passwords
openssl rand -hex 32

# VAPID Keys
npx web-push generate-vapid-keys
```

### Environment Isolation

- [ ] Development, staging, and production have separate `.env` files
- [ ] Production `.env` stored only on production server (not in repo)
- [ ] Staging uses staging-specific credentials (not production)
- [ ] Database passwords differ per environment

### Access Control

- [ ] Only authorized personnel can access production `.env`
- [ ] SSH key secured with proper permissions (`chmod 600`)
- [ ] Database users have minimum required permissions
- [ ] Redis requires strong password authentication

### Validation

- [ ] All required environment variables are set
- [ ] Connection strings point to correct endpoints
- [ ] SSL/TLS enabled for all external connections
- [ ] CORS origins restricted to known domains

---

## 6. Common Configuration Patterns

### Multi-Tenant Configuration

For multi-tenant SaaS applications:

```env
# Tenant context propagation
TENANT_ID_HEADER=x-tenant-id
ENABLE_TENANT_ISOLATION=true

# Multi-database setup (optional)
TENANT_DB_MODE=shared              # shared, silo, or bridge
```

### Feature Flags

```env
FEATURE_NEW_UI=true
FEATURE_BETA_API=false
FEATURE_EXPORT_DATA=true
```

Access in code:

```typescript
if (process.env.FEATURE_NEW_UI === 'true') {
  // Use new UI
}
```

### Logging Configuration

```env
LOG_LEVEL=info                     # debug, info, warn, error, fatal
LOG_FORMAT=json                    # json or pretty
SENTRY_DSN=https://...@sentry.io/id
SENTRY_ENVIRONMENT=production
```

### Rate Limiting

```env
RATE_LIMIT_WINDOW_MS=900000        # 15 minutes
RATE_LIMIT_MAX_REQUESTS=100        # per window
```

---

## 7. Troubleshooting

### Issue: "Environment variable not set" error

**Diagnosis:** Variable missing from `.env` or not loaded

**Fix:**

```bash
# Check if .env file exists
ls -la .env

# Verify variable is set
echo $DATABASE_URL

# Reload env (if using shell)
source .env
```

### Issue: Database connection refused

**Diagnosis:** Wrong host/port, RDS not accessible, wrong credentials

**Fix:**

```bash
# Test connection manually
psql -h <DATABASE_HOST> -U <DATABASE_USERNAME> -d <DATABASE_NAME>

# Check security group
aws ec2 describe-security-groups --group-ids sg-xxxxx

# Verify RDS endpoint
aws rds describe-db-instances --db-instance-identifier your-instance
```

### Issue: Redis authentication failed

**Diagnosis:** Wrong password or Redis not configured

**Fix:**

```bash
# Test Redis connection
redis-cli -h <REDIS_HOST> -p <REDIS_PORT> -a <REDIS_PASSWORD> ping
# Expected: PONG

# Check Redis running
docker ps | grep redis
```

### Issue: CORS errors in browser

**Diagnosis:** CORS_ORIGINS not set correctly

**Fix:**

```bash
# Check current value
echo $CORS_ORIGINS

# Update to include your domain
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com

# Restart API
docker compose restart api
```

### Issue: Secrets exposed in logs

**Diagnosis:** Accidentally logged sensitive values

**Fix:**

```env
# Mask secrets from logs
LOG_SANITIZE_KEYS=PASSWORD,SECRET,TOKEN,KEY
```

---

## Quick Reference: What Each Variable Does

| Variable              | Example            | Impact                        |
| --------------------- | ------------------ | ----------------------------- |
| `DATABASE_URL`        | `postgresql://...` | Where data is stored          |
| `JWT_SECRET`          | 64-byte base64     | How authentication works      |
| `REDIS_HOST`          | `redis`            | Session/cache storage         |
| `FRONTEND_URL`        | `https://app.com`  | Where frontend lives          |
| `GOOGLE_MAPS_API_KEY` | `AIzaS...`         | Geolocation features          |
| `STRIPE_SECRET_KEY`   | `sk_live_...`      | Payment processing            |
| `CORS_ORIGINS`        | `https://app.com`  | Cross-origin requests allowed |
| `LOG_LEVEL`           | `info`             | Logging verbosity             |

---

## Next Steps

1. Create `.env.example` template with all required variables
2. Document environment-specific differences
3. Set up AWS Secrets Manager rotation
4. Implement environment validation at startup
5. Monitor environment configuration changes

---

**Last Updated:** May 2026
**Status:** Production Ready
