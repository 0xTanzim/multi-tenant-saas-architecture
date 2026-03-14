# Widget API Integration & Third-Party Access

**Version:** 1.0
**Status:** Reference Implementation
**Audience:** Integration Engineers, API Architects, Security Engineers

---

## Overview

This document explains how external systems (third-party websites, partner applications, embedded widgets) can integrate with a multi-tenant SaaS platform while maintaining **strict tenant isolation**.

### Integration Scenarios

1. **Embedded Widget** - Tenant's website embeds a booking/transaction widget
2. **Native API** - Third-party application consumes tenant data via REST API
3. **Webhook Integration** - Tenant's system receives event notifications
4. **OAuth Delegation** - Tenant grants third-party app access to their data
5. **Custom Integration** - Vendor-specific deep integrations

---

## Embedded Widget Pattern

### What is an Embedded Widget?

An **embedded widget** is an iframe that runs on a third-party website while connecting back to the platform's backend.

**Example: Booking Widget on Partner Website**

```html
<!-- Partner's website (partner.example.com) -->
<html>
  <head>
    <title>Partner - Booking Page</title>
  </head>
  <body>
    <h1>Book an appointment</h1>

    <!-- 🎯 Embedded widget from platform -->
    <iframe
      src="https://platform.example.com/widget/tenant-xyz/booking"
      width="100%"
      height="600"
      frameborder="0"
      title="Booking Widget"
    ></iframe>
  </body>
</html>
```

### Why Embedded Widgets Matter

| Aspect           | Traditional Model                          | Embedded Widget             |
| ---------------- | ------------------------------------------ | --------------------------- |
| **User Journey** | User leaves partner site → visits platform | User stays on partner site  |
| **Load Time**    | Full page load (~2s)                       | Fast iframe (~500ms)        |
| **Branding**     | Platform branding shown                    | Partner branding maintained |
| **Bounce Rate**  | Higher (users leave)                       | Lower (users stay)          |
| **Conversion**   | Lower (friction)                           | Higher (seamless)           |

---

## Widget Architecture

### Component Flow

```
┌──────────────────────────────┐
│   Partner's Website          │
│   (partner.example.com)      │
│                              │
│  ┌───────────────────────┐  │
│  │  Embedded iframe      │  │
│  │  /widget/tenant-abc   │  │
│  │                       │  │
│  │  [Booking Form]       │  │
│  └───────────────────────┘  │
└──────────────────────────────┘
            ↓ CORS
┌──────────────────────────────┐
│   Platform Backend           │
│   (platform.example.com)     │
│                              │
│  Widget Controller           │
│    ├─ Validate tenant        │
│    ├─ Check API key          │
│    ├─ Return widget HTML     │
│    └─ Process submission     │
└──────────────────────────────┘
            ↓
┌──────────────────────────────┐
│   PostgreSQL Database        │
│                              │
│  Bookings table (tenant_id) │
│  [Isolated by tenant_id]    │
└──────────────────────────────┘
```

### Security Boundaries

```
┌─────────────────────────────────────────┐
│  Cross-Origin Request (CORS)            │
│  Partner site → Platform iframe         │
│                                         │
│  • Origin check required                │
│  • API key validation                   │
│  • CORS headers configured              │
│  • Tenant ID verification               │
└─────────────────────────────────────────┘
         ↓ Verified
┌─────────────────────────────────────────┐
│  Backend Validation                     │
│                                         │
│  • Tenant exists and is active          │
│  • API key matches tenant               │
│  • Submission data sanitized            │
│  • Data inserted with tenant_id         │
└─────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────┐
│  Database Isolation                     │
│                                         │
│  WHERE tenant_id = $1                   │
│  [Data strictly separated]              │
└─────────────────────────────────────────┘
```

---

## API Key Management

### API Key Scoping

```
One Tenant → One API Key
One API Key → Scoped to Single Tenant Only
```

**API Key Structure:**

```
pk_live_abc123def456ghi789jkl0mnopqrst
│││  │   │
│││  │   └─ Random unique identifier
│││  └───── Environment (live, test, dev)
│││────── Key type (public, secret)
└────────── Product prefix
```

### API Key Binding

