# Key Principles

A production-grade multi-tenant SaaS system must uphold five non-negotiable principles. These principles guide every architectural decision, code review, and deployment.

---

## 1. Tenant Isolation

### Definition

**Tenant isolation** ensures that data from one tenant is never visible to another, even in case of bugs, crashes, or malicious attempts.

### The Threat Model

Consider these scenarios:

**Scenario A: Accidental Data Leak (Query Bug)**

```typescript
// Developer forgets tenant filter
const bookings = await db.query('SELECT * FROM bookings WHERE status = $1', [
  'confirmed',
]);

// ❌ Returns bookings from ALL tenants
// ❌ Tenant A's customer sees bookings from Tenant B
```

**Scenario B: Injection Attack**

```typescript
// Developer uses string concatenation (never do this)
const tenantId = request.query.tenantId; // "123' OR '1'='1"
const query = `SELECT * FROM bookings WHERE tenant_id = '${tenantId}'`;

// ❌ Attacker can construct query that returns all data
```

**Scenario C: Authorization Bypass**

```typescript
// Developer trusts client input
const tenantId = request.body.tenantId; // Client supplies this

// ❌ Attacker can request data from any tenant
```

### Protection Mechanisms

#### Mechanism 1: Tenant Context from Trusted Source

```typescript
// ✅ Extract tenant from signed JWT (backend-only)
const token = request.headers.authorization.replace('Bearer ', '');
const decoded = jwt.verify(token, JWT_SECRET); // Signature verified
const tenantId = decoded.activeTenant.id;

// ✅ Client cannot forge JWT (signature mismatch = rejected)
// ✅ Client cannot modify claims (signature invalid)
```

#### Mechanism 2: Parameterized Queries

```typescript
// ✅ Parameterized query (immune to injection)
db.query('SELECT * FROM bookings WHERE tenant_id = $1 AND id = $2', [
  tenantId,
  bookingId,
]);

// Database driver handles escaping automatically
// No possibility of string concatenation injection
```

#### Mechanism 3: Database Constraints

```sql
-- ✅ Database-level protection
ALTER TABLE bookings
  ADD CONSTRAINT bookings_tenant_id_not_null
  CHECK (tenant_id IS NOT NULL);

-- Even if application tries to insert NULL tenant_id, database rejects it
```

#### Mechanism 4: Composite Indexes

```sql
-- ✅ Performance + correctness through design
CREATE INDEX idx_bookings_tenant_id_status
  ON bookings(tenant_id, status);

-- Forces every query to consider tenant_id first
-- Query planner naturally optimizes tenant-filtered queries
```

### Isolation Verification Checklist

- [ ] **Every table** with business data has `tenant_id` column
- [ ] **Every query** in repository includes `WHERE tenant_id = ?`
- [ ] **No exceptions** (no cross-tenant queries even for "admin views")
- [ ] **Parameterized queries** used exclusively (no string concatenation)
- [ ] **Tenant context** extracted from JWT/session (never from client input)
- [ ] **Tests verify** cross-tenant access is impossible
- [ ] **Code review** specifically checks for tenant filter presence
- [ ] **Linting rules** flag queries without tenant filter (if possible)

### Cost of Failure

A single tenant isolation breach is catastrophic:

- 🔴 **Regulatory:** GDPR violation (data breach to unauthorized party)
- 🔴 **Legal:** Liable for damages, potential lawsuits
- 🔴 **Reputational:** Customer lost, trust destroyed
- 🔴 **Business:** Regulatory fines, shutdown orders possible

---

## 2. Scalability

### Definition

**Scalability** means the system performance remains predictable as tenant count and per-tenant data grow independently.

### Scaling Dimensions

```
Dimension 1: Tenant Count
  Single tenant system  → 1
  Small SaaS           → 100-1000
  Mid-market SaaS      → 1000-10,000
  Enterprise SaaS      → 10,000-1,000,000

Dimension 2: Data Per Tenant
  Small tenant         → 1000s of rows
  Mid-size tenant      → 100,000s of rows
  Large tenant         → Millions of rows
  Enterprise tenant    → 100+ millions of rows

Both dimensions must scale independently.
```

### Scaling Strategy: Shared Schema Optimization

