# ADR-002: Application-Level Row Filtering Over Database RLS

**Status:** Accepted
**Date:** 2025-05-10
**Audience:** Architects, Backend Engineers, Database Administrators
**Supersedes:** None
**Superseded By:** None

---

## Decision

We will enforce tenant isolation through **application-level row filtering** (explicit `WHERE tenant_id = ?` checks in the application code) rather than leveraging PostgreSQL's Row-Level Security (RLS) feature.

---

## Context

PostgreSQL provides a built-in Row-Level Security (RLS) mechanism that enforces row filtering at the database level:

```sql
-- Database-enforced RLS policy
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON bookings
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

This mechanism could theoretically eliminate the risk of accidental cross-tenant data leakage by making RLS a database constraint. However, implementing RLS introduces its own complexity and trade-offs.

The decision was required to balance:

- **Security:** Preventing data leakage (database-enforced vs. application-enforced)
- **Debuggability:** Ability to diagnose and trace data access issues
- **Performance:** Query execution patterns and planning complexity
- **Operational Simplicity:** Maintenance burden and troubleshooting
- **Developer Experience:** Ease of reasoning about data access

---

## Options Considered

### Option A: Application-Level Filtering ✓ CHOSEN

**Implementation:**
All data access is filtered in application code. Every repository method includes explicit tenant context and `WHERE tenant_id = ?` clause.

**Example Repository Pattern:**

```typescript
// Always parameterized with tenant context
async findBookingsByTenant(tenantId: string, filters?: BookingFilter): Promise<Booking[]> {
  return await db
    .select()
    .from(bookingsTable)
    .where(
      and(
        eq(bookingsTable.tenantId, tenantId),  // Explicit tenant filter
        filters?.status ? eq(bookingsTable.status, filters.status) : undefined
      )
    );
}

// Service layer enforces tenant context
async getBookings(tenantId: string, userId: string): Promise<Booking[]> {
  // Validate user belongs to tenant before querying
  await this.validateUserInTenant(userId, tenantId);
  return this.bookingsRepository.findBookingsByTenant(tenantId);
}
```

**Pros:**

- ✅ **Full Visibility:** Every data access is explicit and auditable in code
- ✅ **Debuggability:** Stack traces show exactly where data was accessed; SQL queries visible in logs
- ✅ **Performance Predictability:** Query plans unchanged; no RLS overhead
- ✅ **Portability:** Code works across PostgreSQL, MySQL, other databases (not PostgreSQL-specific)
- ✅ **Testability:** Mock tenant contexts easily; unit tests can verify isolation
- ✅ **Simplicity:** No additional database configuration; works with standard SQL
- ✅ **Multi-layer Defense:** Can implement additional checks in services (defense-in-depth)

**Cons:**

- ❌ **Developer Discipline Required:** Missing tenant filter in one query = data leakage; not enforced by database
- ❌ **Code Review Burden:** Every repository change must be reviewed for tenant filter presence
- ❌ **Runtime Errors Not Prevented:** Database doesn't prevent a misconfigured query from accessing other tenants' data
- ❌ **No Safety Net:** RLS would catch mistakes; application-level filtering relies on code correctness

---

### Option B: PostgreSQL Row-Level Security (RLS)

**Implementation:**
Leverage PostgreSQL RLS policies to enforce isolation at the database layer.

**Configuration Example:**

```sql
-- Enable RLS on all tenant-scoped tables
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;

-- Define tenant isolation policy
CREATE POLICY bookings_tenant_isolation ON bookings
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY bookings_tenant_insert ON bookings FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- On every request: SET app.tenant_id = '<tenant_uuid>';
```

**Application Flow:**

```typescript
// At middleware: inject tenant into session
app.use((req, res, next) => {
  const tenantId = extractTenantFromJWT(req);
  // Set PostgreSQL session variable
  await db.execute(`SET app.tenant_id = '${tenantId}'`);
  next();
});