```sql
-- API Keys table
CREATE TABLE api_keys (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,              -- 🔑 Tenant binding
  key_hash VARCHAR(255) NOT NULL,       -- Hashed for security
  key_prefix VARCHAR(20) NOT NULL,      -- Public prefix
  environment VARCHAR(20) NOT NULL,     -- live, test, dev
  name VARCHAR(100) NOT NULL,           -- Descriptive name
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP,
  created_by UUID NOT NULL,

  -- Isolation: No cross-tenant access possible
  CONSTRAINT fk_tenant
    FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,

  -- Uniqueness: One key per environment per tenant
  UNIQUE(tenant_id, key_prefix)
);
```

### Key Validation Flow

```
┌──────────────────────────────────────┐
│ Incoming Request                     │
│ Authorization: Bearer pk_test_abc123 │
└──────────────────────────────────────┘
             ↓
┌──────────────────────────────────────┐
│ Extract and validate key             │
│ 1. Extract prefix: "pk_test_abc123"  │
│ 2. Look up in database               │
│ 3. Get associated tenant_id          │
│ 4. Verify is_active = true           │
│ 5. Check expiry date                 │
└──────────────────────────────────────┘
             ↓
┌──────────────────────────────────────┐
│ Attach tenant context to request     │
│ req.tenant = { id: "tenant-xyz" }    │
│ req.apiKey = { scope: "tenant" }     │
└──────────────────────────────────────┘
             ↓
┌──────────────────────────────────────┐
│ Execute with tenant context          │
│ All queries filtered by tenant_id    │
└──────────────────────────────────────┘
```

---

## Tenant Isolation for Integrated Services

### The Problem

Without explicit tenant filtering, an integration could:

```typescript
// ❌ WRONG: No tenant filter
@Post('/api/bookings')
async createBooking(@Body() data) {
  // Any API key from any tenant could read ALL bookings!
  return this.bookingRepo.findAll();
}
```

### The Solution: Mandatory Tenant Filtering

```typescript
// ✅ CORRECT: Always filter by tenant
@Post('/api/bookings')
async createBooking(
  @CurrentTenant() tenant,      // Extracted from API key
  @Body() data
) {
  // Only returns bookings for this specific tenant
  return this.bookingRepo.find({
    where: { tenantId: tenant.id }
  });
}

// Repository enforces the filtering
async find(filters) {
  // Implicit tenant filter added by repository
  const query = this.db
    .where('tenant_id', '=', filters.tenantId)  // ← Mandatory
    .where(filters);

  return query;
}
```

### Audit Trail

Every API call is logged with tenant context:

```json
{
  "timestamp": "2025-05-10T14:23:45Z",
  "apiKey": "pk_live_abc123",
  "tenant_id": "tenant-xyz",
  "method": "POST",
  "endpoint": "/api/bookings",
  "statusCode": 201,
  "dataAccessed": ["bookings", "customers"],
  "ipAddress": "192.0.2.1",
  "userAgent": "BookingWidget/1.0"
}
```

---

## OAuth Integration Pattern

### Third-Party App Access via OAuth

```
┌──────────────────────────┐
│  Tenant (User)           │
│  "Grant access to my     │
│  booking data to         │
│  Analytics App"          │
└──────────┬───────────────┘
           │
           ↓
┌──────────────────────────┐
│  Platform Authorization  │
│  OAuth endpoint          │
│  /oauth/authorize?       │
│  client_id=analytics     │
│  scope=bookings:read     │
│  redirect_uri=...        │
└──────────┬───────────────┘
           │ ← Tenant confirms
           ↓
┌──────────────────────────┐
│  Token Exchange          │
│  POST /oauth/token       │
│  code=abc123             │
│  client_secret=***       │
└──────────┬───────────────┘
           │
           ↓
┌──────────────────────────┐
│  Access Token Issued     │
│  {                       │
│    "access_token": "...",│
│    "tenant_id": "xyz",   │
│    "scope": "bookings:read"
│  }                       │
└──────────┬───────────────┘
           │
           ↓
┌──────────────────────────┐
│  Analytics App uses      │
│  token for API calls     │
│  GET /api/bookings       │
│  Authorization: Bearer...│
│                          │
│  ✅ Tenant isolation     │
│     maintained           │
└──────────────────────────┘
```

### OAuth Scope Management

| Scope            | Description                  | Permissions |
| ---------------- | ---------------------------- | ----------- |
| `bookings:read`  | Read-only access to bookings | GET only    |
| `bookings:write` | Create/update bookings       | POST, PUT   |
| `customers:read` | Access customer data         | GET only    |
| `analytics:read` | Aggregated analytics         | GET only    |
| `admin`          | Full tenant access           | All methods |

