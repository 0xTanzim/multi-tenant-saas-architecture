# Migration Strategy: Zero-Downtime Schema Changes

## Table of Contents

1. [Overview](#overview)
2. [Zero-Downtime Migration Principles](#zero-downtime-migration-principles)
3. [Migration Categories](#migration-categories)
4. [Migration Checklist](#migration-checklist)
5. [Real-World Migration Patterns](#real-world-migration-patterns)
6. [Backward Compatibility](#backward-compatibility)
7. [Testing Migrations](#testing-migrations)
8. [Rollback Procedures](#rollback-procedures)

---

## Overview

In a production multi-tenant system, **downtime is unacceptable**. Migrations must be:

- **Zero-Downtime**: The application keeps running while schema changes
- **Backward Compatible**: Old and new code work with both old and new schema
- **Reversible**: If something goes wrong, rollback is quick and safe
- **Tested**: Every migration is tested before production deployment
- **Incremental**: Large changes are broken into multiple small migrations

**Key Principle**:

> The database and application code have different release cycles. Both old and new code must work with both old and new schema for a short transition period.

---

## Zero-Downtime Migration Principles

### 1. Expand Then Contract Pattern

**Problem**: You can't rename a column while the application uses the old name.

**Solution**: Three-phase approach:

```
Phase 1: EXPAND    — Add new column (old code keeps working)
Phase 2: MIGRATE   — Application code switches to new column
Phase 3: CONTRACT  — Remove old column (new code doesn't need it)
```

### Example: Rename `booking_status` → `status`

**Phase 1: Add new column (database change)**

```sql
ALTER TABLE bookings ADD COLUMN status VARCHAR(20);
-- Old code: still uses booking_status
-- New code: can use status
-- Both work!
```

**Phase 2: Migrate data and deploy new code**

```sql
UPDATE bookings SET status = booking_status WHERE status IS NULL;
-- Deploy new application code that uses status
```

**Phase 3: Remove old column (database cleanup)**

```sql
ALTER TABLE bookings DROP COLUMN booking_status;
-- Old code is gone, no one uses booking_status anymore
```

### 2. Add, Never Remove (During Transition)

```sql
-- ✅ SAFE: Adding always works
ALTER TABLE bookings ADD COLUMN new_field VARCHAR(100);

-- ❌ UNSAFE: Removing before code stops using it
ALTER TABLE bookings DROP COLUMN old_field;
```

### 3. Create Index Separately

```sql
-- ❌ DON'T: Index creation during ALTER TABLE
ALTER TABLE bookings ADD COLUMN tenant_id INTEGER;
ALTER TABLE bookings ADD INDEX idx_tenant (tenant_id);
-- Locks the table during index creation

-- ✅ DO: Create index separately (doesn't lock)
CREATE INDEX CONCURRENTLY idx_bookings_tenant ON bookings(tenant_id);
-- In PostgreSQL, CONCURRENTLY allows reads during index creation
```

---

## Migration Categories

### 1. Safe Migrations (No Risk)

| Change                             | Safe?    | Why                                      |
| ---------------------------------- | -------- | ---------------------------------------- |
| Add column with DEFAULT            | ✅ Yes   | Doesn't affect existing rows immediately |
| Add column with NOT NULL + DEFAULT | ✅ Yes   | Default fills existing rows              |
| Add index (CONCURRENTLY)           | ✅ Yes   | No schema change, just query performance |
| Add NOT NULL column after filling  | ✅ Yes   | All rows have values first               |
| Change column size (255 → 500)     | ✅ Yes   | Existing data fits in new size           |
| Add CHECK constraint               | ⚠️ Maybe | If existing data violates it, fails      |

### 2. Risky Migrations (Requires Planning)

| Change                       | Risk   | Mitigation                                         |
| ---------------------------- | ------ | -------------------------------------------------- |
| Remove column                | HIGH   | Use expand-contract pattern                        |
| Rename column                | HIGH   | Add new, update code, drop old                     |
| Change column type           | MEDIUM | Backfill in steps, test thoroughly                 |
| Add NOT NULL without DEFAULT | HIGH   | Add column nullable first, backfill, then NOT NULL |
| Change unique constraint     | HIGH   | Add new constraint, drop old carefully             |

---

## Migration Checklist

Use this checklist for every migration:

### Pre-Migration

- [ ] Migration has a clear name: `add_deleted_at_column` (not `fix_db`)
- [ ] Migration is small and focused (one logical change)
- [ ] All migrations are run in order (migrations are sequential)
- [ ] Backward compatibility reviewed (old code still works)
- [ ] Data backups in place before running
- [ ] Tested on staging environment with production-like data
- [ ] Estimated runtime calculated (avoid long-running migrations)

### Migration Design

- [ ] No locks that block reads for >1s
- [ ] Index creation uses CONCURRENTLY
- [ ] Backfilling data is in batches (not all at once)
- [ ] New code is ready but behind feature flag
- [ ] Rollback procedure is documented
- [ ] All team members know about the migration

### Running Migration

- [ ] Monitoring is enabled (watch database load)
- [ ] Application logs are checked for errors
- [ ] Few users affected initially (not peak hours)
- [ ] Can be rolled back immediately if issues
- [ ] Plan for ~20% longer than estimated time

### Post-Migration

- [ ] Verify migration ran successfully
- [ ] Check application is working
- [ ] Confirm new data is being created correctly
- [ ] Remove old code/columns after sufficient time
- [ ] Update documentation

---

## Real-World Migration Patterns

### Pattern 1: Add Soft Delete Column

**Scenario**: Add `deleted_at` to an existing table.

**Step 1: Add Column (Safe)**

```sql
ALTER TABLE customers
ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;

-- Execution: ~100ms
-- Impact: None, all rows have NULL for deleted_at
-- Old code: Still works (doesn't use deleted_at)
-- New code: Can check deleted_at (NULL = active)
```

**Step 2: Deploy New Code**

- New code: Always filters with `deleted_at IS NULL`
- New code: Uses soft delete instead of hard delete
- Old code: Still doesn't check deleted_at (returns both)

**Step 3: Add Index (Optional but Recommended)**

```sql
CREATE INDEX CONCURRENTLY idx_customers_active
ON customers(tenant_id)
WHERE deleted_at IS NULL;

-- Execution: ~5-10s (doesn't lock reads)
-- Speeds up: SELECT * FROM customers WHERE tenant_id = 1 AND deleted_at IS NULL
```

**Step 4: No Cleanup Needed**

- The `deleted_at` column stays forever
- It's part of the schema now

### Pattern 2: Add New Required Column

**Scenario**: Add `currency` column with values USD, EUR, GBP.

**Step 1: Add Optional Column**

```sql
ALTER TABLE invoices
ADD COLUMN currency VARCHAR(3);

-- All rows have NULL for currency
-- Old code: Ignores it
-- New code: Can read/write it
```

**Step 2: Backfill Data (Carefully)**

```sql
-- For existing data, use a sensible default
UPDATE invoices
SET currency = 'USD'
WHERE currency IS NULL
  AND created_at < NOW() - INTERVAL '1 hour';
-- Batch updates to avoid locking

-- Run multiple times until no rows have NULL:
-- UPDATE invoices SET currency = 'USD' WHERE currency IS NULL LIMIT 10000;
-- UPDATE invoices SET currency = 'USD' WHERE currency IS NULL LIMIT 10000;
-- ... (repeat until all rows filled)
```

**Step 3: Add NOT NULL Constraint**

```sql
ALTER TABLE invoices
ALTER COLUMN currency SET NOT NULL;

-- Now: currency is guaranteed to have a value
-- New code: Must provide currency when creating invoices
```

**Step 4: Deploy Code**

- Code now always provides `currency` on insert
- Old code can be removed (was using defaults)

### Pattern 3: Create Composite Index for Performance

**Scenario**: Booking queries are slow. Need index on `(tenant_id, status, booking_date)`.

```sql
-- Use CONCURRENTLY to avoid locking reads
CREATE INDEX CONCURRENTLY idx_bookings_tenant_status_date
ON bookings(tenant_id, status, booking_date)
WHERE deleted_at IS NULL;

-- Execution: ~10s (doesn't lock table)
-- Queries now use the index automatically
-- No code change needed
```

### Pattern 4: Change Column Type

**Scenario**: Change `phone` from VARCHAR(20) to VARCHAR(50).

**Safe Approach** (for most type expansions):

```sql
-- Step 1: Check how many characters used
SELECT MAX(LENGTH(phone)) FROM customers;

-- Step 2: Expand safely
ALTER TABLE customers
ALTER COLUMN phone SET DATA TYPE VARCHAR(50);
-- PostgreSQL handles this safely (expanding size)

-- Execution: ~50ms
-- No rewrite needed if just expanding
```

**For Type Conversion** (e.g., TEXT to BIGINT):

```sql
-- Step 1: Add new column
ALTER TABLE orders ADD COLUMN order_number_new BIGINT;

-- Step 2: Backfill with conversion
UPDATE orders
SET order_number_new = order_number::BIGINT
WHERE order_number_new IS NULL;

-- Step 3: Verify data converted correctly
SELECT COUNT(*) FROM orders
WHERE order_number::BIGINT != order_number_new;
-- Should return 0

-- Step 4: Drop old column (in later migration)
ALTER TABLE orders DROP COLUMN order_number;
```

### Pattern 5: Add Foreign Key Constraint

**Scenario**: Add `fk_customers_tenant` constraint.

```sql
-- Step 1: Check data integrity first
SELECT COUNT(*) FROM customers
WHERE tenant_id IS NULL OR tenant_id NOT IN (SELECT id FROM tenants);
-- Should return 0, if not: fix data first

-- Step 2: Add constraint
ALTER TABLE customers
ADD CONSTRAINT fk_customers_tenant
FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- Execution: ~1-2s (validates existing data)
-- All future rows must follow the constraint
```

---

## Backward Compatibility

### The Three-Code Scenario

At any point, three versions of code might run:

```
Code v1.0 (old)     — Uses old schema (phone, booking_status)
Code v1.1 (current) — Uses both old + new schema (phone, phone_new, status)
Code v1.2 (new)     — Uses new schema only (phone_new, status)
```

**During transition**, all three must work:

```typescript
// v1.0 code (deprecated, being phased out)
customer.phone = '123-456-7890';

// v1.1 code (handles both old and new)
const phone = customer.phone_new ?? customer.phone;
customer.phone_new = formatPhone(value);
customer.phone = formatPhone(value); // Backfill old column

// v1.2 code (new standard)
const phone = customer.phone_new;
// Never touches customer.phone
```

### Feature Flags for Safe Rollout

```typescript
// New migration deployed, but code uses feature flag
const USE_SOFT_DELETE = process.env.FEATURE_SOFT_DELETE === 'true';

// Old delete: hard delete (removes forever)
if (!USE_SOFT_DELETE) {
  await db.delete(customers).where(eq(customers.id, 42));
}

// New delete: soft delete (marks deleted_at)
if (USE_SOFT_DELETE) {
  await db
    .update(customers)
    .set({ deleted_at: new Date() })
    .where(eq(customers.id, 42));
}
```

**Rollout strategy**:

1. Deploy code with flag disabled → Old behavior
2. Deploy migration → New column exists
3. Enable flag for 1% of requests → Test new behavior
4. Increase flag to 25%, 50%, 100% → Monitor for issues
5. Disable flag → If major issue found, disable and rollback

---

## Testing Migrations

### Local Testing

```bash
# Run migration on local database
pnpm db:migrate

# Test old code works with new schema
pnpm test

# Test new code works
git checkout feature/soft-delete
pnpm test
```

### Staging Environment

```bash
# 1. Run migration on staging (with production data copy)
pnpm db:migrate --env staging

# 2. Deploy old code to staging → verify works
npm start --env staging

# 3. Deploy new code to staging → verify works
npm start --env staging

# 4. Run integration tests
pnpm test:integration --env staging

# 5. Check performance
# - Query execution time
# - Index usage (EXPLAIN ANALYZE)
# - Database load
```

### Production Dry Run

```bash
# 1. Backup production database
pg_dump production_db > backup.sql

# 2. Restore backup to staging
psql staging_db < backup.sql

# 3. Run migration on staging copy
pnpm db:migrate --env staging

# 4. Test thoroughly (see staging testing above)

# 5. Estimate migration time
# - Time to run migration: X seconds
# - Estimate 2-3x for production load
```

---

## Rollback Procedures

### Scenario 1: Quick Rollback (During/Immediately After)

**If migration causes immediate issues**:

```bash
# 1. Stop application (prevent new queries on new schema)
kubectl scale deployment api --replicas=0

# 2. Rollback last migration
pnpm db:migrate:down

# 3. Restart application with previous code
git checkout HEAD~1
npm start

# Investigate issue, fix it, try again
```

### Scenario 2: Data-Safe Rollback (After Transition)

**If issues found after migration was successful**:

```sql
-- Migration: Added currency column
-- Rollback: Restore old behavior without dropping column

-- Step 1: Restore old defaults
UPDATE invoices
SET currency = 'USD'
WHERE currency IS NULL;

-- Step 2: Keep column (don't drop yet)
-- Code switches back to not using currency

-- Step 3: Later (after several weeks), drop if still not needed
ALTER TABLE invoices DROP COLUMN currency;
```

### Scenario 3: Restore from Backup

**If data was corrupted**:

```bash
# 1. Take a snapshot of corrupted state for investigation
pg_dump production_db > corrupted_backup.sql

# 2. Restore from last known good backup
# (backups should be taken before every migration)
pg_restore production_db < backup_before_migration.sql

# 3. Rerun migration with fixes
pnpm db:migrate

# 4. Investigate what went wrong
```

---

## Migration Tools

### Drizzle ORM Migrations

```typescript
// packages/db/src/migrations/0001_add_deleted_at.ts
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pg-core/migration';

export async function up(db: Database) {
  // Forward migration
  await db.schema.raw(sql`
    ALTER TABLE customers
    ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
  `);

  await db.schema.raw(sql`
    CREATE INDEX CONCURRENTLY idx_customers_active
    ON customers(tenant_id)
    WHERE deleted_at IS NULL;
  `);
}

export async function down(db: Database) {
  // Rollback migration
  await db.schema.raw(sql`
    DROP INDEX CONCURRENTLY idx_customers_active;
  `);

  await db.schema.raw(sql`
    ALTER TABLE customers
    DROP COLUMN deleted_at;
  `);
}
```

### Running Migrations

```bash
# Apply all pending migrations
pnpm db:migrate

# Rollback last migration
pnpm db:migrate:down

# Show current migration status
pnpm db:migrate:status

# Run specific migration
pnpm db:migrate:one 0001_add_deleted_at
```

---

## Summary

**Key Takeaways**:

1. **Use expand-contract pattern** — Add, migrate code, remove (3 phases)
2. **Test on production data** — Staging should mirror production schema/size
3. **Create indexes concurrently** — Doesn't lock table for reads
4. **Batch backfill updates** — Avoid locking entire table
5. **Have rollback plan** — Before every migration
6. **Monitor closely** — First 30 minutes are critical
7. **Document everything** — Future you will thank you

**Checklist Before Every Migration**:

- [ ] Backward compatible (old code still works)
- [ ] Tested on staging with production data
- [ ] Rollback procedure documented
- [ ] Team knows about it
- [ ] Monitoring enabled
- [ ] Estimated runtime calculated

---

## Next Steps

- Review [Schema Design Patterns](./SCHEMA_DESIGN_PATTERNS.md)
- See [Tenant-Scoped Queries](./TENANT_SCOPED_QUERIES.md) for query patterns
- Check code examples: [SQL Examples](./code-examples/sql/)