// Repository: queries no longer need explicit tenant filter
async getBookings(): Promise<Booking[]> {
  // RLS policy automatically applies tenant filter at DB layer
  return await db.select().from(bookingsTable);
}
```

**Pros:**

- ✅ **Database-Enforced Safety:** Even buggy code cannot leak data; DB prevents access
- ✅ **Eliminates Discipline Dependency:** Developer mistakes don't create data leakage risk
- ✅ **Simpler Repository Code:** No need to include `tenant_id` filter on every query
- ✅ **Audit Trail:** Database logs all attempts to access other tenants' data (attempts denied)
- ✅ **Compliance Benefit:** GDPR audits can verify database-enforced isolation

**Cons:**

- ❌ **Performance Overhead:** RLS policies add query planning complexity; slight performance penalty (5-10%)
- ❌ **Debugging Difficulty:** Silent filtering makes it hard to diagnose why queries return fewer results
- ❌ **PostgreSQL-Specific:** Tightly coupled to PostgreSQL; not portable to other databases
- ❌ **Configuration Complexity:** RLS policies must be maintained for every table, trigger, and operation
- ❌ **Bypass Scenarios:** Superuser connections bypass RLS (requires careful access control)
- ❌ **Performance Unpredictability:** Query planner behavior with RLS is less predictable
- ❌ **Testing Complexity:** Unit tests must simulate RLS policies (harder to mock)
- ❌ **Learning Curve:** RLS concepts less familiar to typical developers; operational burden on DBAs

---

### Option C: Hybrid (RLS + Application Filtering)

**Implementation:**
Use both RLS (database-enforced safety net) and application-level filtering (explicit visibility).

**Approach:**

- Application layer uses explicit `WHERE tenant_id = ?` for visibility and debuggability
- RLS policies in place as a secondary defense (safety net)
- If application filter is missing, RLS still prevents data leakage

**Pros:**

- ✅ Defense-in-depth: Two layers of protection
- ✅ Application visibility + database safety
- ✅ Catches developer mistakes at DB layer

**Cons:**

- ❌ Double maintenance burden: RLS policies + application filters both required
- ❌ Operational complexity: Manage and troubleshoot both layers
- ❌ Performance cost: Both layers add overhead
- ❌ Masking bugs: If RLS catches mistakes, developers may not notice missing application filters
- ❌ False confidence: Easy to forget to add application filters since "RLS will catch it"

---

## Chosen Option

**Application-Level Row Filtering (Option A)**

### Rationale

1. **Developer Productivity:** Explicit tenant filtering is immediately understandable to any backend engineer. No learning curve.

2. **Debuggability:** Data access is auditable in code. Why did this query return 0 results? Check the SQL logs → immediately obvious tenant filter was applied.

3. **Performance Clarity:** No RLS overhead. Query plans remain predictable and tunable. Performance profiling is straightforward.

4. **Testability:** Easy to mock tenant contexts and verify isolation in unit tests without RLS configuration.

5. **Portability:** If database changes in the future (unlikely, but possible), code remains unchanged.

6. **Explicit Over Implicit:** The codebase should make intent clear. Every data access that includes `WHERE tenant_id = ?` is a conscious, deliberate choice.

7. **Compensating Controls:** Application-level isolation is compensated by:

   - Mandatory code review (tenant filter checklist)
   - Automated tests verifying isolation (fixtures with cross-tenant access attempts)
   - CI/CD checks (lint rules can warn if `tenantId` parameter missing from repository methods)
   - Monitoring (data access metrics tracked by tenant)

8. **Pragmatism:** For a startup/growth-stage SaaS, simpler is better. Add RLS later if audit/compliance requirements force it.

---

## Trade-Offs

| Aspect                | Application-Level           | Database RLS               |
| --------------------- | --------------------------- | -------------------------- |
| **Safety**            | Relies on code correctness  | DB enforces isolation      |
| **Debuggability**     | Full visibility of access   | Silent filtering           |
| **Performance**       | No overhead                 | 5-10% RLS cost             |
| **Portability**       | Works anywhere              | PostgreSQL-specific        |
| **Development Speed** | Faster (explicit is simple) | Slower (RLS configuration) |
| **Maintenance**       | Code review discipline      | DB policy maintenance      |

---

## Consequences

### Positive Consequences

✅ **Clear Data Access Patterns:** Reading the code immediately shows tenant context.

✅ **Simple Performance Tuning:** Query optimization straightforward; no RLS planning complexity.

✅ **Portable Architecture:** Code is not dependent on PostgreSQL-specific features.

✅ **Straightforward Testing:** Mock tenant contexts; verify isolation without RLS setup.

✅ **Developer Onboarding:** New engineers understand tenant isolation quickly (just `WHERE tenant_id = ?`).

✅ **Audit Compliance:** SQL query logs show full context; auditors see exactly what was accessed.

### Negative Consequences

❌ **Operational Risk:** Missing tenant filter = data leakage. No database safety net.

❌ **Code Review Burden:** Must review every query for tenant filter presence.

❌ **Mistake Visibility:** Bugs in production must be caught by monitoring/alerts; not prevented by database.

❌ **Knowledge Dependency:** Relies on team understanding and enforcing discipline.

---

## Enforcement Mechanisms

To mitigate the risks of application-level filtering, the following are **required:**

### 1. Code Review Checklist

Every repository change must include:

- [ ] All queries include `WHERE tenant_id = ?` or filtered through service layer validation
- [ ] No raw SQL queries; use ORM
- [ ] No bypasses of tenant context
- [ ] New queries tested for cross-tenant access

### 2. Automated Testing

```typescript
// Test: Ensure repository cannot query other tenants' data
describe('BookingsRepository - Tenant Isolation', () => {
  it('should not return bookings for other tenants', async () => {
    const tenant1 = await createTenant('Salon A');
    const tenant2 = await createTenant('Salon B');

    // Create booking for Tenant 1
    const booking1 = await createBooking(tenant1.id, 'Alice');

    // Attempt to query as Tenant 2
    const results = await bookingsRepo.findBookingsByTenant(tenant2.id);

    expect(results).not.toContainEqual(booking1);
  });
});
```

### 3. Monitoring & Alerting

- Track data access metrics by tenant
- Alert if single query touches >N rows unexpectedly (runaway query)
- Alert if access patterns unusual (e.g., cross-tenant joins)

### 4. Lint Rules (Optional)

```typescript
// Custom ESLint rule: warn if repository method lacks tenant parameter
// warn if query builder doesn't include tenant filter
```

### 5. Static Analysis

During CI/CD, analyze repository code:

- All queries must include tenant filter OR be called only from service layer that validates tenant
- No exceptions allowed

---

## Migration Path: Application Filtering → RLS

If this decision needs to be revisited (e.g., regulatory requirements mandate database-enforced isolation):

**Migration Strategy:**

1. **Phase 1 - RLS Policies (Passive)**

   - Deploy RLS policies to all tenant-scoped tables
   - Keep application filtering as-is (both active)
   - No code changes; just database configuration

2. **Phase 2 - Validation**

   - Run both layers for 1-2 sprints
   - Verify RLS behavior matches application filtering
   - Test audit logging

3. **Phase 3 - Gradual Removal**

   - Gradually remove application-level tenant filters from repository methods
   - Rely on RLS for actual isolation
   - Maintain application filters in service layer for audit/visibility

4. **Phase 4 - Full RLS**
   - Repository methods no longer include tenant filters
   - RLS is sole isolation mechanism

**Estimated Effort:** 1-2 sprints

---

## Decision Log

**Approved by:** Architecture Review Board
**Approved Date:** 2025-05-10
**Implementation Started:** Q2 2025
**Related Issues:** ARCH-0002, SECURITY-0001
**Related ADRs:** ADR-001 (Shared Schema Isolation), ADR-005 (Soft Deletes)

---

## References

- [TENANT_ARCHITECTURE.md](../02-tenant-management/TENANT_ARCHITECTURE.md)
- [MULTI_TENANT_ISOLATION.md](../03-authorization-security/MULTI_TENANT_ISOLATION.md)
- PostgreSQL Documentation: Row Security Policies
- OWASP: Insecure Data Model
