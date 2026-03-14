# ADR-005: Soft Deletes for All Tenant-Scoped Entities

**Status:** Accepted
**Date:** 2025-05-10
**Audience:** Backend Engineers, Database Administrators, Data Governance
**Supersedes:** None
**Superseded By:** None

---

## Decision

We will use **soft deletes (logical deletion via `deleted_at` column)** for all tenant-scoped entities (bookings, customers, staff, services, etc.) rather than physically deleting data from the database.

When an entity is deleted by a user, the row is marked as deleted (set `deleted_at` timestamp) but remains in the database. All queries filter out soft-deleted rows by default.

---

## Context

The salon SaaS platform must handle data lifecycle decisions with competing requirements:

1. **GDPR Right-to-be-Forgotten:** Users can request deletion of their personal data
2. **Financial Auditing:** Historical records required for salon reporting and reconciliation
3. **Dispute Resolution:** "I never canceled that appointment" → audit trail needed
4. **Data Recovery:** Accidental deletions should be reversible
5. **Regulatory Compliance:** Some jurisdictions require data retention for X years
6. **Business Analytics:** Understanding customer churn and cancellation patterns

Hard deletes (physically removing data) satisfy GDPR deletion requests but break auditing and data recovery. Soft deletes preserve history but complicate GDPR compliance.

The decision balances:

- **Data Privacy** (right-to-be-forgotten)
- **Financial Integrity** (audit trails, historical accuracy)
- **Operational Clarity** (what data do we actually have?)
- **Query Performance** (filtering deleted rows on every query)
- **Storage Costs** (keeping deleted data indefinitely)

---

## Options Considered

### Option A: Soft Deletes with Logical Deletion ✓ CHOSEN

**Implementation:**
All tenant-scoped tables include `deleted_at TIMESTAMP NULL` column. When an entity is deleted, set `deleted_at = NOW()` instead of removing the row.

**Schema Example:**

```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  deleted_at TIMESTAMP NULL,  -- 🔑 Soft delete marker

  CONSTRAINT chk_tenant_dates CHECK (created_at <= updated_at)
);

-- Index for performance: queries filter on (tenant_id, deleted_at)
CREATE INDEX idx_customers_active
  ON customers(tenant_id)
  WHERE deleted_at IS NULL;
```

**Query Pattern:**

```typescript
// Default behavior: exclude soft-deleted rows
async findActiveCustomers(tenantId: string): Promise<Customer[]> {
  return await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        isNull(customers.deletedAt)  // 🔑 Filter out deleted
      )
    );
}

// Explicit query: include all rows (for auditing)
async findAllCustomers(tenantId: string, includeDeleted = false): Promise<Customer[]> {
  const conditions = [eq(customers.tenantId, tenantId)];
  if (!includeDeleted) {
    conditions.push(isNull(customers.deletedAt));
  }
  return await db.select().from(customers).where(and(...conditions));
}
```

**Deletion Semantics:**

```typescript
async deleteCustomer(tenantId: string, customerId: string): Promise<void> {
  // Mark as deleted, don't remove row
  await db.update(customers)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.id, customerId)
      )
    );

  // Invalidate cache
  await cache.invalidate(tenantId, 'customer', customerId);
}

// Recovery: restore deleted entity
async restoreCustomer(tenantId: string, customerId: string): Promise<void> {
  await db.update(customers)
    .set({ deletedAt: null })
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.id, customerId)
      )
    );
}
```

**Pros:**

- ✅ **Data Recovery:** Accidental deletions easily reversed (restore with UPDATE)
- ✅ **Audit Trail:** Complete history of all entities available for investigation
- ✅ **Financial Accuracy:** Booking history preserved for revenue reconciliation
- ✅ **Compliance Flexibility:** Can implement GDPR deletion via retention policy (delete after X years)
- ✅ **Customer Trust:** Users can recover deleted items (feature, not bug)
- ✅ **Dispute Resolution:** Full transaction history available for disputes
- ✅ **Analytics:** Understand churn, cancellations, patterns (deleted_at timestamp)
- ✅ **Simple Implementation:** Just add column and filter; no additional complexity

**Cons:**