**Security Rule**: Never grant `admin` scope via OAuth. Always use minimal required scopes.

---

## Widget Configuration

### Tenant Widget Settings

```json
{
  "tenantId": "tenant-xyz",
  "widget": {
    "enabled": true,
    "publicKey": "pk_live_abc123",
    "allowedOrigins": [
      "https://partner.example.com",
      "https://partner-staging.example.com"
    ],
    "customization": {
      "primaryColor": "#2563eb",
      "theme": "light",
      "language": "en"
    },
    "features": {
      "booking": true,
      "payment": true,
      "reviews": false
    },
    "dataCollection": {
      "customerName": true,
      "customerEmail": true,
      "customerPhone": true,
      "customFields": []
    },
    "webhooks": {
      "bookingCreated": "https://partner.example.com/webhooks/booking",
      "bookingCancelled": "https://partner.example.com/webhooks/cancel"
    }
  }
}
```

### CORS Configuration

```typescript
// Configure CORS for widget embedding
const corsOptions = {
  origin: function (origin, callback) {
    // Get allowed origins for this tenant from database
    const tenant = req.tenant;

    const allowedOrigins = tenant.widget.allowedOrigins;

    if (!origin || allowedOrigins.includes(origin)) {
      // Origin is allowed
      callback(null, true);
    } else {
      // Origin not allowed
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Total-Count'],
};

app.use(cors(corsOptions));
```

---

## Webhook Integration

### Event Notifications

Tenants can subscribe to webhooks to receive real-time events:

```json
{
  "event": "booking.created",
  "timestamp": "2025-05-10T14:23:45Z",
  "tenantId": "tenant-xyz",
  "data": {
    "bookingId": "booking-456",
    "customerId": "customer-789",
    "scheduledAt": "2025-05-15T10:00:00Z",
    "amount": 150.0,
    "currency": "USD"
  },
  "signature": "sha256=abc123..."
}
```

### Webhook Validation

```typescript
// Validate webhook signature
function validateWebhookSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  // Constant-time comparison (prevent timing attacks)
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(`sha256=${expectedSignature}`)
  );
}
```

### Webhook Retry Logic

```
Attempt 1: Immediate
  └─ Success? Done ✅
  └─ Fail? → Wait 60s

Attempt 2: +60s
  └─ Success? Done ✅
  └─ Fail? → Wait 300s

Attempt 3: +300s
  └─ Success? Done ✅
  └─ Fail? → Wait 1800s

Attempt 4: +1800s
  └─ Success? Done ✅
  └─ Fail? → Webhook disabled, alert tenant
```

---

## Rate Limiting & Quotas

### API Rate Limiting

```
Tier       | Requests/Hour | Concurrent | Requests/Second
-----------|---------------|------------|----------------
Free       | 1,000         | 10         | 1
Standard   | 10,000        | 50         | 5
Premium    | 100,000       | 500        | 50
Enterprise | Unlimited     | Custom     | Custom
```

### Rate Limit Headers

```
HTTP/1.1 200 OK
X-RateLimit-Limit: 10000
X-RateLimit-Remaining: 9842
X-RateLimit-Reset: 1620000000
```

### Quota Enforcement

```typescript
// Check quota before processing
@UseGuards(RateLimitGuard)
@Post('/api/bookings')
async createBooking(@CurrentTenant() tenant) {
  const quota = tenant.apiQuota;  // { limit: 10000, used: 9842 }

  if (quota.used >= quota.limit) {
    throw new QuotaExceededException();
  }

  // Process booking...
  quota.used++;
}
```

---

## Security Best Practices

### API Key Security

**DO:**

- ✅ Rotate keys regularly (quarterly minimum)
- ✅ Hash keys in database (never store plaintext)
- ✅ Use strong random generation (crypto.randomBytes)
- ✅ Expire old keys after rotation period
- ✅ Log all API calls with tenant context
- ✅ Invalidate keys on suspicious activity

**DON'T:**

- ❌ Send keys via email
- ❌ Store keys in version control
- ❌ Use predictable key formats
- ❌ Allow unlimited key lifetime
- ❌ Share keys between tenants
- ❌ Log sensitive data (PII, payment info)

### Origin Validation

