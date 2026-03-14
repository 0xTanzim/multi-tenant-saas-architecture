# Scaling Strategy for Multi-Tenant SaaS

This document outlines horizontal scaling, load balancing, database replication, multi-region deployments, and cost optimization strategies for growing multi-tenant systems.

## Table of Contents

1. [Horizontal Scaling (Multiple API Instances)](#horizontal-scaling-multiple-api-instances)
2. [Load Balancing](#load-balancing)
3. [Database Scaling & Read Replicas](#database-scaling--read-replicas)
4. [Cache Scaling (Redis)](#cache-scaling-redis)
5. [Multi-Region Deployment](#multi-region-deployment)
6. [Cost Optimization Per-Tenant](#cost-optimization-per-tenant)
7. [Scaling Bottleneck Analysis](#scaling-bottleneck-analysis)
8. [Auto-Scaling Policies](#auto-scaling-policies)

---

## Horizontal Scaling (Multiple API Instances)

### Stateless Architecture

For multi-tenant SaaS to scale horizontally, API instances **must be stateless**:

```
┌─────────────────┐
│  Load Balancer  │  Routes requests to any available instance
└────────┬────────┘
         │
    ┌────┼────┐
    ▼    ▼    ▼
 ┌─────┬─────┬─────┐
 │ API │ API │ API │  All instances identical, handle any tenant
 │  1  │  2  │  3  │
 └─────┴─────┴─────┘
    ▼    ▼    ▼
 (shared) PostgreSQL + Redis
```

### Statelessness Requirements

**Forbidden** (state per instance):

```typescript
// ❌ WRONG: In-process cache, state persists per instance
class BookingCache {
  private cache = new Map(); // Lost if instance dies

  getBooking(id: string) {
    return this.cache.get(id); // Other instances don't see this
  }
}
```

**Required** (shared external state):

```typescript
// ✅ CORRECT: External Redis, all instances share same state
class BookingCache {
  async getBooking(id: string) {
    return redis.get(`booking:${id}`); // Any instance can read
  }
}
```

### Scaling API Instances

#### Docker Compose (Local Scaling)

```yaml
# docker-compose.yml
services:
  api-1:
    image: donebyme-api:v1.0.0
    environment:
      - INSTANCE_ID=1
    ports:
      - '8444:8444'

  api-2:
    image: donebyme-api:v1.0.0
    environment:
      - INSTANCE_ID=2
    ports:
      - '8445:8444'

  api-3:
    image: donebyme-api:v1.0.0
    environment:
      - INSTANCE_ID=3
    ports:
      - '8446:8444'

  nginx:
    image: nginx:latest
    ports:
      - '80:80'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
```

#### Kubernetes (Production Scaling)

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: donebyme-api
spec:
  replicas: 3 # Start with 3 instances
  selector:
    matchLabels:
      app: donebyme-api
  template:
    metadata:
      labels:
        app: donebyme-api
    spec:
      containers:
        - name: api
          image: donebyme-api:v1.0.0
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 1000m
              memory: 2Gi
          livenessProbe:
            httpGet:
              path: /health
              port: 8444
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8444
            initialDelaySeconds: 5
            periodSeconds: 10
```

### Scaling Metrics

| Metric              | Threshold | Action                  |
| ------------------- | --------- | ----------------------- |
| CPU utilization     | > 70%     | Add instance            |
| Memory utilization  | > 80%     | Add instance            |
| Request queue depth | > 100     | Add instance            |
| p99 latency         | > 1s      | Investigate & scale     |
| Error rate          | > 0.5%    | Investigate immediately |

---

## Load Balancing

### Nginx Load Balancer Configuration

```nginx
# nginx.conf
upstream api_backend {
    least_conn;  # Route to least-connected instance

    server api-1:8444 max_fails=3 fail_timeout=30s;
    server api-2:8444 max_fails=3 fail_timeout=30s;
    server api-3:8444 max_fails=3 fail_timeout=30s;

    keepalive 32;  # Connection pooling
}

upstream web_backend {
    least_conn;

    server web-1:3001 max_fails=3 fail_timeout=30s;
    server web-2:3001 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    server_name api.donebyme.com;

    location / {
        proxy_pass http://api_backend;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # Timeouts
        proxy_connect_timeout 10s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }

    # Health check endpoint (internal)
    location /health {
        access_log off;
        proxy_pass http://api_backend;
    }
}
```

### Sticky Sessions (Per-Tenant)

If sessions must stick to same instance (JWT-based, not required):

```nginx
# Session affinity by tenant_id
map $http_x_tenant_id $upstream {
    ~^(?<tenant>.+)$ "api_backend_${tenant}";
    default "api_backend";
}

upstream api_backend {
    hash $http_x_tenant_id consistent;
    server api-1:8444;
    server api-2:8444;
    server api-3:8444;
}
```

---

## Database Scaling & Read Replicas

### Primary-Replica Architecture

```
                    ┌────────────────────┐
                    │  Primary (Write)   │
                    │  PostgreSQL 15+    │
                    │  donebyme.rds.main │
                    └────────┬───────────┘
                             │
                    WAL Streaming (binary)
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │  Replica 1   │ │  Replica 2   │ │  Replica 3   │
    │  (Read)      │ │  (Read)      │ │  (Read)      │
    │  us-east-1b  │ │  us-east-1c  │ │  eu-west-1a  │
    └──────────────┘ └──────────────┘ └──────────────┘
```

### Replication Lag Monitoring

```sql
-- Check replica lag (should be < 100ms)
SELECT
  now() - pg_last_xact_replay_timestamp() as replication_lag;

-- On primary: monitor WAL generation rate
SELECT
  pg_current_wal_lsn() as current_wal_lsn;

-- On replica: monitor WAL replay position
SELECT
  pg_last_wal_receive_lsn() as receive_lsn,
  pg_last_wal_replay_lsn() as replay_lsn;
```

### Read/Write Splitting

```typescript
// Database service with read routing
export class DatabaseService {
  constructor(
    private primaryDb: PostgresPool,  // Write operations
    private replicaDb: PostgresPool   // Read-only operations
  ) {}

  // Writes always go to primary
  async createBooking(data: CreateBookingDto, tenantId: string) {
    return this.primaryDb.query(
      `INSERT INTO bookings (tenant_id, ...) VALUES (?, ...)`,
      [tenantId, ...]
    );
  }

  // Reads can go to replica (with lag considerations)
  async getBookings(tenantId: string, options: QueryOptions) {
    // For real-time critical reads, use primary
    if (options.consistent) {
      return this.primaryDb.query(
        `SELECT * FROM bookings WHERE tenant_id = ? ...`,
        [tenantId]
      );
    }

    // For less critical reads, use replica (better scalability)
    return this.replicaDb.query(
      `SELECT * FROM bookings WHERE tenant_id = ? ...`,
      [tenantId]
    );
  }

  // Immediate consistency pattern (for critical operations)
  async createAndRetrieve(data: CreateBookingDto, tenantId: string) {
    // Write to primary
    const booking = await this.createBooking(data, tenantId);

    // Read from primary immediately (ensures consistency)
    return this.primaryDb.query(
      `SELECT * FROM bookings WHERE id = ? AND tenant_id = ?`,
      [booking.id, tenantId]
    );
  }
}
```

### Cascading Reads (Replica Strategy)

```typescript
// Multi-tier read strategy for high-latency scenarios
async getBookingCached(id: string, tenantId: string) {
  // 1. Try local cache (in-memory, < 10ms)
  let booking = localCache.get(`booking:${id}`);
  if (booking) return booking;

  // 2. Try Redis (distributed cache, < 50ms)
  booking = await redis.get(`booking:${id}`);
  if (booking) {
    localCache.set(`booking:${id}`, booking, 60_000);
    return booking;
  }

  // 3. Try read replica (< 100ms, may have lag)
  booking = await replicaDb.query(...);
  if (booking) {
    await redis.setex(`booking:${id}`, 60, booking);
    return booking;
  }

  // 4. Fallback to primary (strong consistency guaranteed)
  booking = await primaryDb.query(...);
  await redis.setex(`booking:${id}`, 60, booking);
  return booking;
}
```

---

## Cache Scaling (Redis)

### Redis Cluster Architecture

```
Client → Redis Cluster
         ├─ Node 1 (Slot 0-5460)
         ├─ Node 2 (Slot 5461-10922)
         └─ Node 3 (Slot 10923-16383)
```

### Redis Cluster Configuration

```bash
# Spin up 3-node Redis cluster
docker run -d --name redis-node-1 \
  redis:8.2-alpine \
  redis-server --cluster-enabled yes --cluster-node-timeout 5000

docker run -d --name redis-node-2 \
  redis:8.2-alpine \
  redis-server --cluster-enabled yes --cluster-node-timeout 5000

docker run -d --name redis-node-3 \
  redis:8.2-alpine \
  redis-server --cluster-enabled yes --cluster-node-timeout 5000

# Create cluster
docker run --rm redis:8.2-alpine redis-cli --cluster create \
  192.168.1.10:6379 192.168.1.11:6379 192.168.1.12:6379 \
  --cluster-replicas 1
```

### Redis Client Configuration

```typescript
// Node.js Redis client with cluster support
import { createCluster } from 'redis';

const redisCluster = createCluster({
  nodes: [
    { host: 'redis-1', port: 6379 },
    { host: 'redis-2', port: 6379 },
    { host: 'redis-3', port: 6379 },
  ],
  options: {
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 50, 500),
    },
  },
});

await redisCluster.connect();

// Usage (same as single instance)
await redisCluster.set(`cache:booking:${id}`, value);
```

### Cache Invalidation Strategy

```typescript
// Pattern 1: TTL-based expiration (passive)
await redis.setex(`booking:${id}`, 300, bookingData); // 5 minute TTL

// Pattern 2: Active invalidation (immediate)
async function updateBooking(id: string, data: any, tenantId: string) {
  await db.query(`UPDATE bookings SET ... WHERE id = ?`, [id]);

  // Invalidate cache keys
  await redis.del(`booking:${id}`);
  await redis.del(`bookings:tenant:${tenantId}`);
  await redis.del(`calendar:tenant:${tenantId}`); // Cascade invalidation
}

// Pattern 3: Cache versioning (cheap invalidation)
const VERSION = 'v1';
const cacheKey = `booking:${id}:${VERSION}`;

// On schema change, increment VERSION, old keys expire naturally
```

---

## Multi-Region Deployment

### Geo-Distributed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Global Load Balancer                        │
│           (Route53 / Cloudflare / GeoDNS)                   │
└─────────────────────────────────────────────────────────────┘
          │                       │                       │
    ┌─────▼─────┐          ┌──────▼──────┐        ┌─────▼──────┐
    │  US-East   │          │  EU-West    │        │  APAC      │
    │  Region    │          │  Region     │        │  Region    │
    │            │          │             │        │            │
    │ ┌────────┐ │          │ ┌────────┐  │        │ ┌────────┐ │
    │ │ API x3 │ │          │ │ API x3 │  │        │ │ API x3 │ │
    │ │ Web x2 │ │          │ │ Web x2 │  │        │ │ Web x2 │ │
    │ │ RDS    │ │          │ │ RDS    │  │        │ │ RDS    │ │
    │ │ Redis  │ │          │ │ Redis  │  │        │ │ Redis  │ │
    │ └────────┘ │          │ └────────┘  │        │ └────────┘ │
    └────────────┘          └─────────────┘        └────────────┘
```

### Multi-Region Replication

```yaml
# Primary region (US-East)
database:
  primary: us-east-1.rds.aws.com
  replicas:
    - us-east-1b (standby)
    - eu-west-1a (asynchronous)
    - ap-southeast-1a (asynchronous)

# Secondary regions read from local replicas
us-east:
  api: reads from us-east-1 primary/replica
eu-west:
  api: reads from eu-west-1 replica (slight lag acceptable)
apac:
  api: reads from ap-southeast-1 replica (slight lag acceptable)
# Writes always go to US-East primary (single source of truth)
```

### Tenant Placement Strategy

```typescript
// Place tenants closest to their location (latency optimization)
interface TenantPlacement {
  tenant_id: string;
  primary_region: 'us-east' | 'eu-west' | 'apac';
  data_residency: 'US' | 'EU' | 'APAC'; // Compliance requirement
}

// Route requests based on tenant region
async function getRegionalApiUrl(tenantId: string): Promise<string> {
  const placement = await cache.get(`tenant:${tenantId}:region`);

  return {
    'us-east': 'https://api-us.donebyme.com',
    'eu-west': 'https://api-eu.donebyme.com',
    apac: 'https://api-apac.donebyme.com',
  }[placement.primary_region];
}
```

---

## Cost Optimization Per-Tenant

### Tiered Infrastructure

```
╔════════════╦════════════╦════════════╗
║   Starter  ║  Business  ║ Enterprise ║
╠════════════╬════════════╬════════════╣
║ Shared API ║ Shared API ║ Dedicated  ║
║ Shared RDS ║ Shared RDS ║ Dedicated  ║
║ Basic SLA  ║ 99.9% SLA  ║ 99.99% SLA ║
║ 1 location ║ 3 replicas ║ Multi-reg  ║
║ $100/mo    ║ $500/mo    ║ $2000/mo   ║
╚════════════╩════════════╩════════════╝
```

### Dynamic Resource Allocation

```typescript
// Scale resources based on tenant plan
async function getResourceLimits(tenantId: string) {
  const subscription = await db.query(
    `SELECT plan FROM subscriptions WHERE tenant_id = ?`,
    [tenantId]
  );

  return {
    starter: {
      api_rate_limit: 100, // req/s
      db_connection_pool: 10,
      cache_ttl: 3600, // 1 hour
      backup_retention: 7, // days
      replicas: 0,
      regions: ['us-east-1'],
    },
    business: {
      api_rate_limit: 1000,
      db_connection_pool: 50,
      cache_ttl: 86400, // 1 day
      backup_retention: 30,
      replicas: 1,
      regions: ['us-east-1', 'eu-west-1'],
    },
    enterprise: {
      api_rate_limit: 10000,
      db_connection_pool: 200,
      cache_ttl: 604800, // 1 week
      backup_retention: 90,
      replicas: 2,
      regions: ['us-east-1', 'eu-west-1', 'ap-southeast-1'],
    },
  }[subscription.plan];
}
```

### Reserved Capacity for Cost Savings

```bash
# AWS: Purchase 1-year RDS reserved instances (40% savings)
aws ec2 purchase-reserved-instances-offering \
  --reserved-instances-offering-id 1ba56e9b-b7a7-4094-bcc1-8a5bad90b0e4 \
  --instance-count 1

# AWS: Spot instances for fault-tolerant workloads (70% savings)
# For non-critical background jobs, use Spot
```

### Cost Monitoring

```sql
-- Track cost per tenant
SELECT
  t.id,
  t.name,
  COUNT(DISTINCT b.id) as bookings,
  SUM(EXTRACT(EPOCH FROM (b.end_time - b.start_time))/3600) as hours_booked,
  ROUND(SUM(...) / 100::numeric, 2) as estimated_monthly_cost
FROM tenants t
LEFT JOIN bookings b ON b.tenant_id = t.id
GROUP BY t.id, t.name
ORDER BY estimated_monthly_cost DESC;
```

---

## Scaling Bottleneck Analysis

### Identify Bottleneck

```
┌─────────────────┐
│ Receive Request │ (fast)
└────────┬────────┘
         │
┌────────▼────────────┐
│ Process Request     │ ← BOTTLENECK?
│ - Validation       │  Check CPU/memory usage
│ - Business Logic   │  Profile query/service times
└────────┬───────────┘
         │
┌────────▼─────────────────┐
│ Query Database           │ ← BOTTLENECK?
│ (N+1 problem?)           │  Slow indexes?
│ (Missing indexes?)       │  Unoptimized query?
└────────┬─────────────────┘
         │
┌────────▼──────────────┐
│ Send Response         │ (usually fast)
└──────────────────────┘
```

### Profiling Tools

```bash
# Node.js CPU profiling (using 0x)
npm install -g 0x
0x --on-port 8444 node apps/api/dist/main.js

# Generate flame graph
# Visit http://localhost:7002 to visualize

# PostgreSQL slow query log
ALTER SYSTEM SET log_min_duration_statement = 1000;  # 1s threshold
SELECT pg_reload_conf();
```

---

## Auto-Scaling Policies

### Kubernetes HorizontalPodAutoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: donebyme-api-autoscaler
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: donebyme-api

  minReplicas: 3
  maxReplicas: 20

  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80

  # Scale up quickly, down slowly
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300 # Wait 5 min before scaling down
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0 # Scale up immediately
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
```

### AWS Auto Scaling Group

```bash
# Create launch template
aws ec2 create-launch-template \
  --launch-template-name donebyme-api-v1 \
  --version-description "API v1.0.0" \
  --launch-template-data '{
    "ImageId": "ami-0c2d3e4fd60b60e38",
    "InstanceType": "t3.medium",
    "MinCount": 3,
    "MaxCount": 20
  }'

# Create autoscaling group
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name donebyme-api-asg \
  --launch-template LaunchTemplateName=donebyme-api-v1,Version='$Latest' \
  --min-size 3 \
  --max-size 20 \
  --target-group-arns arn:aws:elasticloadbalancing:...

# Create scaling policy
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name donebyme-api-asg \
  --policy-name scale-up \
  --scaling-adjustment 5 \
  --adjustment-type ChangeInCapacity \
  --cooldown 60
```

---

## Scaling Summary

| Component        | Strategy                                   | Scaling Limit                |
| ---------------- | ------------------------------------------ | ---------------------------- |
| **API**          | Horizontal (stateless)                     | ~1000 req/s per instance     |
| **Database**     | Vertical (bigger instance) + Read replicas | Limited by write throughput  |
| **Cache**        | Redis cluster                              | Near-unlimited (distributed) |
| **Static Files** | CDN (CloudFront/Cloudflare)                | ~1M req/s                    |

---

## References

- [Kubernetes Horizontal Pod Autoscaler](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [AWS Auto Scaling](https://docs.aws.amazon.com/autoscaling/)
- [PostgreSQL Replication](https://www.postgresql.org/docs/current/warm-standby.html)
- [Redis Cluster Documentation](https://redis.io/topics/cluster-tutorial)
