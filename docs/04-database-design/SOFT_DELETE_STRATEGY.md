# Soft Delete Strategy: Preserving Data History and Audit Trails

## Table of Contents

1. [Why Soft Deletes?](#why-soft-deletes)
2. [Implementation](#implementation)
3. [The deleted_at Column](#the-deleted_at-column)
4. [Filtering Deleted Records in Queries](#filtering-deleted-records-in-queries)
5. [Recovery and Restore Procedures](#recovery-and-restore-procedures)
6. [Audit Trail Implications](#audit-trail-implications)
7. [Performance Considerations](#performance-considerations)
8. [Best Practices](#best-practices)

---

## Why Soft Deletes?

### The Problem with Hard Deletes

**Hard delete** (permanent removal):

```sql
DELETE FROM bookings WHERE id = 42;
```

**Consequences**:

- Data is gone forever — no way to recover
- Breaks referential integrity if other records depend on it
- Violates audit trail requirements (GDPR, compliance)
- Angry customers: "Where did my booking go?"
- Regulatory issues: Data retention laws require audit trails

### The Solution: Soft Deletes

**Soft delete** (logical deletion with preservation):

```sql
UPDATE bookings SET deleted_at = NOW() WHERE id = 42;
-- Data still exists in the database, just marked as deleted
```

**Benefits**:

- ✅ Data preserved for audit trails and recovery
- ✅ Supports regulatory compliance (GDPR, HIPAA, etc.)
- ✅ Enables data restoration
- ✅ Maintains historical records
- ✅ Supports analytics on "deleted" data
- ✅ No breaking changes to foreign key relationships

---

## Implementation

### Step 1: Add the deleted_at Column

In your Drizzle ORM schema:

```typescript
import { pgTable, serial, varchar, timestamp } from 'drizzle-orm/pg-core';

export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  tenant_id: integer('tenant_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),

  // Soft Delete Column
  deleted_at: timestamp('deleted_at', { withTimezone: true }),

  // Audit Trail
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
```

**Key Points**:

- `deleted_at` is `NULL` by default (record is active)
- `deleted_at` is set to a timestamp when deleted
- `deleted_at` is `NULLABLE` (allows both states)

### Step 2: Database Migration

If adding soft delete to an existing table:

```sql
-- Add the column (non-breaking, all existing records have NULL)
ALTER TABLE customers ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;

-- No data loss, no schema changes needed
-- All existing records are considered "active" (deleted_at IS NULL)
```

### Step 3: Create Soft Delete Function (Optional but Recommended)

Instead of `DELETE`, use an update function:

```sql
-- Create a function to safely soft-delete a record
CREATE FUNCTION soft_delete_customer(
  p_customer_id INTEGER,
  p_tenant_id INTEGER
) RETURNS VOID AS $$
BEGIN
  UPDATE customers
  SET deleted_at = NOW()
  WHERE id = p_customer_id
    AND tenant_id = p_tenant_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found or already deleted';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Usage
SELECT soft_delete_customer(42, 1);
```

**Why**: Centralizes delete logic, adds validation, prevents accidental hard deletes.

---

## The deleted_at Column

### Schema Pattern

```sql
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  booking_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL,

  -- SOFT DELETE COLUMN
  deleted_at TIMESTAMP WITH TIME ZONE,  -- NULL = active, NOT NULL = deleted

  -- AUDIT TRAIL
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
```

### Lifecycle

**State Transitions**:

```
Created (deleted_at IS NULL)
         ↓
Active (used, modified, visible in queries)
         ↓
Deleted (deleted_at = timestamp)
         ↓
Restored (deleted_at SET TO NULL)
```

**Example Timeline**:

| Time             | deleted_at          | Status        |
| ---------------- | ------------------- | ------------- |
| 2026-05-01 10:00 | NULL                | Created       |
| 2026-05-05 14:30 | NULL                | Active (used) |
| 2026-05-10 09:00 | 2026-05-10 09:00:00 | Deleted       |
| 2026-05-15 11:00 | NULL                | Restored      |

---

## Filtering Deleted Records in Queries

### The Golden Rule

> **Always filter out deleted records unless explicitly restoring them.**

### Pattern 1: Standard Query (Exclude Deleted)

```sql
-- CORRECT: Only returns active records
SELECT * FROM customers
WHERE tenant_id = 1
  AND deleted_at IS NULL;

-- WRONG: Includes deleted records
SELECT * FROM customers
WHERE tenant_id = 1;
```

### Pattern 2: Include Both Active and Deleted

```sql
-- For auditing: show all records, deleted or not
SELECT
  id,
  name,
  email,
  deleted_at,
  CASE
    WHEN deleted_at IS NULL THEN 'Active'
    ELSE 'Deleted'
  END AS status
FROM customers
WHERE tenant_id = 1
ORDER BY created_at DESC;
```

### Pattern 3: Only Deleted Records

```sql
-- For recovery: find all deleted records from the last 30 days
SELECT * FROM bookings
WHERE tenant_id = 1
  AND deleted_at IS NOT NULL
  AND deleted_at >= NOW() - INTERVAL '30 days'
ORDER BY deleted_at DESC;
```

### Drizzle ORM Patterns

```typescript
import { eq, isNull, and, isNotNull } from 'drizzle-orm';

// Pattern 1: Exclude deleted records (most common)
async function getActiveCustomers(tenantId: number) {
  return db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.tenant_id, tenantId),
        isNull(customers.deleted_at) // ← Filter out deleted
      )
    );
}

// Pattern 2: Only deleted records
async function getDeletedCustomers(tenantId: number) {
  return db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.tenant_id, tenantId),
        isNotNull(customers.deleted_at) // ← Only show deleted
      )
    )
    .orderBy(desc(customers.deleted_at));
}

// Pattern 3: Include both (with status indicator)
async function getAllCustomersWithStatus(tenantId: number) {
  return db
    .select({
      id: customers.id,
      name: customers.name,
      deleted_at: customers.deleted_at,
      status: sql`CASE WHEN ${isNull(
        customers.deleted_at
      )} THEN 'Active' ELSE 'Deleted' END`,
    })
    .from(customers)
    .where(eq(customers.tenant_id, tenantId));
}
```

### Index with WHERE Clause

Speed up queries by using **partial indexes** that exclude deleted records:

```sql
-- Index only active customers (much smaller, faster)
CREATE INDEX idx_customers_active
  ON customers(tenant_id, email)
  WHERE deleted_at IS NULL;

-- Queries that filter by deleted_at IS NULL use this index
SELECT * FROM customers
WHERE tenant_id = 1 AND deleted_at IS NULL;  -- ← Uses the index
```

---

## Recovery and Restore Procedures

### Scenario 1: User Accidentally Deletes a Booking

**Recovery**:

```sql
-- Step 1: Find the deleted record
SELECT id, customer_id, booking_date, deleted_at
FROM bookings
WHERE tenant_id = 1
  AND id = 42
  AND deleted_at IS NOT NULL;

-- Result:
-- id  | customer_id | booking_date | deleted_at
-- 42  | 100         | 2026-05-15   | 2026-05-10 09:00:00

-- Step 2: Restore it (set deleted_at to NULL)
UPDATE bookings
SET deleted_at = NULL
WHERE id = 42
  AND tenant_id = 1;

-- Step 3: Verify
SELECT * FROM bookings WHERE id = 42;
-- booking is now active again
```

### Scenario 2: Bulk Restore After Accidental Mass Delete

```sql
-- Find all bookings deleted in the last hour
SELECT COUNT(*) FROM bookings
WHERE tenant_id = 1
  AND deleted_at >= NOW() - INTERVAL '1 hour'
  AND deleted_at IS NOT NULL;

-- If safe to restore, restore them all
UPDATE bookings
SET deleted_at = NULL
WHERE tenant_id = 1
  AND deleted_at >= NOW() - INTERVAL '1 hour'
  AND deleted_at IS NOT NULL;

-- Verify
SELECT COUNT(*) FROM bookings WHERE tenant_id = 1 AND deleted_at IS NULL;
```

### Scenario 3: Permanent Deletion (After Retention Period)

Some regulations require permanent deletion after a retention period (e.g., GDPR right to be forgotten).

```sql
-- Hard delete records that have been soft-deleted for 7 years
DELETE FROM bookings
WHERE tenant_id = 1
  AND deleted_at IS NOT NULL
  AND deleted_at < NOW() - INTERVAL '7 years';

-- Safety measure: wrap in transaction
BEGIN;
  DELETE FROM bookings
  WHERE tenant_id = 1
    AND deleted_at IS NOT NULL
    AND deleted_at < NOW() - INTERVAL '7 years';

  -- If something goes wrong, ROLLBACK
COMMIT;
```

---

## Audit Trail Implications

### Tracking Who Deleted What

Enhance soft deletes with audit information:

```sql
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  -- ... other fields ...

  deleted_at TIMESTAMP WITH TIME ZONE,
  deleted_by_user_id INTEGER,  -- Who deleted it
  deletion_reason VARCHAR(255),  -- Why was it deleted

  FOREIGN KEY (deleted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- When deleting, record the user and reason
UPDATE bookings
SET deleted_at = NOW(),
    deleted_by_user_id = 123,
    deletion_reason = 'Customer requested cancellation'
WHERE id = 42
  AND tenant_id = 1;
```

### Audit Log Entry

```sql
-- Create a complete audit trail for soft deletes
INSERT INTO audit_log (
  tenant_id,
  table_name,
  record_id,
  action,
  user_id,
  old_values,
  new_values,
  created_at
) VALUES (
  1,
  'bookings',
  42,
  'DELETE',
  123,
  '{"deleted_at": null}',
  '{"deleted_at": "2026-05-10T09:00:00Z"}',
  NOW()
);
```

### Query Audit Trail

```sql
-- View deletion history
SELECT
  id,
  table_name,
  record_id,
  action,
  u.name AS deleted_by,
  new_values -> 'deleted_at' AS deletion_time,
  created_at
FROM audit_log al
LEFT JOIN users u ON al.user_id = u.id
WHERE al.table_name = 'bookings'
  AND al.action = 'DELETE'
  AND al.tenant_id = 1
ORDER BY al.created_at DESC;
```

---

## Performance Considerations

### Index Strategy

1. **Create partial indexes to exclude deleted records**:

```sql
-- Fast for common queries (get active records)
CREATE INDEX idx_bookings_active
  ON bookings(tenant_id, status, booking_date)
  WHERE deleted_at IS NULL;

-- Slower but comprehensive for rare recovery queries
CREATE INDEX idx_bookings_deleted
  ON bookings(tenant_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
```

2. **Composite indexes with tenant_id first**:

```sql
-- ✅ CORRECT
CREATE INDEX idx_bookings_search
  ON bookings(tenant_id, customer_id, booking_date)
  WHERE deleted_at IS NULL;

-- ❌ WRONG
CREATE INDEX idx_bookings_search
  ON bookings(customer_id, booking_date)
  WHERE deleted_at IS NULL;
```

### Storage Impact

Soft deletes consume storage because deleted records remain in the table.

**Mitigation**:

- Use table partitioning for large tables
- Archive old soft-deleted records to a separate schema
- Periodically hard-delete records older than retention period

### Query Performance

Adding `deleted_at IS NULL` to every query adds minimal overhead if indexed:

```
Index Scan Cost: 0.1ms (with index)
Sequential Scan Cost: 100ms (without index)
```

Always ensure `deleted_at IS NULL` is in your index definition.

---

## Best Practices

### 1. Never Hard Delete (Use Soft Delete Instead)

```typescript
// ❌ WRONG: Permanent deletion
await db.delete(customers).where(eq(customers.id, 42));

// ✅ CORRECT: Soft delete
await db
  .update(customers)
  .set({ deleted_at: new Date() })
  .where(eq(customers.id, 42));
```

### 2. Always Filter by deleted_at in Queries

```typescript
// ❌ WRONG: Returns deleted records too
const customer = await db.select().from(customers).where(eq(customers.id, 42));

// ✅ CORRECT: Filters out deleted
const customer = await db
  .select()
  .from(customers)
  .where(and(eq(customers.id, 42), isNull(customers.deleted_at)));
```

### 3. Create Reusable Query Helpers

```typescript
// Base query that always includes tenant_id and deleted_at filter
async function getBookingsByTenant(tenantId: number) {
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.tenant_id, tenantId),
        isNull(bookings.deleted_at) // ← Always included
      )
    );
}

// Other queries build on this foundation
async function getBookingsForCustomer(tenantId: number, customerId: number) {
  return getBookingsByTenant(tenantId).where(
    eq(bookings.customer_id, customerId)
  );
}
```

### 4. Document Soft Delete in Schema

```typescript
// Add JSDoc comment explaining soft delete
export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  tenant_id: integer('tenant_id').notNull(),

  /**
   * Soft delete timestamp.
   * When NULL: record is active
   * When not NULL: record is logically deleted but preserved for audit trail
   * Always filter with: WHERE deleted_at IS NULL
   */
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
});
```

### 5. Provide Recovery Tools

Create a utility for safe restoration:

```typescript
async function restoreSoftDeletedRecord(
  table: string,
  recordId: number,
  tenantId: number,
  restoredByUserId: number
) {
  // Log the restoration
  await db.insert(audit_log).values({
    tenant_id: tenantId,
    table_name: table,
    record_id: recordId,
    action: 'RESTORE',
    user_id: restoredByUserId,
    created_at: new Date(),
  });

  // Restore the record
  await db
    .update(bookings)
    .set({ deleted_at: null })
    .where(and(eq(bookings.id, recordId), eq(bookings.tenant_id, tenantId)));

  return { success: true };
}
```

---

## Summary

**Key Takeaways**:

1. **Soft deletes preserve data** — Use them instead of hard deletes
2. **Always filter with `deleted_at IS NULL`** — In every query
3. **Create partial indexes** — On `(tenant_id, ...) WHERE deleted_at IS NULL`
4. **Support recovery** — Build tools to restore deleted records
5. **Audit soft deletes** — Log who deleted what and why
6. **Handle compliance** — Implement hard deletion after retention period

---

## Next Steps

- Review [Tenant-Scoped Queries](./TENANT_SCOPED_QUERIES.md) for query patterns
- See [Migration Strategy](./MIGRATION_STRATEGY.md) for schema evolution
- Check code examples: [SQL Examples](./code-examples/sql/)