```typescript
// ✅ Strict origin validation
const origin = req.get('Origin');
const allowedOrigins = tenant.widget.allowedOrigins;

if (!allowedOrigins.includes(origin)) {
  res.status(403).json({ error: 'Origin not allowed' });
  return;
}

// Also validate referrer as fallback
const referrer = req.get('Referer');
if (referrer && !allowedOrigins.some((o) => referrer.startsWith(o))) {
  res.status(403).json({ error: 'Referrer not allowed' });
  return;
}
```

### Data Encryption

```typescript
// Encrypt sensitive data in transit
app.use(helmet()); // Sets security headers
app.use(
  express.json({
    verify: (req, res, buf) => {
      // Verify HTTPS only
      if (process.env.NODE_ENV === 'production' && req.protocol !== 'https') {
        throw new Error('HTTPS required');
      }
    },
  })
);
```

---

## Monitoring & Observability

### Key Metrics

```
- API calls per tenant per hour
- Widget page load time (p50, p99)
- Webhook delivery success rate
- API error rate by tenant
- Quota usage by tier
- Authentication failures
```

### Alerting Rules

```
Alert when:
- Single tenant uses >80% of hourly quota
- Widget response time > 2s
- Webhook failure rate > 5%
- >10 authentication failures from single IP
- API key used from unexpected geographic location
```

### Logs Example

```json
{
  "timestamp": "2025-05-10T14:23:45.123Z",
  "service": "widget-api",
  "level": "INFO",
  "apiKey": "pk_live_***",
  "tenant_id": "tenant-xyz",
  "endpoint": "/api/widget/tenant-xyz/bookings",
  "method": "POST",
  "statusCode": 201,
  "responseTime_ms": 145,
  "dataSize_bytes": 1024,
  "origin": "https://partner.example.com",
  "userAgent": "Mozilla/5.0...",
  "ipAddress": "192.0.2.1",
  "userId": "user-789",
  "action": "booking_created",
  "tags": ["widget", "booking", "api"]
}
```

---

## Integration Lifecycle

### Onboarding a New Integration

```
1. Tenant requests widget/API access
   └─ Submit request with use case

2. Platform issues public API key
   └─ Example: pk_live_abc123def456

3. Tenant configures allowed origins
   └─ Adds partner domain(s)
   └─ E.g., https://partner.example.com

4. Tenant configures webhooks (optional)
   └─ Specifies endpoint for notifications
   └─ E.g., https://partner.example.com/webhooks

5. Tenant integrates widget/API
   └─ Adds HTML/code to their site
   └─ Tests in staging environment

6. Tenant enables in production
   └─ Toggled via tenant settings
   └─ Goes live

7. Monitor and support
   └─ Log all API calls
   └─ Alert on quota issues
   └─ Provide analytics dashboard
```

---

## Common Integration Patterns

### Pattern 1: Simple Widget Embed

```html
<iframe
  src="https://platform.example.com/widget/tenant-xyz/booking"
  width="100%"
  height="600"
></iframe>
```

**Use Case**: Booking, appointments, reservations
**Complexity**: Low
**Security**: High (iframe isolation)

### Pattern 2: REST API Integration

```typescript
const response = await fetch('https://platform.example.com/api/bookings', {
  method: 'GET',
  headers: {
    Authorization: `Bearer pk_live_abc123`,
    'Content-Type': 'application/json',
  },
});
```

**Use Case**: Custom dashboard, reporting, analytics
**Complexity**: Medium
**Security**: High (API key + CORS)

### Pattern 3: OAuth + Webhooks

```typescript
// OAuth flow for user authorization
// Tenant grants third-party app access
// Webhooks notify app of events

const token = await exchangeAuthCode(code);
// Subscribe to webhooks
await subscribeWebhook('booking.created', webhookUrl);
```

**Use Case**: Deep integrations, marketplace apps
**Complexity**: High
**Security**: Highest (user consent + webhooks)

---

## Summary

**Widget and API integration architecture provides:**

1. ✅ **Strict isolation** - Tenant data never leaked across boundaries
2. ✅ **Flexible access** - Multiple integration patterns supported
3. ✅ **Secure by default** - API keys, CORS, origin validation
4. ✅ **Scalable** - Works for 100s of tenants with 1000s of integrations
5. ✅ **Observable** - Complete audit trail of all API access
6. ✅ **Production-ready** - Rate limiting, quotas, monitoring

This pattern enables platforms to offer powerful third-party integrations while maintaining strict multi-tenant security boundaries.