- ❌ **GDPR Right-to-be-Forgotten:** Logical deletion doesn't satisfy "delete all traces" requirement
- ❌ **Storage Growth:** Soft-deleted rows accumulate over time (storage costs increase)
- ❌ **Query Complexity:** Every query must include `deleted_at` filter (boilerplate)
- ❌ **Index Overhead:** Indexes become less selective (more deleted rows mixed with active)
- ❌ **Database Size:** Soft-deleted data increases backup size and restore times
- ❌ **Retention Burden:** No automatic cleanup; must implement retention policies

---

### Option B: Hard Deletes (Physical Deletion)

**Implementation:**
When user deletes an entity, permanently remove the row from the database.

**Schema:**

```sql
CREATE TABLE customers (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
  -- No deleted_at column
);

-- Foreign key with ON DELETE CASCADE for related records
ALTER TABLE bookings
ADD CONSTRAINT fk_bookings_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
```

**Deletion:**

```typescript
async deleteCustomer(tenantId: string, customerId: string): Promise<void> {
  // Physically delete row
  await db.delete(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.id, customerId)
      )
    );
  // Cascade deletes related records (bookings, reviews, etc.)
}
```

**Pros:**

- ✅ **GDPR Compliant:** Satisfies right-to-be-forgotten (data physically removed)
- ✅ **Storage Efficient:** Deleted data doesn't accumulate; disk usage stays bounded
- ✅ **Index Health:** No soft-deleted rows cluttering indexes
- ✅ **Query Simplicity:** No need to filter `deleted_at` on every query
- ✅ **Database Performance:** Smaller tables, faster scans, smaller backups
- ✅ **Privacy:** Deleted personal data truly gone (satisfies privacy expectations)

**Cons:**

- ❌ **No Recovery:** Accidental deletions are permanent; no undo
- ❌ **Lost Audit Trail:** Historical data gone; can't investigate what happened
- ❌ **Financial Liability:** Booking history lost; can't reconcile revenue
- ❌ **Dispute Risk:** If customer disputes charge, no historical booking to reference
- ❌ **Cascade Risk:** ON DELETE CASCADE can accidentally delete related records (if cascade too broad)
- ❌ **Compliance Issues:** Auditors may require historical data retention
- ❌ **Analytics Loss:** Can't analyze churn patterns or cancellation trends

---

### Option C: Hybrid (Soft Delete + Retention Policy)

**Implementation:**
Use soft deletes for flexibility. After retention period (e.g., 7 years for financial data), physically hard-delete the soft-deleted rows.

**Architecture:**

```
User deletes customer → Set deleted_at = NOW()
                    ↓
            Soft-deleted row remains (active in system)
                    ↓
        Retention period = 7 years
                    ↓
    Scheduled job: Hard-delete rows where deleted_at < NOW() - 7 years
                    ↓
        Data permanently removed (GDPR + audit compliance)
```

**Retention Policy Configuration:**

```typescript
interface RetentionPolicy {
  entityType: string; // 'customer', 'booking', etc.
  retentionDays: number;
  requiresManualReview: boolean; // If true, require human approval before hard-delete
}

const RETENTION_POLICIES: RetentionPolicy[] = [
  {
    entityType: 'customer',
    retentionDays: 365 * 7,
    requiresManualReview: true,
  },
  {
    entityType: 'booking',
    retentionDays: 365 * 7,
    requiresManualReview: false,
  },
  { entityType: 'refund', retentionDays: 365 * 7, requiresManualReview: true },
  {
    entityType: 'loyaltyPoints',
    retentionDays: 365 * 3,
    requiresManualReview: false,
  },
];
```

**Hard-Delete Job (runs daily):**

```typescript
async hardDeleteExpiredSoftDeletes(): Promise<void> {
  for (const policy of RETENTION_POLICIES) {
    const cutoffDate = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000);

    if (policy.requiresManualReview) {
      // Flag for manual review; don't auto-delete
      await flagForReview(policy.entityType, cutoffDate);
    } else {
      // Auto-delete after retention period
      await hardDelete(policy.entityType, cutoffDate);
    }
  }
}
```

**Pros:**

