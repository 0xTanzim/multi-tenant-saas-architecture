# Database Migrations Strategy for Multi-Tenant Systems

This document outlines zero-downtime migration strategies, backward compatibility guidelines, and rollback procedures for multi-tenant databases serving continuous production traffic.

## Table of Contents

1. [Migration Philosophy](#migration-philosophy)
2. [Zero-Downtime Migration Patterns](#zero-downtime-migration-patterns)
3. [Backward Compatibility Checklist](#backward-compatibility-checklist)
4. [Schema Versioning](#schema-versioning)
5. [Staging Environment Testing](#staging-environment-testing)
6. [Rollback Procedures](#rollback-procedures)
7. [Data Migration Strategies](#data-migration-strategies)
8. [Monitoring During Migrations](#monitoring-during-migrations)

---

## Migration Philosophy

### Core Principles

1. **Zero Downtime**: Migrations must not interrupt active requests from any tenant
2. **Reversibility**: Every migration must have a documented rollback path
3. **Backward Compatibility**: New versions must coexist with old code during deployment windows
4. **Tenant Isolation**: No tenant data exposed during migration process
5. **Verification**: All migrations tested in staging before production deployment

### The Dual-Deploy Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                    Old Code (v1.0.0)                             │
│  Deployed on all instances, handling all tenant requests         │
│  Uses old schema, reads/writes compatible with new schema        │
└─────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────┐
│                    DB Migration Runs                              │
│  - Adds new column with DEFAULT                                  │
│  - Creates new indexes (CONCURRENTLY if needed)                 │
│  - Migrates existing data (if needed)                            │
│  - Old code still works (uses DEFAULTs for new columns)          │
└─────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────┐
│                    New Code (v1.0.1)                              │
│  Deployed incrementally (rolling deployment)                     │
│  Uses new schema, reads old data with backward compat queries    │
│  Old code continues running in parallel                          │
└─────────────────────────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────────────────────────┐
│              All Instances Running New Code                       │
│  Old schema columns deprecated (removal in v1.1.0 if needed)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Zero-Downtime Migration Patterns

### Pattern 1: Adding Columns

**Bad** (causes downtime):

```sql
ALTER TABLE bookings ADD COLUMN notes TEXT NOT NULL;
```

Problem: Default value required for existing rows, migration blocks writes during large table operations.

**Good** (zero-downtime):

```sql
-- Step 1: Add column with default (non-blocking in PostgreSQL)
ALTER TABLE bookings ADD COLUMN notes TEXT DEFAULT '';

-- Step 2: Deploy new code that reads/writes the column
-- (old code ignores the column, new code uses it)

-- Step 3: [Optional] Populate existing rows asynchronously
UPDATE bookings SET notes = '' WHERE notes IS NULL;

-- Step 4: Remove default if no longer needed (next migration)
ALTER TABLE bookings ALTER COLUMN notes DROP DEFAULT;
```

**Code Pattern** (backward compatible):

```typescript
// Service: works with or without notes column
export class BookingService {
  async getBooking(bookingId: string, tenantId: string) {
    // Query explicitly selects columns, gracefully handles missing notes
    const booking = await db.query(
      `SELECT id, user_id, status, notes FROM bookings
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [bookingId, tenantId]
    );

    return {
      ...booking,
      notes: booking.notes || '', // Default if missing
    };
  }

  async updateBooking(bookingId: string, data: UpdateBookingDto) {
    // Only update notes if provided
    const updates: Record<string, any> = {};
    if ('notes' in data) {
      updates.notes = data.notes;
    }

    return db.query(
      `UPDATE bookings SET ${Object.keys(updates)
        .map((k) => `${k} = ?`)
        .join(', ')}
       WHERE id = ? AND tenant_id = ?`,
      [...Object.values(updates), bookingId, data.tenantId]
    );
  }
}
```

### Pattern 2: Renaming Columns

**Approach** (graceful rename):

```sql
-- Step 1: Create new column
ALTER TABLE bookings ADD COLUMN phone_number_new VARCHAR(20);

-- Step 2: Copy data
UPDATE bookings SET phone_number_new = phone_number;

-- Step 3: Deploy code that writes to both columns (read from new column with fallback)
-- Code example below

-- Step 4: Remove old column
ALTER TABLE bookings DROP COLUMN phone_number;

-- Step 5: Rename new column
ALTER TABLE bookings RENAME COLUMN phone_number_new TO phone_number;
```

**Code During Transition**:

```typescript
// Read from new column first, fall back to old
const phoneNumber = booking.phone_number_new || booking.phone_number;

// Write to both columns
await db.query(
  `UPDATE bookings SET
    phone_number = ?,
    phone_number_new = ?
   WHERE id = ? AND tenant_id = ?`,
  [newPhone, newPhone, bookingId, tenantId]
);
```

### Pattern 3: Adding Indexes

**PostgreSQL CONCURRENTLY** (non-blocking):

```sql
-- Does NOT block writes to bookings table
CREATE INDEX CONCURRENTLY idx_bookings_tenant_status
ON bookings(tenant_id, status);

-- Can run during production traffic
-- But takes longer than regular CREATE INDEX
```

**Timing Consideration**:

```bash
# Check if index exists (in migration, skip if present)
SELECT 1 FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'bookings'
  AND indexname = 'idx_bookings_tenant_status';
```

### Pattern 4: Data Type Changes

**Integer to Bigint**:

```sql
-- Step 1: Create new column
ALTER TABLE bookings ADD COLUMN user_id_new BIGINT;

-- Step 2: Migrate data
UPDATE bookings SET user_id_new = user_id;

-- Step 3: Deploy code to use new column

-- Step 4: Drop old column, rename
ALTER TABLE bookings DROP COLUMN user_id;
ALTER TABLE bookings RENAME COLUMN user_id_new TO user_id;
```

---

## Backward Compatibility Checklist

Before deploying any migration, verify:

- [ ] **Old Code Can Read**: Old application version can read data created by new migration (e.g., new columns have DEFAULTs)
- [ ] **Old Code Can Write**: Old application version can write data compatible with new code (no new NOT NULL columns without DEFAULTs)
- [ ] **No Blocking Operations**: Migration uses `CONCURRENTLY` for indexes on large tables (>1M rows)
- [ ] **Tenant Isolation**: No migration logic exposes data across tenants
- [ ] **Transactional Integrity**: Data consistency maintained during migration
- [ ] **All Tenants Unaffected**: Migration applies globally or per-tenant consistently

### Migration Size Estimation

```sql
-- Estimate table size
SELECT
  schemaname, tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
  n_live_tup as row_count
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

**Decision Rules**:

- **< 100K rows**: ALTER TABLE inline, no blocking concern
- **100K - 1M rows**: Use CONCURRENTLY for new indexes, background migrations for data
- **> 1M rows**: Background migration jobs, no ALTER TABLE during business hours

---

## Schema Versioning

### Database Schema Version Tracking

```sql
-- Table to track applied migrations
CREATE TABLE schema_migrations (
  id SERIAL PRIMARY KEY,
  version VARCHAR(50) NOT NULL UNIQUE,
  name TEXT NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  duration_ms INTEGER,
  status VARCHAR(20) DEFAULT 'success'
);

-- Example records
| version | name                              | applied_at         | duration_ms | status    |
|---------|-----------------------------------|--------------------|-------------|-----------|
| 001     | create_base_schema                | 2025-01-01 10:00   | 250         | success   |
| 002     | add_bookings_table                | 2025-01-02 09:30   | 180         | success   |
| 003     | add_booking_notes_column          | 2025-02-01 02:15   | 450         | success   |
| 004     | create_bookings_status_index      | 2025-02-15 03:00   | 1200        | success   |
```

### Semantic Versioning for Migrations

```
YYYY-MM-DD-NN-description.sql

2025-02-15-001-add-booking-notes.sql      (First migration on this date)
2025-02-15-002-create-status-index.sql    (Second migration on this date)
2025-02-16-001-backfill-email-field.sql
```

---

## Staging Environment Testing

### Pre-Production Verification

#### 1. Test Data Setup

```bash
# Create production-like dataset in staging
docker exec staging_postgres pg_dump -U prod_user prod_db | \
  docker exec -i staging_postgres psql -U staging_user staging_db

# Or: Anonymize PII before copying
# SELECT *, md5(email) FROM users → staging
```

#### 2. Run Migration

```bash
# Execute migration in staging
docker exec staging_postgres psql -U staging_user staging_db -f migration_001.sql

# Verify success
docker exec staging_postgres psql -U staging_user staging_db \
  -c "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 5;"
```

#### 3. Load Testing

```bash
# Run full test suite against migrated schema
pnpm --filter @app/api test:integration

# Simulate production-like load
k6 run load-test.js --vus 50 --duration 10m
```

#### 4. Rollback Test

```bash
# Verify rollback script works
docker exec staging_postgres psql -U staging_user staging_db -f rollback_001.sql

# Verify schema reverted
docker exec staging_postgres psql -U staging_user staging_db \
  -c "\d bookings"

# Verify old code still works
./scripts/deploy-staging.sh rollback
# Run tests again
pnpm --filter @app/api test:integration
```

---

## Rollback Procedures

### Safe Rollback Strategy

```
Step 1: Identify Issue
  ├─ Monitor logs for errors
  ├─ Alert on increased error rate
  └─ Correlate with deployment time

Step 2: Assess Damage
  ├─ Check affected tenants
  ├─ Verify data consistency
  └─ Quantify impact

Step 3: Execute Rollback
  ├─ Deploy previous code version
  ├─ Run rollback migration (if schema changed)
  └─ Monitor for stabilization

Step 4: Post-Incident
  ├─ Review logs
  ├─ Document root cause
  └─ Prevent recurrence
```

### Code Rollback

```bash
# 1. Mark current deployment as failed
docker tag donebyme-api:v1.0.1-failed $(date +%s)
docker tag donebyme-api:v1.0.0 donebyme-api:latest

# 2. Redeploy previous version
docker pull donebyme-api:v1.0.0
docker compose -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d api web

# 3. Verify health
docker compose exec api curl -s http://localhost:8444/health | jq .

# 4. Monitor logs for recovery
docker compose logs -f api --tail=50
```

### Schema Rollback

```sql
-- Rollback migration 003 (add_booking_notes_column)
-- First, code must be rolled back to v1.0.0 (which ignores notes column)

ALTER TABLE bookings DROP COLUMN notes;

-- Update schema_migrations table
INSERT INTO schema_migrations (version, name, status)
VALUES ('003-rollback', 'rollback_add_booking_notes', 'success');
```

### Rollback Decision Matrix

| Scenario                     | Action                                       | Timing               |
| ---------------------------- | -------------------------------------------- | -------------------- |
| Single tenant affected       | Data fix + targeted rollback for tenant only | Immediate            |
| Multiple tenants, low impact | Monitor for 10m, rollback if > 5% error rate | Defer 10m            |
| All tenants, high impact     | Immediate full rollback                      | Immediate            |
| Data corruption              | Rollback + restore from backup               | Immediate + parallel |

---

## Data Migration Strategies

### Background Migration Jobs

For large data transformations (< 1M rows can be inline, > 1M requires background):

```typescript
// apps/api/src/migrations/backfill-booking-notes.ts
async function backfillBookingNotes() {
  const BATCH_SIZE = 5000;
  const TENANTS_QUERY = `
    SELECT DISTINCT tenant_id FROM bookings
    WHERE notes IS NULL AND deleted_at IS NULL
  `;

  for (const tenant of await db.query(TENANTS_QUERY)) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const query = `
        UPDATE bookings
        SET notes = COALESCE(
          (SELECT status FROM booking_status_history
           WHERE booking_id = bookings.id
           ORDER BY created_at DESC LIMIT 1),
          ''
        )
        WHERE tenant_id = ?
          AND notes IS NULL
          AND deleted_at IS NULL
        LIMIT ?
      `;

      const result = await db.query(query, [tenant.tenant_id, BATCH_SIZE]);

      console.log(
        `Migrated ${result.rowCount} bookings for tenant ${tenant.tenant_id}`
      );

      hasMore = result.rowCount === BATCH_SIZE;
      offset += BATCH_SIZE;

      // Sleep between batches to avoid locks
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.log('Backfill complete');
}
```

### Verification Queries

```sql
-- Verify migration completeness
SELECT
  tenant_id,
  COUNT(*) as total_bookings,
  COUNT(CASE WHEN notes IS NOT NULL THEN 1 END) as with_notes,
  COUNT(CASE WHEN notes IS NULL THEN 1 END) as without_notes
FROM bookings
WHERE deleted_at IS NULL
GROUP BY tenant_id
ORDER BY without_notes DESC;
```

---

## Monitoring During Migrations

### Key Metrics to Track

```bash
# Error rate during migration
docker exec prometheus curl -s 'http://localhost:9090/api/v1/query?query=rate(errors_total[1m])'

# Database connection pool utilization
SELECT count(*) as active_connections FROM pg_stat_activity;

# Query performance (before/after)
SELECT query, mean_time, calls FROM pg_stat_statements ORDER BY mean_time DESC LIMIT 10;

# Lock contention
SELECT * FROM pg_stat_activity WHERE wait_event_type = 'Lock';
```

### Alert Thresholds

| Metric         | Threshold    | Action                           |
| -------------- | ------------ | -------------------------------- |
| Error rate     | > 1%         | Investigate immediately          |
| p99 latency    | > 2s         | Check database locks             |
| DB connections | > 80% of max | Scale or investigate queries     |
| Lock wait time | > 30s        | Rollback migration               |
| Disk usage     | > 90%        | Expand disk or investigate bloat |

### Migration Checklist

- [ ] Staging deployment successful (zero errors, full test suite passes)
- [ ] Rollback tested in staging (schema and code rollback verified)
- [ ] Pre-migration backup taken and verified
- [ ] Monitoring dashboards prepared
- [ ] On-call team notified and standing by
- [ ] Deploy window scheduled during low-traffic period
- [ ] Code change prepared and reviewed
- [ ] Migration script syntax verified
- [ ] Estimated migration time documented
- [ ] Tenant communication sent (if applicable)

---

## Migration Playbook Template

```markdown
# Migration Playbook: [Migration Name]

## Overview

- **Migration ID**: YYYY-MM-DD-NNN
- **Estimated Duration**: 15 minutes
- **Estimated Downtime**: 0 minutes (zero-downtime)
- **Rollback Time**: < 5 minutes

## Pre-Deployment

- [ ] Verify staging migration successful
- [ ] Verify rollback procedure works
- [ ] Alert team members
- [ ] Notify major customers (if applicable)

## Deployment

- [ ] Deploy migration (step 1, 2, 3...)
- [ ] Monitor metrics (error rate, latency, connections)
- [ ] Verify health checks passing
- [ ] Confirm data integrity

## Post-Deployment

- [ ] Update schema_migrations table
- [ ] Document any issues encountered
- [ ] Schedule cleanup tasks (if any)
- [ ] Notify team of completion

## Rollback Trigger

- > 5% error rate increase
- > 50ms latency increase
- Database connection exhaustion
- Lock contention detected
```

---

## Summary

| Aspect              | Pattern                                                |
| ------------------- | ------------------------------------------------------ |
| **Zero Downtime**   | Dual-deploy: schema migration first, then code         |
| **Backward Compat** | New columns have DEFAULTs, old code ignores new fields |
| **Index Safety**    | Use CONCURRENTLY for large tables                      |
| **Verification**    | Full testing in staging, rollback tested               |
| **Versioning**      | schema_migrations table tracks all changes             |
| **Rollback**        | Keep previous version deployed for quick rollback      |
| **Monitoring**      | Track error rate, latency, DB connections, locks       |
| **Data Migration**  | Background jobs for > 1M rows, batch with delays       |

---

## References

- [PostgreSQL ALTER TABLE Documentation](https://www.postgresql.org/docs/current/sql-altertable.html)
- [Zero-Downtime Deployment Strategies](https://www.postgresql.org/docs/current/runtime-config-client.html)
- [Drizzle ORM Migrations](https://orm.drizzle.team/docs/migrations)