#### Principle 1: Composite Indexes

```sql
-- ❌ Bad: Index only on tenant_id (slow for large tenants)
CREATE INDEX idx_bookings_tenant_id ON bookings(tenant_id);

-- ✅ Good: Composite index includes query filters
CREATE INDEX idx_bookings_tenant_status
  ON bookings(tenant_id, status);

CREATE INDEX idx_bookings_tenant_date
  ON bookings(tenant_id, created_date DESC);
```

**Result:** Single index lookup finds all relevant rows efficiently, even for large tenants.

#### Principle 2: Pagination for Large Result Sets

```typescript
// ❌ Bad: Fetch all rows at once
const bookings = await db
  .select()
  .from(bookings)
  .where(eq(bookings.tenantId, tenantId))
  .all(); // 1 million rows in memory!

// ✅ Good: Paginate results
const page = 0,
  limit = 50;
const bookings = await db
  .select()
  .from(bookings)
  .where(eq(bookings.tenantId, tenantId))
  .orderBy(desc(bookings.createdAt))
  .limit(limit)
  .offset(page * limit)
  .all();
```

**Result:** Constant memory usage regardless of tenant size.

#### Principle 3: Query Efficiency (SELECT specific columns)

```typescript
// ❌ Bad: Select all columns
select().from(bookings).all();

// ✅ Good: Select only needed columns
select(bookings.id, bookings.customerId, bookings.status, bookings.startTime)
  .from(bookings)
  .all();
```

**Result:** Smaller network transfer, faster query execution.

#### Principle 4: Efficient Joins

```typescript
// ❌ Bad: N+1 Query Problem
const bookings = await db.select().from(bookings).all();
for (const booking of bookings) {
  const customer = await db
    .select()
    .from(customers)
    .where(eq(customers.id, booking.customerId))
    .get(); // 1000 queries for 1000 bookings!
}

// ✅ Good: Single join query
const bookings = await db
  .select({
    booking: bookings,
    customer: customers,
  })
  .from(bookings)
  .innerJoin(customers, eq(bookings.customerId, customers.id))
  .where(eq(bookings.tenantId, tenantId))
  .all(); // 1 query for all bookings + customers
```

**Result:** Dramatic reduction in query count (1000x improvement possible).

### Monitoring for Scalability

```typescript
// Track query performance per tenant
async executeQuery(query, tenantId) {
  const start = Date.now();
  const result = await query;
  const duration = Date.now() - start;

  // Alert if query slow for specific tenant
  if (duration > 1000) {
    logger.warn('Slow query detected', {
      tenantId,
      duration,
      queryType: 'list-bookings',
    });
  }

  return result;
}
```

---

## 3. Performance

### Definition

**Performance** means response times stay fast (< 200ms p95) as system grows.

### Performance Layers

#### Layer 1: Database Query Performance

**Principle:** Minimize database query count and duration.

```typescript
// ✅ Query optimization checklist
const bookings = await db
  .select() // ← Select specific columns only
  .from(bookings)
  .where(
    and(
      eq(bookings.tenantId, tenantId), // ← Composite index match
      eq(bookings.status, 'confirmed')
    )
  )
  .orderBy(desc(bookings.startTime))
  .limit(50) // ← Pagination
  .offset(0)
  .all();

// Expected: ~10-20ms for most queries
```

#### Layer 2: Application-Level Caching

**Principle:** Cache frequently accessed, slow-to-compute data.

```typescript
// Cache booking summary (frequently accessed, slow to compute)
async getBookingSummary(tenantId: UUID): Promise<BookingSummary> {
  // Cache key includes tenant
  const cacheKey = `tenant:${tenantId}:booking:summary`;

  // Check cache first
  let summary = await cache.get(cacheKey);
  if (summary) return JSON.parse(summary);

  // Cache miss: compute
  summary = await this.computeBookingSummary(tenantId);

  // Cache for 5 minutes
  await cache.set(cacheKey, JSON.stringify(summary), 'EX', 300);

  return summary;
}
```

**Result:** Reduces database load, returns data in microseconds instead of milliseconds.

#### Layer 3: Content Delivery Network (CDN)

**Principle:** Serve static assets from edge locations.

