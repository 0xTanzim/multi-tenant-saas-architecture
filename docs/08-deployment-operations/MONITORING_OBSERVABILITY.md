# Monitoring & Observability for Multi-Tenant SaaS

This document outlines comprehensive logging, metrics collection, request tracing, alerting, and SLA monitoring strategies for multi-tenant production systems.

## Table of Contents

1. [Logging with Tenant Context](#logging-with-tenant-context)
2. [Metrics Collection (Per-Tenant)](#metrics-collection-per-tenant)
3. [Request Tracing Across Layers](#request-tracing-across-layers)
4. [Alerting Strategies](#alerting-strategies)
5. [SLA Monitoring & Dashboards](#sla-monitoring--dashboards)
6. [Health Checks](#health-checks)
7. [Incident Response](#incident-response)

---

## Logging with Tenant Context

### Structured Logging Format

All logs must include `tenant_id` for cross-tenant isolation and debugging:

```json
{
  "timestamp": "2025-02-15T10:30:45.123Z",
  "level": "info",
  "service": "api",
  "tenant_id": "acme-corp",
  "user_id": "user-123",
  "request_id": "req-abc123",
  "trace_id": "trace-xyz789",
  "message": "Booking created successfully",
  "duration_ms": 245,
  "status_code": 201,
  "resource": "bookings",
  "action": "create",
  "metadata": {
    "booking_id": "bkg-456",
    "staff_id": "staff-789",
    "service_duration_minutes": 60
  }
}
```

### Logging Implementation

```typescript
// apps/api/src/common/logging/logger.service.ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class LoggerService {
  private logger = new Logger('DoneByMe');

  info(message: string, context: LogContext) {
    this.logger.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        service: 'api',
        tenant_id: context.tenantId,
        user_id: context.userId,
        request_id: context.requestId,
        trace_id: context.traceId,
        message,
        ...context.metadata
      })
    );
  }

  error(message: string, error: Error, context: LogContext) {
    this.logger.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'api',
        tenant_id: context.tenantId,
        user_id: context.userId,
        request_id: context.requestId,
        trace_id: context.traceId,
        message,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack
        },
        ...context.metadata
      })
    );
  }

  security(message: string, context: LogContext & { severity: 'low' | 'medium' | 'high' | 'critical' }) {
    this.logger.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        severity: context.severity,
        service: 'api',
        tenant_id: context.tenantId,
        user_id: context.userId,
        request_id: context.requestId,
        message,
        ...context.metadata
      })
    );
  }
}

// Usage in service
async function createBooking(dto: CreateBookingDto, req: RequestWithTenant) {
  const requestId = nanoid();
  const traceId = req.headers['x-trace-id'] || requestId;

  try {
    this.logger.info('Creating booking', {
      tenantId: req.tenant.id,
      userId: req.user.id,
      requestId,
      traceId,
      metadata: { service_id: dto.serviceId }
    });

    const booking = await this.db.bookings.create({...});

    this.logger.info('Booking created', {
      tenantId: req.tenant.id,
      userId: req.user.id,
      requestId,
      traceId,
      metadata: { booking_id: booking.id, duration_ms: Date.now() - startTime }
    });

    return booking;
  } catch (error) {
    this.logger.error('Booking creation failed', error, {
      tenantId: req.tenant.id,
      userId: req.user.id,
      requestId,
      traceId,
      metadata: { service_id: dto.serviceId }
    });
    throw error;
  }
}
```

### Centralized Log Aggregation

```bash
# Docker Compose with ELK Stack (Elasticsearch, Logstash, Kibana)
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.0.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false

  logstash:
    image: docker.elastic.co/logstash/logstash:8.0.0
    volumes:
      - ./logstash.conf:/usr/share/logstash/pipeline/logstash.conf:ro
    depends_on:
      - elasticsearch

  kibana:
    image: docker.elastic.co/kibana/kibana:8.0.0
    ports:
      - "5601:5601"
    depends_on:
      - elasticsearch

  api:
    # ... api config
    logging:
      driver: "awslogs"  # Or: splunk, graylog, etc.
      options:
        awslogs-group: "/ecs/donebyme-api"
        awslogs-region: "us-east-1"
        awslogs-stream-prefix: "ecs"
```

### Log Retention Policy

```
Development:   Keep logs for 7 days
Staging:       Keep logs for 30 days
Production:    Keep logs for 90 days (compliance requirement)
Archive:       S3 after 90 days (for audit trails, keep 7 years)
```

---

## Metrics Collection (Per-Tenant)

### Key Metrics to Track

```typescript
// Type of metrics to collect
interface TenantMetrics {
  // Request metrics
  requests_total: Counter;
  request_latency: Histogram;
  request_errors: Counter;

  // Business metrics
  bookings_created: Counter;
  bookings_cancelled: Counter;
  revenue_total: Gauge;
  active_subscriptions: Gauge;

  // System metrics
  database_query_time: Histogram;
  cache_hit_rate: Gauge;
  api_connections_active: Gauge;
}
```

### Prometheus Metrics Implementation

```typescript
// apps/api/src/common/metrics/metrics.service.ts
import { register, Counter, Histogram, Gauge } from 'prom-client';

export class MetricsService {
  private requestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'endpoint', 'status', 'tenant_id'],
  });

  private requestLatency = new Histogram({
    name: 'http_request_duration_ms',
    help: 'HTTP request latency',
    labelNames: ['method', 'endpoint', 'tenant_id'],
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
  });

  private bookingsCreated = new Counter({
    name: 'bookings_created_total',
    help: 'Total bookings created',
    labelNames: ['tenant_id', 'service_type'],
  });

  private tenantActiveSubscriptions = new Gauge({
    name: 'tenant_active_subscriptions',
    help: 'Active subscriptions per tenant',
    labelNames: ['tenant_id'],
  });

  recordRequest(
    method: string,
    endpoint: string,
    status: number,
    tenantId: string,
    duration: number
  ) {
    this.requestsTotal.inc({ method, endpoint, status, tenant_id: tenantId });
    this.requestLatency.observe(
      { method, endpoint, tenant_id: tenantId },
      duration
    );
  }

  recordBookingCreated(tenantId: string, serviceType: string) {
    this.bookingsCreated.inc({
      tenant_id: tenantId,
      service_type: serviceType,
    });
  }

  updateActiveSubscriptions(tenantId: string, count: number) {
    this.tenantActiveSubscriptions.set({ tenant_id: tenantId }, count);
  }

  // Expose metrics endpoint
  getMetrics() {
    return register.metrics();
  }
}

// Usage in middleware
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      this.metrics.recordRequest(
        req.method,
        req.route?.path || req.path,
        res.statusCode,
        req.tenant?.id || 'unknown',
        duration
      );
    });

    next();
  }
}
```

### Metrics Endpoint

```typescript
// apps/api/src/metrics.controller.ts
@Controller('metrics')
export class MetricsController {
  @Get()
  getMetrics() {
    return this.metricsService.getMetrics();
  }
}
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Multi-Tenant SaaS Metrics",
    "panels": [
      {
        "title": "Request Rate (per tenant)",
        "targets": [
          {
            "expr": "sum(rate(http_requests_total[5m])) by (tenant_id)"
          }
        ]
      },
      {
        "title": "P99 Latency (per tenant)",
        "targets": [
          {
            "expr": "histogram_quantile(0.99, http_request_duration_ms) by (tenant_id)"
          }
        ]
      },
      {
        "title": "Error Rate by Tenant",
        "targets": [
          {
            "expr": "sum(rate(http_requests_total{status=~'5..'}[5m])) by (tenant_id)"
          }
        ]
      },
      {
        "title": "Bookings Created (24h)",
        "targets": [
          {
            "expr": "increase(bookings_created_total[24h]) by (tenant_id)"
          }
        ]
      }
    ]
  }
}
```

---

## Request Tracing Across Layers

### Distributed Tracing Setup

```typescript
// apps/api/src/main.ts
import { initializeTracing } from './common/tracing';

async function bootstrap() {
  // Initialize OpenTelemetry
  const tracer = initializeTracing({
    serviceName: 'donebyme-api',
    environment: process.env.NODE_ENV,
    samplingRate: 0.1, // 10% of requests
  });

  const app = await NestFactory.create(AppModule);
  app.listen(8444);
}

// Implementation
export function initializeTracing(config: TracingConfig) {
  const sdk = new NodeSDK({
    traceExporter: new JaegerExporter({
      host: process.env.JAEGER_HOST || 'localhost',
      port: parseInt(process.env.JAEGER_PORT || '6831'),
    }),
    instrumentations: [
      new ExpressInstrumentation(),
      new HttpInstrumentation(),
      new PostgresInstrumentation(),
    ],
  });

  sdk.start();
  return trace.getTracer(config.serviceName);
}
```

### Propagating Trace Context

```typescript
// Request middleware to extract trace context
@Injectable()
export class TracingMiddleware implements NestMiddleware {
  constructor(private tracer: any) {}

  use(req: Request, res: Response, next: NextFunction) {
    // Extract or generate trace ID
    const traceId = req.headers['x-trace-id'] || nanoid();
    const spanId = req.headers['x-span-id'] || nanoid();

    // Attach to request context
    req['traceId'] = traceId;
    req['spanId'] = spanId;

    // Propagate in response headers
    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-span-id', spanId);

    const span = this.tracer.startSpan(`${req.method} ${req.path}`, {
      attributes: {
        'http.method': req.method,
        'http.url': req.url,
        tenant_id: req.tenant?.id,
        user_id: req.user?.id,
      },
    });

    // Pass to next middleware
    next();

    // End span after response
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
    });
  }
}

// Propagate to external services
async function callExternalApi(url: string, req: RequestWithTracing) {
  const headers = {
    'x-trace-id': req.traceId,
    'x-span-id': req.spanId,
    'x-tenant-id': req.tenant.id,
  };

  return fetch(url, { headers });
}

// Database queries include trace context
async function queryDatabase(
  sql: string,
  params: any[],
  req: RequestWithTracing
) {
  const span = this.tracer.startSpan('db.query', {
    attributes: {
      trace_id: req.traceId,
      'db.type': 'postgres',
      'db.operation': sql.split(' ')[0],
      tenant_id: req.tenant.id,
    },
  });

  try {
    return await db.query(sql, params);
  } finally {
    span.end();
  }
}
```

### Jaeger UI Visualization

```
Jaeger UI (http://localhost:16686)
├─ Search by Trace ID (e.g., req-abc123)
├─ View full request flow:
│  ├─ Frontend → API (10ms)
│  ├─ API → PostgreSQL (45ms)
│  ├─ API → Redis (2ms)
│  └─ API → External Service (100ms)
├─ Identify bottlenecks (slow DB query)
└─ Correlate errors across layers
```

---

## Alerting Strategies

### Alert Thresholds

```yaml
# Prometheus alert rules
groups:
  - name: donebyme_alerts
    rules:
      # High error rate
      - alert: HighErrorRate
        expr: |
          (sum(rate(http_requests_total{status=~"5.."}[5m])) by (tenant_id)
           /
           sum(rate(http_requests_total[5m])) by (tenant_id)) > 0.01
        for: 5m
        annotations:
          summary: 'High error rate for {{ $labels.tenant_id }}'
          severity: critical

      # High latency
      - alert: HighLatency
        expr: histogram_quantile(0.99, http_request_duration_ms) > 1000
        for: 5m
        annotations:
          summary: 'P99 latency > 1s for {{ $labels.tenant_id }}'
          severity: warning

      # Database connection pool exhausted
      - alert: DbConnectionPoolExhausted
        expr: pg_stat_activity_count / pg_max_connections > 0.8
        for: 5m
        annotations:
          summary: 'Database connection pool > 80% full'
          severity: warning

      # Replication lag
      - alert: HighReplicationLag
        expr: pg_last_xact_replay_lag > 1000000 # 1 second in microseconds
        for: 5m
        annotations:
          summary: 'Database replication lag > 1s'
          severity: warning

      # Cache hit rate too low
      - alert: LowCacheHitRate
        expr: cache_hit_rate < 0.7
        for: 10m
        annotations:
          summary: 'Cache hit rate < 70% ({{ $value | humanize }}%)'
          severity: info
```

### Notification Channels

```yaml
# alertmanager.yml
global:
  resolve_timeout: 5m

route:
  receiver: 'default'
  group_by: ['alertname', 'tenant_id']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

  routes:
    # Critical: Immediate PagerDuty
    - match:
        severity: critical
      receiver: 'pagerduty'
      repeat_interval: 1h

    # Warning: Slack
    - match:
        severity: warning
      receiver: 'slack'
      repeat_interval: 2h

receivers:
  - name: 'default'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/...'
        channel: '#alerts'
        title: '{{ .GroupLabels.alertname }}'

  - name: 'pagerduty'
    pagerduty_configs:
      - service_key: '{{ .GroupLabels.severity }}'
```

### On-Call Escalation

```
Severity Level | Response Time | Escalation
─────────────────────────────────────────────
Critical      | 5 minutes     | Immediate PagerDuty
High          | 15 minutes    | Slack + Email
Medium        | 30 minutes    | Email
Low           | Next business day | Ticket
```

---

## SLA Monitoring & Dashboards

### SLA Definitions

```
┌──────────────┬──────────────┬────────────────┬─────────────────┐
│ Plan Tier    │ Uptime SLA   │ P99 Latency    │ Incident Response│
├──────────────┼──────────────┼────────────────┼─────────────────┤
│ Starter      │ 99% (7h/mo)  │ 500ms          │ Best effort     │
│ Business     │ 99.9% (43m/mo)│ 250ms          │ < 1 hour        │
│ Enterprise   │ 99.99% (4m/mo)│ 100ms          │ < 15 minutes    │
└──────────────┴──────────────┴────────────────┴─────────────────┘
```

### SLA Calculation

```sql
-- Calculate uptime for each tenant
SELECT
  tenant_id,
  date_trunc('day', timestamp) as day,
  (COUNT(CASE WHEN status_code < 500 THEN 1 END)::float / COUNT(*) * 100) as uptime_percent
FROM request_logs
GROUP BY tenant_id, date_trunc('day', timestamp)
ORDER BY tenant_id, day DESC;

-- Monthly SLA report
SELECT
  tenant_id,
  date_trunc('month', timestamp) as month,
  (SUM(CASE WHEN status_code < 500 THEN 1 ELSE 0 END)::float / COUNT(*) * 100) as monthly_uptime
FROM request_logs
GROUP BY tenant_id, date_trunc('month', timestamp)
HAVING date_trunc('month', timestamp) = date_trunc('month', CURRENT_DATE);
```

### SLA Dashboard

```json
{
  "title": "SLA Dashboard - Multi-Tenant",
  "panels": [
    {
      "title": "Monthly Uptime by Tenant",
      "type": "table",
      "targets": [
        {
          "expr": "Monthly uptime query"
        }
      ]
    },
    {
      "title": "SLA Compliance Status",
      "type": "stat",
      "targets": [
        {
          "expr": "Compare actual vs. committed uptime"
        }
      ],
      "thresholds": {
        "green": 99.9,
        "yellow": 99,
        "red": 95
      }
    },
    {
      "title": "Error Budgets (Days Until SLA Breach)",
      "type": "gauge",
      "calculation": "(SLA % - current uptime %) * days_remaining_in_month / 100"
    }
  ]
}
```

---

## Health Checks

### Detailed Health Endpoint

```typescript
// apps/api/src/health.controller.ts
@Controller('health')
export class HealthController {
  @Get()
  async check(@Req() req: RequestWithTenant): Promise<HealthStatus> {
    const checks = await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkExternalServices(),
    ]);

    return {
      status: checks.every((c) => c.status === 'fulfilled')
        ? 'healthy'
        : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: checks[0].status === 'fulfilled' ? 'ok' : 'down',
        cache: checks[1].status === 'fulfilled' ? 'ok' : 'down',
        external_apis: checks[2].status === 'fulfilled' ? 'ok' : 'down',
      },
      tenant_id: req.tenant?.id,
    };
  }

  @Get('ready')
  async isReady(): Promise<{ ready: boolean }> {
    try {
      await this.checkDatabase();
      return { ready: true };
    } catch {
      return { ready: false };
    }
  }

  private async checkDatabase() {
    const result = await db.query('SELECT 1');
    return result.rows.length > 0;
  }

  private async checkRedis() {
    return redis.ping();
  }

  private async checkExternalServices() {
    return fetch('https://api.stripe.com/health').then((r) => r.ok);
  }
}
```

### Kubernetes Probes

```yaml
# Kubernetes deployment health checks
spec:
  containers:
    - name: api
      livenessProbe:
        httpGet:
          path: /health
          port: 8444
        initialDelaySeconds: 10
        periodSeconds: 30
        failureThreshold: 3

      readinessProbe:
        httpGet:
          path: /health/ready
          port: 8444
        initialDelaySeconds: 5
        periodSeconds: 10
        failureThreshold: 2
```

---

## Incident Response

### Incident Escalation Process

```
┌─────────────────────────────────────────────────────────────┐
│ Alert Triggered (e.g., 5% error rate)                       │
└────────────────┬────────────────────────────────────────────┘
                 │
         ┌───────▼────────┐
         │ Page on-call   │
         │ engineer       │
         └───────┬────────┘
                 │
         ┌───────▼───────────────┐
         │ 1. Assess severity    │
         │ 2. Review dashboards  │
         │ 3. Check alert context│
         └───────┬───────────────┘
                 │
        ┌────────▼─────────┐
        │ Is it critical?  │
        └─┬──────────────┬─┘
          │              │
       YES│              │NO
         │              └─────────► Monitor & document
         │
    ┌────▼─────────────┐
    │ Execute runbook  │
    │ (restart service,│
    │  rollback, etc)  │
    └────┬──────────────┘
         │
    ┌────▼──────────────┐
    │ Did it help?      │
    └─┬──────────────┬──┘
      │              │
     YES            NO
      │              └──► Escalate to L2/L3 team
      │
    ┌─▼────────────────┐
    │ Post-incident:   │
    │ - Document RCA   │
    │ - Create tickets │
    │ - Notify tenants │
    └──────────────────┘
```

### Incident Communication

```
Timeline:
T+0:00  Alert triggered → Page on-call
T+0:05  ACK alert → Begin investigation
T+0:15  Identify root cause → Begin remediation
T+0:30  Fix deployed/reverted → Monitor recovery
T+1:00  All systems nominal → Declare incident over
T+24h   RCA report published
T+48h   Preventive measures implemented
```

---

## Summary

| Component    | Tool/Pattern                  | Purpose                      |
| ------------ | ----------------------------- | ---------------------------- |
| **Logging**  | ELK/Datadog + structured logs | Debugging & audit trail      |
| **Metrics**  | Prometheus + Grafana          | Performance tracking         |
| **Tracing**  | Jaeger/Zipkin                 | Request flow visualization   |
| **Alerting** | Prometheus AlertManager       | Proactive incident detection |
| **SLA**      | Custom queries                | Compliance & accountability  |
| **Health**   | HTTP endpoints                | Load balancer checks         |

---

## References

- [OpenTelemetry Documentation](https://opentelemetry.io/)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/)
- [Grafana Dashboards](https://grafana.com/grafana/dashboards/)
- [Jaeger Tracing](https://www.jaegertracing.io/)
