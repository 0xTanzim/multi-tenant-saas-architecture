# Multi-Tenant Database Schema Design Patterns

## Table of Contents

1. [Overview](#overview)
2. [Shared Schema Model](#shared-schema-model)
3. [Tenant Isolation via Foreign Keys](#tenant-isolation-via-foreign-keys)
4. [Unique Constraints with Tenant ID](#unique-constraints-with-tenant-id)
5. [Composite Indexes Strategy](#composite-indexes-strategy)
6. [Why Shared Schema is Preferred](#why-shared-schema-is-preferred)
7. [Schema Architecture](#schema-architecture)
8. [Data Isolation Guarantees](#data-isolation-guarantees)

---

## Overview

Multi-tenant SaaS applications require strict data isolation while maintaining operational efficiency. The **Shared Schema Model** with **Tenant-Scoped Foreign Keys** achieves this by:

- **Single Database**: All tenant data coexists in the same PostgreSQL database
- **Logical Isolation**: Tenant IDs enforce data boundaries at the application and database levels
- **Scalability**: Cost-efficient for thousands of tenants; enables efficient schema updates
- **Security**: Hard constraints in the database layer provide a safety net

**Key Principle**: Every query must filter by `tenant_id`. This is not optional—it's a database-enforced pattern.

---

## Shared Schema Model

### Core Concept

In a **shared schema model**, all tables include a `tenant_id` column that logically partitions data:

```
┌─────────────────────────────────────┐
│    PostgreSQL Database              │
├─────────────────────────────────────┤
│  Table: users (global identity)     │
│  Table: customers (multi-tenant)    │
│  Table: bookings (multi-tenant)     │
│  Table: staff (multi-tenant)        │
│  Table: services (multi-tenant)     │
│  Table: payments (multi-tenant)     │
│  ...                                │
│                                     │
│  Tenant A data: tenant_id = 1      │
│  Tenant B data: tenant_id = 2      │
│  Tenant C data: tenant_id = 3      │
└─────────────────────────────────────┘
```

### Two-Tier Table Classification

**1. Platform Tables** (Global scope, no tenant_id):

- `users` — Authentication identity (shared across all tenants)
- `tenants` — Tenant registry and configuration
- `audit_logs_platform` — System-wide audit trail

**2. Tenant-Scoped Tables** (Isolated per tenant):

- `customers` — Customer profiles per tenant
- `bookings` — Appointments per tenant
- `staff_employments` — Employee records per tenant
- `services` — Service catalog per tenant
- `payments` — Payment records per tenant
- All other domain-specific tables

---

## Tenant Isolation via Foreign Keys

### The Pattern

Every tenant-scoped table MUST have:

1. **A `tenant_id` column** (integer, NOT NULL, indexed)
2. **A foreign key referencing the `tenants` table**
3. **Foreign key cascading** to handle tenant deletion

### Example: Booking Table Schema

```sql
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,

  -- Tenant Reference (MANDATORY)
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- Business Data
  customer_id INTEGER NOT NULL,
  staff_employment_id INTEGER NOT NULL,
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_amount DECIMAL(10, 2) NOT NULL,

  -- Soft Delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit Trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tenant ID is indexed for fast queries
CREATE INDEX idx_bookings_tenant_id ON bookings(tenant_id);
```

### Cascade Behavior Explained

When a tenant is deleted:

- `ON DELETE CASCADE` automatically removes all records where `tenant_id = <deleted_tenant>`
- This prevents orphaned data and maintains referential integrity
- Alternative: `ON DELETE RESTRICT` prevents deletion if dependent records exist

**Recommendation**: Use `CASCADE` for most tenant-scoped tables. Use `RESTRICT` only for audit/compliance records.

---

## Unique Constraints with Tenant ID

### Why Tenant-Scoped Uniqueness?

**Problem**: Without tenant scoping, unique constraints fail in multi-tenant contexts.

❌ **Wrong** (violates tenant isolation):

```sql
CREATE UNIQUE INDEX idx_email_unique ON customers(email);
-- Two different tenants can't have the same customer email!
```

✅ **Correct** (tenant-scoped uniqueness):

```sql
CREATE UNIQUE INDEX idx_customer_email_per_tenant
  ON customers(tenant_id, email)
  WHERE deleted_at IS NULL;
-- Email is unique within a tenant, not globally
```

### Real-World Pattern: Staff Employment

A staff member can be employed by multiple salons (tenants) but only once per salon:

```sql
-- Core Staff Profile (shared staff identity)
CREATE TABLE staff_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  -- ... other staff data ...
);

-- Staff Employment per Tenant (enforces one active employment per tenant)
CREATE TABLE staff_employments (
  id SERIAL PRIMARY KEY,

  staff_profile_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  employee_id VARCHAR(50),
  position VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'hired',

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at TIMESTAMP WITH TIME ZONE
);

-- Enforce: Only one ACTIVE employment per staff member per tenant
CREATE UNIQUE INDEX staff_employments_tenant_active_uq
  ON staff_employments(staff_profile_id, tenant_id)
  WHERE deleted_at IS NULL
    AND status IN ('hired', 'active', 'suspended');

-- Enforce: Employee ID is unique within tenant (if provided)
CREATE UNIQUE INDEX staff_employments_tenant_employee_id_uq
  ON staff_employments(tenant_id, employee_id)
  WHERE deleted_at IS NULL AND employee_id IS NOT NULL;
```

**Key Insight**: Partial unique indexes (with `WHERE` clause) allow soft-deleted records to be excluded from uniqueness constraints.

---

## Composite Indexes Strategy

### What Are Composite Indexes?

A **composite index** combines multiple columns, enabling efficient filtering on all indexed columns in combination.

### Pattern: Tenant + Status + Date

Most queries filter by `tenant_id` + one or more business attributes:

```sql
-- INEFFICIENT: Separate indexes
CREATE INDEX idx_bookings_tenant ON bookings(tenant_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_date ON bookings(booking_date);
-- PostgreSQL must scan 3 separate indexes

-- EFFICIENT: Composite index
CREATE INDEX idx_bookings_tenant_status_date
  ON bookings(tenant_id, status, booking_date)
  WHERE deleted_at IS NULL;
-- Single index covers all three conditions
```

### Index Design Rules

**1. Tenant ID First**
Always place `tenant_id` as the first column in composite indexes:

```sql
-- ✅ CORRECT
CREATE INDEX idx_customer_bookings
  ON bookings(tenant_id, customer_id, booking_date);

-- ❌ WRONG (tenant_id not first)
CREATE INDEX idx_customer_bookings
  ON bookings(customer_id, booking_date, tenant_id);
```

**Why**: PostgreSQL can use the index for queries filtering on any prefix of the columns, and placing tenant_id first dramatically reduces the search space.

**2. Exclude Soft-Deleted Records**

```sql
-- Include WHERE clause for soft deletes
CREATE INDEX idx_bookings_active
  ON bookings(tenant_id, status, booking_date)
  WHERE deleted_at IS NULL;

-- Queries like:
-- SELECT * FROM bookings WHERE tenant_id = 1 AND deleted_at IS NULL
-- can use this index efficiently
```

**3. Order Columns by Query Patterns**

```sql
-- Pattern 1: Get bookings for staff member on a date
-- SELECT * FROM bookings WHERE tenant_id = ? AND staff_id = ? AND booking_date = ?
CREATE INDEX idx_bookings_staff_date
  ON bookings(tenant_id, staff_employment_id, booking_date)
  WHERE deleted_at IS NULL;

-- Pattern 2: Get all bookings for tenant with a status
-- SELECT * FROM bookings WHERE tenant_id = ? AND status = ?
CREATE INDEX idx_bookings_status
  ON bookings(tenant_id, status)
  WHERE deleted_at IS NULL;
```

### Partial Indexes with WHERE

Partial indexes reduce size and improve performance by excluding irrelevant rows:

```sql
-- Before: Large index with all records
CREATE INDEX idx_bookings_date ON bookings(booking_date);

-- After: Smaller index, only active bookings
CREATE INDEX idx_bookings_active_date
  ON bookings(booking_date)
  WHERE deleted_at IS NULL;
-- This index is ~10x smaller, scans faster
```

---

## Why Shared Schema is Preferred

### Comparison of Multi-Tenant Architectures

| Aspect                     | Shared Schema               | Separate Database         | Separate Schema             |
| -------------------------- | --------------------------- | ------------------------- | --------------------------- |
| **Cost**                   | Very low (one DB)           | High (100+ DBs)           | Moderate (many schemas)     |
| **Complexity**             | Moderate (tenant filtering) | High (connection pooling) | Moderate (schema switching) |
| **Deployment**             | Single migration            | N+1 migrations            | N migrations                |
| **Cross-tenant Analytics** | Easy                        | Hard                      | Moderate                    |
| **Tenant Isolation**       | Logical + indexing          | Complete                  | Complete                    |
| **Data Backup/Restore**    | Single backup               | Per-tenant backup         | Per-schema backup           |
| **Scaling**                | Data partitioning           | Add new DBs               | Add new schemas             |
| **Onboarding Time**        | Instant                     | Minutes (new DB)          | Seconds                     |

### Advantages of Shared Schema

**1. Operational Simplicity**

- Single database to manage, backup, and monitor
- Schema migrations apply to all tenants atomically
- No connection pool explosion

**2. Cost Efficiency**

- No per-tenant database overhead
- Shared resources (memory, disk, CPU)
- Scales to thousands of tenants cost-effectively

**3. Cross-Tenant Analytics**

- Analyze trends across all tenants in one query
- No need for data warehousing to unify separate databases
- Real-time insights into platform health

**4. Data Consistency**

- ACID transactions work across all tenants
- Foreign key constraints enforce referential integrity
- One source of truth for all data

**5. Feature Parity**

- All tenants get new features simultaneously
- No migration coordination needed
- Easier to maintain consistent behavior

### When Shared Schema Works Best

✅ **Ideal for**:

- SaaS platforms with 10–100,000+ tenants
- Applications where tenants don't require custom schema variations
- Scenarios where tenant isolation is enforced at the application layer
- Cost-conscious deployments

❌ **Not ideal for**:

- Single-tenant or very small multi-tenant deployments (<10 tenants)
- Applications requiring tenant-specific schema customization
- Highly regulated industries with extreme isolation requirements (use separate databases)
- Scenarios where individual tenant data is extremely large (partitioning strategy applies)

---

## Schema Architecture

### The Complete Picture

```
┌─────────────────────────────────────────────────┐
│             PostgreSQL Database                  │
├─────────────────────────────────────────────────┤
│                                                 │
│  PLATFORM TABLES (Global Scope)                 │
│  ├─ users (authentication identity)             │
│  ├─ tenants (tenant registry)                   │
│  └─ audit_logs_platform (system-wide logs)      │
│                                                 │
│  TENANT-SCOPED TABLES (Partitioned by tenant_id)
│  ├─ customers (customer_id, tenant_id)          │
│  ├─ bookings (booking_id, tenant_id)            │
│  ├─ staff_employments (staff_id, tenant_id)     │
│  ├─ services (service_id, tenant_id)            │
│  ├─ payments (payment_id, tenant_id)            │
│  ├─ invoices (invoice_id, tenant_id)            │
│  ├─ time_off (time_off_id, tenant_id)           │
│  └─ ... (all other domain tables)               │
│                                                 │
│  JUNCTION/PIVOT TABLES (All include tenant_id)  │
│  ├─ booking_services (booking_id, service_id,   │
│  │                     tenant_id)               │
│  └─ permission_assignments (user_id, role_id,   │
│                             tenant_id)         │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Foreign Key Hierarchy

```
users (platform)
  └── customers ──┐
  └── staff_profiles ──┐
                       │
tenants (platform)     │
  └── bookings ◄───────┘
  └── services
  └── staff_employments
  └── invoices
  └── payments
  └── [all tenant-scoped tables]
```

**Key Observation**: Every tenant-scoped table has a direct or indirect reference to `tenants.id` to ensure isolation.

---

## Data Isolation Guarantees

### Application Layer Enforcement

**Every query must include the tenant context**:

```typescript
// Backend (Node.js + Drizzle ORM example)
async function getBookings(tenantId: number) {
  // ✅ CORRECT: Explicitly filter by tenant_id
  return db
    .select()
    .from(bookings)
    .where(eq(bookings.tenant_id, tenantId))
    .andWhere(isNull(bookings.deleted_at));
}

// ❌ WRONG: Missing tenant filter
async function getBookings() {
  return db.select().from(bookings); // Returns data for ALL tenants!
}
```

### Database Layer Enforcement

**Row-Level Security (RLS)** can optionally enforce tenant boundaries:

```sql
-- Enable RLS on tenant-scoped tables
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access their tenant's data
CREATE POLICY bookings_tenant_isolation
  ON bookings
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant_id')::int);

-- Every query automatically filters by tenant_id via RLS policy
```

**Note**: Most SaaS applications enforce this at the application layer for performance reasons. RLS adds overhead but provides a safety net.

### Audit Trail for Tenant Access

```sql
-- Log all data access
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  action VARCHAR(50) NOT NULL,
  table_name VARCHAR(100) NOT NULL,
  record_id INTEGER NOT NULL,
  old_values JSONB,
  new_values JSONB,
  accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Queries on this table are always filtered by tenant_id
CREATE INDEX idx_audit_logs_tenant_action
  ON audit_logs(tenant_id, action, accessed_at);
```

---

## Summary: The Mental Model

**Golden Rule**:

> Every row in every tenant-scoped table has a `tenant_id`. Every query must filter by `tenant_id`. Failure to filter is a security bug.

**Checklist for Schema Design**:

- [ ] Every tenant-scoped table has a `tenant_id` column
- [ ] `tenant_id` is NOT NULL and indexed
- [ ] Foreign key `(tenant_id) REFERENCES tenants(id)` is defined
- [ ] Unique constraints include `tenant_id` (for tenant-scoped uniqueness)
- [ ] Composite indexes begin with `tenant_id`
- [ ] Soft-delete indexes use `WHERE deleted_at IS NULL`
- [ ] Cascade behavior is intentional (CASCADE or RESTRICT)
- [ ] Application queries always filter by `tenant_id`

---

## Next Steps

Read the related documentation:

- [Tenant-Scoped Queries](./TENANT_SCOPED_QUERIES.md) — Query patterns and optimization
- [Soft Delete Strategy](./SOFT_DELETE_STRATEGY.md) — Handling logical deletes
- [Migration Strategy](./MIGRATION_STRATEGY.md) — Zero-downtime schema changes