```html
<!-- ✅ Static assets cached at CDN edge globally -->
<link rel="stylesheet" href="https://cdn.example.com/app.css" />
<script src="https://cdn.example.com/app.js"></script>

<!-- ✅ Images served from edge -->
<img src="https://cdn.example.com/images/logo.png" alt="logo" />

<!-- ❌ Never serve from origin -->
<script src="https://api.example.com/app.js"></script>
```

**Result:** Page load time reduced by 50-80% for geographically distributed users.

### Performance Targets

| Metric                             | Target  | Risk if Exceeded             |
| ---------------------------------- | ------- | ---------------------------- |
| **First Contentful Paint (FCP)**   | < 1.5s  | Users perceive slowness      |
| **Largest Contentful Paint (LCP)** | < 2.5s  | Poor Core Web Vitals score   |
| **Time to Interactive (TTI)**      | < 3.5s  | Application feels janky      |
| **API response (p95)**             | < 200ms | Unacceptable user experience |
| **Database query (p95)**           | < 100ms | Indicates missing indexes    |

### Performance Measurement

```typescript
// Add performance tracing
const span = tracer.startSpan('BookingService.createBooking');

try {
  const result = await this.repository.create(dto, tenantId);

  span.setTag('status', 'success');
  span.setTag('tenant_id', tenantId);

  return result;
} catch (error) {
  span.setTag('status', 'error');
  span.setTag('error', error.message);
  throw error;
} finally {
  span.end(); // Record timing automatically
}
```

---

## 4. Security

### Definition

**Security** means protecting tenant data from unauthorized access, unauthorized modification, and service disruption.

### Security Layers

#### Layer 1: Authentication

**Principle:** Verify user identity before granting access.

```typescript
// JWT validation
const token = request.headers.authorization.replace('Bearer ', '');
const decoded = jwt.verify(token, JWT_SECRET);

// ✅ If verify fails, error (invalid signature = tampered token)
// ✅ Extract user and tenant from verified claims
const { userId, activeTenant } = decoded;
```

#### Layer 2: Authorization

**Principle:** Verify user has permission for requested action.

```typescript
// Role-based check
@UseGuards(JwtAuthGuard, RoleGuard('owner'))
@Post('settings')
async updateSettings(@Body() dto) {
  // Only "owner" role can reach this endpoint
  // "staff" role rejected before handler executes
}

// Tenant-based check
@UseGuards(JwtAuthGuard, TenantGuard)
@Get('tenant/:slug/bookings')
async listBookings(@Param('slug') slug: string) {
  // User must have role in this tenant
  // User from different tenant rejected
}
```

#### Layer 3: Data Validation

**Principle:** Reject invalid input early.

```typescript
class CreateBookingDto {
  @IsISO8601()
  startTime: string;

  @IsISO8601()
  endTime: string;

  @IsUUID()
  customerId: string;

  // Validator checks type, format, constraints
  // Invalid input rejected before service sees it
}
```

#### Layer 4: Rate Limiting

**Principle:** Prevent abuse and brute force attacks.

```typescript
@UseGuards(RateLimitGuard)
@Post('auth/login')
async login(@Body() dto: LoginDto) {
  // Max 5 login attempts per minute per IP
  // Excess requests rejected automatically
}
```

#### Layer 5: Encryption

**Principle:** Protect sensitive data in transit and at rest.

```typescript
// ✅ Always use HTTPS (TLS encryption)
// ✅ Sensitive data encrypted at rest
const passwordHash = await bcrypt.hash(password, 12); // Not plain password

// ✅ Secrets never in version control
const dbPassword = process.env.DB_PASSWORD; // From secure secret manager
```

### Threat Model

| Threat                      | Protection                                    |
| --------------------------- | --------------------------------------------- |
| **Unauthorized access**     | JWT authentication + role-based authorization |
| **Cross-tenant data leak**  | Tenant filter on every query                  |
| **Injection attacks**       | Parameterized queries, input validation       |
| **Brute force login**       | Rate limiting, account lockout                |
| **Man-in-the-middle**       | HTTPS/TLS encryption                          |
| **Compromised credentials** | Secrets in secure manager, rotation policy    |
| **Privilege escalation**    | Guard checks role before action               |