- ✅ **Best of Both:** Short-term soft delete (recovery, audit) + long-term hard delete (GDPR, compliance)
- ✅ **GDPR Compliant:** Data physically deleted after retention period
- ✅ **Financial Integrity:** Audit trails preserved for reporting period
- ✅ **Dispute Resolution:** Historical data available for disputes
- ✅ **Privacy Respectful:** Customer data eventually purged (aligns with privacy expectations)
- ✅ **Flexible Retention:** Different retention periods for different entity types

**Cons:**

- ❌ **Complexity:** Manage both soft and hard deletes
- ❌ **Job Scheduling:** Requires background job infrastructure (cron, task queue)
- ❌ **Manual Review Overhead:** High-sensitivity data requires human approval (slower)
- ❌ **Storage Still Grows:** Soft-deleted data accumulates for years before hard-delete
- ❌ **Testing Complexity:** Must test both deletion flows

---

## Chosen Option

**Soft Deletes (Option A) with Planned Transition to Hybrid**

### Rationale for Initial Choice (Soft Deletes)

1. **MVP Stage:** Platform in growth phase; complexity of hybrid not justified yet
2. **Data Recovery Value:** Users appreciate being able to undo accidental deletions
3. **Financial Auditability:** Salon owners need booking history for revenue reconciliation
4. **Simple Implementation:** Soft deletes require minimal schema/code changes
5. **Reduced Risk:** No cascade deletion accidents possible
6. **Future Migration:** Can transition to hybrid after platform maturity

### Path to Hybrid (Soft + Retention)

As platform grows and regulatory requirements tighten, plan to migrate to hybrid model:

**Phase 1 (Current):** Soft deletes only (active for all)

**Phase 2 (Q4 2025):** Implement retention policies

- Add retention policy configuration
- Deploy hard-delete scheduled jobs
- Soft-deleted rows auto-deleted after policy period
- Manual review for high-sensitivity data

**Phase 3 (2026+):** GDPR acceleration

- Tenant can request immediate hard-delete
- On-demand hard-delete path for customer data
- Audit logging for all deletions (soft and hard)

---

## Trade-Offs

| Aspect                     | Soft Delete        | Hard Delete        | Hybrid                    |
| -------------------------- | ------------------ | ------------------ | ------------------------- |
| **GDPR Compliance**        | Weak (must retain) | Strong (immediate) | Strong (after retention)  |
| **Data Recovery**          | Excellent          | Impossible         | Excellent (short-term)    |
| **Audit Trail**            | Complete           | None               | Time-limited              |
| **Storage**                | Grows indefinitely | Bounded            | Bounded (after retention) |
| **Operational Complexity** | Low                | Low                | High                      |
| **Query Performance**      | Slight overhead    | No overhead        | Slight overhead           |
| **Financial Integrity**    | Excellent          | Poor               | Excellent                 |

---

## Consequences

### Positive Consequences

✅ **Customer Confidence:** Deleted items can be recovered (not lost forever).

✅ **Audit Trail:** Full history available for investigating disputes or issues.

✅ **Financial Accuracy:** Booking history preserved for revenue reconciliation.

✅ **Reversible Deletions:** Support can un-delete items if customer requests.

✅ **Analytics:** Understand cancellation patterns and customer churn via deleted_at.

✅ **Simple Implementation:** Just add column and filter; minimal code changes.

✅ **Low Risk:** No cascade deletion accidents; data never permanently lost.

### Negative Consequences

❌ **Storage Growth:** Soft-deleted rows accumulate indefinitely (cost per GB).

❌ **Query Overhead:** Every query must include `deleted_at IS NULL` filter.

❌ **Index Size:** Indexes include soft-deleted rows; less selective.

❌ **GDPR Tension:** Right-to-be-forgotten not satisfied (retention still required).

❌ **Backup Size:** Soft-deleted data increases backup size and restore time.

❌ **Maintenance Burden:** Must eventually implement hard-delete retention policy.

---

## Implementation Details

### Required Columns

All tenant-scoped tables must include:

```sql
created_at TIMESTAMP NOT NULL DEFAULT NOW(),
updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
deleted_at TIMESTAMP NULL
```

### Indexes for Performance

