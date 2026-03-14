# Kubernetes Scaling Guide

Horizontal scaling patterns and Kubernetes deployment strategies for multi-tenant SaaS applications.

## Table of Contents

1. [When to Scale](#1-when-to-scale)
2. [Horizontal Scaling Architecture](#2-horizontal-scaling-architecture)
3. [Kubernetes Deployment](#3-kubernetes-deployment)
4. [Load Balancing](#4-load-balancing)
5. [Database Scaling](#5-database-scaling)
6. [Cache Scaling](#6-cache-scaling)
7. [Auto-Scaling](#7-auto-scaling)
8. [Cost Optimization](#8-cost-optimization)

---

## 1. When to Scale

### Scaling Triggers

**Scale Up When:**

- CPU usage > 70% sustained
- Memory usage > 80% sustained
- Response time > SLA threshold
- Database connection pool near limit
- Pod evictions occurring

**Monitor Metrics:**

```
Metric                 Threshold      Action
─────────────────────  ─────────────  ──────────────
CPU per pod            > 70%          Add replicas
Memory per pod         > 80%          Add replicas
API response time      > 500ms        Scale API tier
Database connections   > 80% pool     Scale DB / connection pool
Redis memory           > 85%          Scale Redis
Request queue depth    > 100          Add replicas
```

### Scaling Checklist

- [ ] Stateless API — no local state to replicate
- [ ] Database connection pooling configured
- [ ] Cache keys don't assume single instance
- [ ] Health checks responsive and accurate
- [ ] Graceful shutdown implemented (drain connections)
- [ ] Load balancer configured for all replicas
- [ ] Monitoring in place before scaling

---

## 2. Horizontal Scaling Architecture

### Single Instance (Development)

```
┌──────────────────────────────┐
│         EC2 (4GB)            │
├──────────────────────────────┤
│  Nginx:80/443                │
│  API (1 replica)   :8444     │
│  Web (1 replica)   :3001     │
│  Redis             :6379     │
│  Total: ~2.3GB               │
└──────────────────────────────┘
        │
        ▼
   AWS RDS (PostgreSQL)
```

### Horizontally Scaled (Production)

```
        ┌─────────────────────────────┐
        │   AWS Application Load       │
        │   Balancer (ALB)            │
        │   Port 443 (SSL)            │
        └────────┬────────────────────┘
                 │
        ┌────────┴──────────┬──────────┐
        │                   │          │
        ▼                   ▼          ▼
    ┌────────┐          ┌────────┐  ┌────────┐
    │ EC2#1  │          │ EC2#2  │  │ EC2#3  │
    │ 4GB    │          │ 4GB    │  │ 4GB    │
    │ Nginx  │          │ Nginx  │  │ Nginx  │
    │ API    │          │ API    │  │ API    │
    │ Web    │          │ Web    │  │ Web    │
    │ Redis* │          │ Redis* │  │ Redis* │
    └────┬───┘          └────┬───┘  └────┬───┘
         │                   │           │
         │                   │           │
         │        ┌──────────▼───────────┤
         │        │                      │
         ▼        ▼                      ▼
      AWS RDS PostgreSQL   AWS ElastiCache (Redis Cluster)

  * Local Redis for session cache (not persisted)
    OR use Redis Cluster for distributed caching
```

### Key Changes for Scaling

| Component         | Development      | Scaled              |
| ----------------- | ---------------- | ------------------- |
| **API Instances** | 1                | 3-10                |
| **Web Instances** | 1                | 2-5                 |
| **Load Balancer** | Nginx only       | ALB/NLB             |
| **Redis**         | Single container | ElastiCache cluster |
| **Database**      | RDS single       | RDS + read replicas |
| **Auto-scaling**  | Manual           | Target tracking     |
| **Cost**          | ~$100/mo         | $500-2000/mo        |

---

## 3. Kubernetes Deployment

### Kubernetes Architecture

```yaml
# deployment-api.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: production
spec:
  replicas: 3 # Horizontal scaling
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: myapp-api:1.2.3
          ports:
            - containerPort: 8444
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: database-url
            - name: NODE_ENV
              value: 'production'
          resources:
            requests:
              memory: '512Mi'
              cpu: '250m'
            limits:
              memory: '1024Mi'
              cpu: '1'
          livenessProbe:
            httpGet:
              path: /health
              port: 8444
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 8444
            initialDelaySeconds: 10
            periodSeconds: 5
      affinity:
        podAntiAffinity: # Spread across nodes
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values:
                        - api
                topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: api-service
spec:
  selector:
    app: api
  ports:
    - protocol: TCP
      port: 8444
      targetPort: 8444
  type: ClusterIP
```

### Scaling Commands

```bash
# Kubernetes scaling
kubectl scale deployment api --replicas=5

# Check deployment status
kubectl get deployments
kubectl describe deployment api

# Watch pods scaling
kubectl get pods -w

# Check resource usage
kubectl top nodes
kubectl top pods
```

---

## 4. Load Balancing

### AWS Application Load Balancer (ALB)

```bash
# ALB Configuration
Target Group: api-servers
├─ Protocol: HTTP
├─ Port: 8444
├─ Health Check: /health
├─ Healthy threshold: 2
├─ Unhealthy threshold: 3
├─ Interval: 30s
└─ Targets:
    ├─ EC2#1
    ├─ EC2#2
    └─ EC2#3

Listener Rule (HTTPS:443)
├─ Host: yourdomain.com
├─ Path: /api*
└─ Forward to: api-servers target group
```

### Nginx Load Balancing (Cost-Free Alternative)

```nginx
upstream api_backends {
    server api1:8444;
    server api2:8444;
    server api3:8444;

    # Health check
    check interval=3000 rise=2 fall=5 timeout=1000 type=http;
    check_http_send "GET /health HTTP/1.0\r\n\r\n";
    check_http_expect_alive http_2xx;
}

server {
    listen 80;
    server_name yourdomain.com;

    location /api {
        proxy_pass http://api_backends;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Sticky Sessions (Session Affinity)

For stateless apps, sticky sessions aren't needed. For session-based auth:

```nginx
# ALB sticky sessions
Target Group Settings
├─ Stickiness: Enabled
├─ Duration: 86400 seconds
└─ Type: Load balancer generated cookie
```

Or use Redis for session storage (eliminates need for sticky sessions):

```yaml
# Kubernetes
affinity:
  sessionAffinity: ClientIP
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
```

---

## 5. Database Scaling

### RDS Scaling Strategies

#### Option A: Vertical Scaling (Bigger Instance)

```bash
# Modify RDS instance type
aws rds modify-db-instance \
  --db-instance-identifier app-db \
  --db-instance-class db.r6i.2xlarge \
  --apply-immediately
```

**Pros:** Simple, minimal config changes
**Cons:** Downtime (minutes), can't scale indefinitely

#### Option B: Read Replicas

```bash
# Create read replica
aws rds create-db-instance-read-replica \
  --db-instance-identifier app-db-read-replica-1 \
  --source-db-instance-identifier app-db \
  --region eu-west-1

# Application code
```

**Read-heavy workload:**

```typescript
// Primary (write)
const writePool = createPool(process.env.DATABASE_URL);

// Read replicas (select queries)
const readPool = createPool(
  `postgresql://user:pass@read-replica.rds.amazonaws.com:5432/db`
);

// Usage
const data = await readPool.query('SELECT * FROM users WHERE id = $1', [
  userId,
]);
const created = await writePool.query('INSERT INTO logs ...');
```

#### Option C: Sharding (Advanced)

For extremely large datasets, shard by tenant:

```typescript
// Route to tenant-specific database
function getDatabaseUrl(tenantId) {
  const shardIndex = tenantId % SHARD_COUNT; // 0, 1, 2...
  return SHARD_DATABASES[shardIndex];
}

// Use
const db = createConnection(getDatabaseUrl(tenantId));
```

---

## 6. Cache Scaling

### Redis Standalone → Cluster

```bash
# Current: Local Redis in Docker (single point of failure)
docker compose up redis

# Upgraded: AWS ElastiCache Cluster
# Create cluster via AWS Console or CLI
aws elasticache create-replication-group \
  --replication-group-description "app-cache" \
  --engine redis \
  --cache-node-type cache.r6g.xlarge \
  --num-cache-clusters 3 \
  --automatic-failover-enabled
```

### Connection String Update

```env
# Old (single Redis)
REDIS_HOST=redis
REDIS_PORT=6379

# New (ElastiCache cluster)
REDIS_HOST=app-cache.xxxxx.ng.0001.use1.cache.amazonaws.com
REDIS_PORT=6379
REDIS_TLS=true                  # ElastiCache uses TLS
```

### Redis Cluster Sharding

```typescript
// Using ioredis with cluster support
import Redis from 'ioredis';

const cluster = new Redis.Cluster([
  { host: 'node-1', port: 6379 },
  { host: 'node-2', port: 6379 },
  { host: 'node-3', port: 6379 },
]);

// Automatic key distribution across nodes
await cluster.set('session:123', JSON.stringify(sessionData));
```

---

## 7. Auto-Scaling

### Kubernetes Horizontal Pod Autoscaler (HPA)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-autoscaler
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 3
  maxReplicas: 10
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
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300 # Wait 5 min before scaling down
    scaleUp:
      stabilizationWindowSeconds: 0 # Scale up immediately
```

### AWS Auto Scaling Group

```bash
# Create Auto Scaling Group
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name api-asg \
  --launch-template LaunchTemplateId=lt-xxxxx \
  --min-size 3 \
  --max-size 10 \
  --desired-capacity 3 \
  --target-group-arns arn:aws:elasticloadbalancing:...

# Create scaling policy
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name api-asg \
  --policy-name cpu-scaling \
  --policy-type TargetTrackingScaling \
  --target-tracking-configuration TargetValue=70.0,PredefinedMetricSpecification="{PredefinedMetricType=ASGAverageCPUUtilization}"
```

---

## 8. Cost Optimization

### Development vs Production Sizing

| Environment       | API Replicas | Web Replicas | Memory | Monthly Cost |
| ----------------- | ------------ | ------------ | ------ | ------------ |
| **Dev**           | 1            | 1            | 4GB    | ~$100        |
| **Staging**       | 2            | 1            | 8GB    | ~$200        |
| **Prod (Small)**  | 3            | 2            | 16GB   | ~$500        |
| **Prod (Medium)** | 5            | 3            | 24GB   | ~$1000       |
| **Prod (Large)**  | 10           | 5            | 48GB   | ~$2000       |

### Cost Reduction Strategies

1. **Reserved Instances** — 30-40% discount, 1-3 year commitment
2. **Spot Instances** — 70% discount, interruptible (use for stateless workers)
3. **Scheduled Scaling** — Scale down nights/weekends
4. **Right-sizing** — Use correct instance types (don't over-provision)
5. **Caching** — Reduce database load
6. **CDN** — Static asset delivery (CloudFront)

### Example Scheduled Scaling

```bash
# Scale down to 1 instance at 22:00 UTC (save during off-hours)
aws autoscaling put-scheduled-action \
  --auto-scaling-group-name api-asg \
  --scheduled-action-name scale-down-night \
  --recurrence "0 22 * * *" \
  --min-size 1 \
  --desired-capacity 1

# Scale up to 3 instances at 08:00 UTC
aws autoscaling put-scheduled-action \
  --auto-scaling-group-name api-asg \
  --scheduled-action-name scale-up-morning \
  --recurrence "0 8 * * *" \
  --min-size 3 \
  --desired-capacity 3
```

---

## Scaling Checklist

- [ ] Application is stateless (no local files, in-memory data)
- [ ] Database connection pooling configured
- [ ] Health checks working (Kubernetes needs this)
- [ ] Environment variables support multi-instance deployment
- [ ] Load balancer configured and tested
- [ ] Graceful shutdown implemented
- [ ] Monitoring and alerting in place
- [ ] Disaster recovery plan documented
- [ ] Cost estimates approved
- [ ] Load testing completed before production

---

**Last Updated:** May 2026
**Status:** Production Ready