---

## 5. Compliance

### Definition

**Compliance** means the system satisfies regulatory requirements for data protection, auditing, and retention.

### Key Regulations

#### GDPR (EU Data Protection)

**Requirement:** Users have "right to be forgotten" (data deletion).

```typescript
// Implement data deletion with audit trail
async deleteCustomer(customerId: UUID, tenantId: UUID) {
  // 1. Verify tenant owns this customer
  const customer = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.id, customerId),
        eq(customers.tenantId, tenantId)
      )
    )
    .get();

  if (!customer) throw new NotFoundException();

  // 2. Soft delete (mark as deleted, keep for audit)
  await db
    .update(customers)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(customers.id, customerId),
        eq(customers.tenantId, tenantId)
      )
    );

  // 3. Remove personal data (anonymize)
  await db
    .update(customers)
    .set({ email: 'deleted@example.com', name: 'Deleted' })
    .where(
      and(
        eq(customers.id, customerId),
        eq(customers.tenantId, tenantId)
      )
    );

  // 4. Audit log
  await auditLog.create({
    tenantId,
    action: 'CUSTOMER_DELETED',
    customerId,
    timestamp: new Date(),
  });
}
```

#### HIPAA (US Healthcare Privacy)

**Requirement:** Audit trail for all data access.

```typescript
// Log every access to sensitive data
async getPatientRecord(patientId: UUID, tenantId: UUID) {
  const record = await db.select().from(patientRecords).get();

  // Mandatory: Log who accessed what when
  await auditLog.create({
    tenantId,
    action: 'PATIENT_RECORD_ACCESS',
    patientId,
    userId: request.user.id,
    timestamp: new Date(),
    ipAddress: request.ip,
  });

  return record;
}
```

#### SOC 2 (Service Organization Control)

**Requirement:** Documented security controls and incident response.

```typescript
// Centralized logging for all security events
async logSecurityEvent(event: SecurityEvent) {
  await securityLog.create({
    timestamp: new Date(),
    type: event.type,  // LOGIN, FAILED_AUTH, DATA_ACCESS, etc.
    tenantId: event.tenantId,
    userId: event.userId,
    success: event.success,
    reason: event.reason,
    ipAddress: event.ipAddress,
  });
}
```

### Compliance Checklist

- [ ] **Data retention policy:** Define how long data is kept post-deletion
- [ ] **Audit logging:** Log all data access and modifications
- [ ] **Encryption:** Data encrypted in transit (HTTPS) and at rest (if needed)
- [ ] **Access controls:** Proper authentication and authorization
- [ ] **Incident response:** Documented process for data breach notification
- [ ] **Vendor assessment:** Third-party services comply with standards
- [ ] **Data residency:** Data stored in compliant geographic regions
- [ ] **Employee access:** Employees have least-privilege access to customer data

---

## Principle Interactions

These five principles reinforce each other:

```
Tenant Isolation  ←→  Security
    ↓                    ↓
    └─→  Scalability  ←─┘
         ↓
    Performance
         ↓
    Compliance
```

- **Strong isolation** prevents data leaks (security + compliance)
- **Security controls** enforce isolation boundaries (tenant isolation)
- **Scalability** prevents performance degradation under load (performance)
- **Performance** maintains compliance (audit logging must be fast)
- **Compliance** requires auditing (isolation verification)

---

## Summary Table

| Principle       | Core Requirement               | Failure Mode               | Detection                       |
| --------------- | ------------------------------ | -------------------------- | ------------------------------- |
| **Isolation**   | Tenant filter on every query   | Data leak to other tenant  | Penetration test, code review   |
| **Scalability** | Efficient indexes, pagination  | System slows as data grows | Load testing, query analysis    |
| **Performance** | Fast queries + caching         | User frustration, churn    | APM tools, user metrics         |
| **Security**    | Multi-layer defense            | Unauthorized access        | Security audit, threat modeling |
| **Compliance**  | Audit trails, retention policy | Regulatory fines           | Compliance audit, legal review  |

---

## Next Steps

- Implement these principles in your architecture
- Use this as a code review checklist
- Reference these in technical documentation
- Train team on the "why" behind each principle