```sql
-- Optimize queries filtering on active rows
CREATE INDEX idx_customers_active
  ON customers(tenant_id, created_at)
  WHERE deleted_at IS NULL;

-- Optional: separate index if lookups by ID
CREATE INDEX idx_customers_active_by_id
  ON customers(tenant_id, id)
  WHERE deleted_at IS NULL;
```

### Query Helpers (TypeORM/Drizzle)

```typescript
// Scope queries to exclude soft-deleted
export const activeOnly = (table: any) => isNull(table.deletedAt);

// Usage:
db.select()
  .from(customers)
  .where(and(eq(customers.tenantId, tenantId), activeOnly(customers)));
```

### Cascading Soft Deletes

When a parent entity is soft-deleted, cascade to children:

```typescript
async deleteCustomer(tenantId: string, customerId: string): Promise<void> {
  // Delete customer
  await db.update(customers)
    .set({ deletedAt: new Date() })
    .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));

  // Cascade: soft-delete related bookings
  await db.update(bookings)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.customerId, customerId),
        isNull(bookings.deletedAt)  // Only if not already deleted
      )
    );

  // Cascade: soft-delete related reviews
  await db.update(reviews)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(reviews.tenantId, tenantId),
        eq(reviews.customerId, customerId),
        isNull(reviews.deletedAt)
      )
    );
}
```

---

## Enforcement Mechanisms

### 1. Repository Scope

All repository `find*` methods must filter deleted:

```typescript
// ❌ WRONG: No deleted filter
async findCustomer(customerId: string): Promise<Customer | null> {
  return await db.select().from(customers)
    .where(eq(customers.id, customerId))
    .first();
}

// ✅ CORRECT: Filters deleted
async findCustomer(tenantId: string, customerId: string): Promise<Customer | null> {
  return await db.select().from(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.id, customerId),
        isNull(customers.deletedAt)
      )
    )
    .first();
}
```

### 2. Code Review Checklist

- [ ] No soft-deleted rows returned in find queries
- [ ] Deleted rows properly cascaded
- [ ] Tests verify soft-delete behavior
- [ ] No raw SQL queries; use ORM

### 3. Automated Testing

```typescript
describe('Soft Delete Behavior', () => {
  it('should hide soft-deleted customers', async () => {
    const customer = await createCustomer(tenantId, { name: 'Alice' });
    await deleteCustomer(tenantId, customer.id);

    const found = await findCustomer(tenantId, customer.id);
    expect(found).toBeNull(); // Soft-deleted rows not returned
  });

  it('should allow restoring soft-deleted customers', async () => {
    const customer = await createCustomer(tenantId, { name: 'Alice' });
    await deleteCustomer(tenantId, customer.id);
    await restoreCustomer(tenantId, customer.id);

    const restored = await findCustomer(tenantId, customer.id);
    expect(restored).toEqual(customer);
  });
});
```

---

## Migration Path: Soft Deletes → Hybrid (Soft + Retention)

**Phase 1 - Retention Policy Infrastructure (1 sprint)**

- Add retention policy configuration
- Deploy retention job scheduler
- Implement hard-delete queries

**Phase 2 - Pilot Retention (1 sprint)**

- Test retention policies on non-critical data (e.g., audit logs)
- Verify hard-delete queries work correctly
- Monitor job performance

**Phase 3 - Full Rollout (1 sprint)**

- Enable retention for all entity types
- Set initial retention periods (5-7 years for most data)
- Communicate GDPR deletion timeline to users

**Estimated Effort:** 3 sprints

---

## Decision Log

**Approved by:** Architecture Review Board
**Approved Date:** 2025-05-10
**Implementation Started:** Q2 2025
**Review Date:** Q4 2025 (transition to hybrid)
**Related Issues:** DATA-0001, GDPR-0001
**Related ADRs:** ADR-001 (Shared Schema), ADR-002 (Row Filtering)

---

## References

- [SOFT_DELETE_STRATEGY.md](../04-database-design/SOFT_DELETE_STRATEGY.md)
- GDPR Right-to-be-Forgotten: Articles 17-18
- OWASP: Data Retention and Sanitization
- Best Practices: Audit Logging for Compliance
