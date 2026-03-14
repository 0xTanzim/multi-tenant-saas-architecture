# Tenant Data Model — Database Schema & Relationships

**Version:** 1.0
**Status:** Reference Implementation
**Audience:** Database Architects, Backend Engineers, DevOps

---

## Table of Contents

1. [Overview](#overview)
2. [Core Tenant Tables](#core-tenant-tables)
3. [User & Role Tables](#user--role-tables)
4. [Foreign Key Relationships](#foreign-key-relationships)
5. [Indexing Strategy](#indexing-strategy)
6. [Constraints & Uniqueness](#constraints--uniqueness)
7. [Soft Delete Pattern](#soft-delete-pattern)
8. [Normalization](#normalization)

---

## Overview

The tenant data model organizes multi-tenant data with **explicit tenant_id fields** on every table, composite indexes for performance, and soft-delete support for compliance and auditability.

### Design Principles

1. **Explicit Tenant Binding**: Every table has explicit `tenant_id` foreign key
2. **Composite Indexing**: `(tenant_id, other_fields)` for query performance
3. **Referential Integrity**: Foreign keys enforce relationships
4. **Audit Trail**: Timestamps track data lifecycle
5. **Soft Deletes**: Data retained for compliance
6. **No Implicit Relationships**: All relationships explicitly defined
7. **Scalability**: Design supports billions of rows across thousands of tenants

---

## Core Tenant Tables

### Tenants Table

**Primary table defining each tenant organization.**

```sql
CREATE TABLE tenants (
  -- Primary Key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant Identity
  slug VARCHAR(100) NOT NULL UNIQUE,        -- URL-safe identifier
  name VARCHAR(255) NOT NULL,               -- Display name
  type VARCHAR(50) NOT NULL,                -- 'organization', 'team', 'department'

  -- Operational State
  status VARCHAR(50) NOT NULL DEFAULT 'created',  -- created, active, suspended, archived, deleted

  -- Subscription & Features
  plan VARCHAR(50) NOT NULL DEFAULT 'free', -- free, starter, professional, enterprise
  feature_flags JSONB DEFAULT '{}'::jsonb,  -- Feature toggles: { "api": true, "webhooks": false }
  quota JSONB DEFAULT '{
    "apiCalls": 1000,
    "storage": 1000000,
    "users": 5
  }'::jsonb,

  -- Contact Information
  email VARCHAR(255),
  phone VARCHAR(20),
  website VARCHAR(255),

  -- Location & Timezone
  country_code VARCHAR(2),
  timezone VARCHAR(50) DEFAULT 'UTC',
  language VARCHAR(10) DEFAULT 'en',

  -- Audit Fields
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_by UUID,                          -- User who created
  updated_by UUID,                          -- User who last updated

  -- Soft Delete
  deleted_at TIMESTAMP NULL,                -- NULL = active, timestamp = deleted

  -- Constraints
  CHECK (status IN ('created', 'active', 'suspended', 'archived', 'deleted')),
  CHECK (type IN ('organization', 'team', 'department')),
  CONSTRAINT slug_format CHECK (slug ~ '^[a-z0-9-]{3,100}$')
);

-- ✅ Indexes
CREATE INDEX idx_tenants_status ON tenants(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_tenants_plan ON tenants(plan) WHERE deleted_at IS NULL;
CREATE INDEX idx_tenants_created_at ON tenants(created_at);
```

**Use Pattern:**

```sql
-- Get active tenant
SELECT * FROM tenants
WHERE id = $1
  AND status = 'active'
  AND deleted_at IS NULL;

-- List all active tenants for a plan
SELECT * FROM tenants
WHERE plan = $1
  AND status = 'active'
  AND deleted_at IS NULL
ORDER BY created_at DESC;
```

---

### Tenant Settings Table

**Store tenant-specific configuration.**

```sql
CREATE TABLE tenant_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign Key to Tenant
  tenant_id UUID NOT NULL,

  -- Business Settings
  business_name VARCHAR(255),
  business_type VARCHAR(100),
  logo_url VARCHAR(500),
  primary_color VARCHAR(7),          -- Hex color code
  secondary_color VARCHAR(7),

  -- Operating Hours
  business_hours JSONB DEFAULT '{
    "monday": {"open": "09:00", "close": "17:00"},
    "tuesday": {"open": "09:00", "close": "17:00"},
    "wednesday": {"open": "09:00", "close": "17:00"},
    "thursday": {"open": "09:00", "close": "17:00"},
    "friday": {"open": "09:00", "close": "17:00"},
    "saturday": {"open": "10:00", "close": "14:00"},
    "sunday": null
  }'::jsonb,

  -- Communication Preferences
  notification_email VARCHAR(255),
  sms_enabled BOOLEAN DEFAULT false,
  email_enabled BOOLEAN DEFAULT true,

  -- Advanced Settings
  custom_domain VARCHAR(255),
  custom_branding JSONB,
  integrations JSONB DEFAULT '{}'::jsonb,

  -- Audit
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by UUID,

  deleted_at TIMESTAMP NULL,

  -- Relationships
  FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE(tenant_id),

  -- Soft Delete
  CHECK (deleted_at IS NULL OR updated_at >= deleted_at)
);

-- ✅ Indexes
CREATE INDEX idx_tenant_settings_tenant_id ON tenant_settings(tenant_id);
```

---

## User & Role Tables

### Users Table

**Global user registry (independent of tenants).**

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  email VARCHAR(255) NOT NULL UNIQUE,
  email_verified BOOLEAN DEFAULT false,
  email_verified_at TIMESTAMP,

  -- Password (hashed)
  password_hash VARCHAR(255) NOT NULL,
  password_changed_at TIMESTAMP DEFAULT NOW(),

  -- Profile
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  avatar_url VARCHAR(500),
  phone VARCHAR(20),

  -- Authentication
  last_login_at TIMESTAMP,
  last_login_ip VARCHAR(45),              -- IPv4 or IPv6
  login_count INT DEFAULT 0,
  failed_login_attempts INT DEFAULT 0,

  -- Account Status
  status VARCHAR(50) NOT NULL DEFAULT 'active',  -- active, suspended, locked

  -- Preferences
  timezone VARCHAR(50) DEFAULT 'UTC',
  language VARCHAR(10) DEFAULT 'en',

  -- Audit
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP NULL,

  -- Constraints
  CHECK (status IN ('active', 'suspended', 'locked')),
  CONSTRAINT email_valid CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$')
);

-- ✅ Indexes
CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_status ON users(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_created_at ON users(created_at);
```

**Key Point**: Users are **global** (one user account can access multiple tenants).

---

### User-Tenant Membership Table

**Explicit many-to-many relationship between users and tenants.**

```sql
CREATE TABLE user_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign Keys (Many-to-Many)
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,

  -- User's Role in This Tenant
  role VARCHAR(50) NOT NULL,  -- owner, admin, operator, user

  -- Access Status
  is_active BOOLEAN DEFAULT true,
  is_primary BOOLEAN DEFAULT false,       -- Primary tenant for quick access

  -- Session Management
  last_accessed_at TIMESTAMP,
  access_count INT DEFAULT 0,

  -- Audit
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMP NULL,

  -- Relationships
  FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,

  -- Uniqueness: One role per user per tenant
  UNIQUE(user_id, tenant_id),

  -- Constraints
  CHECK (role IN ('owner', 'admin', 'operator', 'user')),
  CHECK (deleted_at IS NULL OR updated_at >= deleted_at)
);

-- ✅ Indexes
CREATE INDEX idx_user_tenants_user_id ON user_tenants(user_id, is_active);
CREATE INDEX idx_user_tenants_tenant_id ON user_tenants(tenant_id, is_active);
CREATE INDEX idx_user_tenants_role ON user_tenants(tenant_id, role);
CREATE INDEX idx_user_tenants_primary ON user_tenants(user_id, is_primary);
```

**Usage Pattern:**

```sql
-- Get all tenants for a user
SELECT tenant_id, role FROM user_tenants
WHERE user_id = $1
  AND is_active = true
  AND deleted_at IS NULL
ORDER BY is_primary DESC;

-- Get all users with 'admin' role in a tenant
SELECT u.id, u.email, ut.role FROM user_tenants ut
JOIN users u ON ut.user_id = u.id
WHERE ut.tenant_id = $1
  AND ut.role = 'admin'
  AND ut.deleted_at IS NULL;

-- Check if user can access specific tenant
SELECT role FROM user_tenants
WHERE user_id = $1
  AND tenant_id = $2
  AND is_active = true
  AND deleted_at IS NULL;
```

---

### Permissions Table

**Granular permission definitions per role.**

```sql
CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Permission Identity
  resource VARCHAR(100) NOT NULL,         -- 'booking', 'user', 'report'
  action VARCHAR(50) NOT NULL,            -- 'create', 'read', 'update', 'delete'

  -- Description
  description VARCHAR(500),

  -- Role Mapping
  owner BOOLEAN DEFAULT true,
  admin BOOLEAN DEFAULT true,
  operator BOOLEAN DEFAULT false,
  user BOOLEAN DEFAULT false,

  -- System Flag (cannot be deleted)
  is_system BOOLEAN DEFAULT false,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  UNIQUE(resource, action),
  CHECK (action IN ('create', 'read', 'update', 'delete', 'admin'))
);

-- Seed data
INSERT INTO permissions (resource, action, description, owner, admin, operator, user, is_system) VALUES
  ('booking', 'create', 'Create new booking', true, true, true, false, true),
  ('booking', 'read', 'View bookings', true, true, true, true, true),
  ('booking', 'update', 'Update booking', true, true, true, false, true),
  ('booking', 'delete', 'Delete booking', true, true, false, false, true),
  ('user', 'create', 'Create new user', true, true, false, false, true),
  ('user', 'read', 'View users', true, true, true, false, true),
  ('user', 'update', 'Update user', true, true, false, false, true),
  ('report', 'read', 'View reports', true, true, true, false, true),
  ('tenant', 'admin', 'Administer tenant', true, false, false, false, true);
```

---

## Foreign Key Relationships

### Entity Relationship Diagram

```
┌─────────────────┐
│    Tenants      │
│  - id (PK)      │
│  - slug         │
│  - name         │
│  - status       │
│  - plan         │
│  - deleted_at   │
└────────┬────────┘
         │ FK
         │
    ┌────────────────────┐
    │                    │
    ↓ 1:1                ↓ 1:*
┌─────────────────┐  ┌──────────────────┐
│ Tenant Settings │  │  User Tenants    │
│  - tenant_id(FK)│  │ - user_id(FK)    │
│  - settings     │  │ - tenant_id(FK)  │
└─────────────────┘  │ - role           │
                     └────────┬─────────┘
                              │
                              ↓ FK
                         ┌──────────────┐
                         │    Users     │
                         │  - id (PK)   │
                         │  - email     │
                         │  - status    │
                         └──────────────┘
```

### Foreign Key Constraints

```sql
-- Tenant Settings → Tenants
ALTER TABLE tenant_settings
ADD CONSTRAINT fk_settings_tenant
FOREIGN KEY (tenant_id)
REFERENCES tenants(id) ON DELETE CASCADE;

-- User Tenants → Users
ALTER TABLE user_tenants
ADD CONSTRAINT fk_user_tenants_user
FOREIGN KEY (user_id)
REFERENCES users(id) ON DELETE CASCADE;

-- User Tenants → Tenants
ALTER TABLE user_tenants
ADD CONSTRAINT fk_user_tenants_tenant
FOREIGN KEY (tenant_id)
REFERENCES tenants(id) ON DELETE CASCADE;
```

**Cascade Behavior:**

- Deleting a **tenant** cascades delete to settings, user memberships, all tenant data
- Deleting a **user** cascades delete from user_tenants (user loses access to all tenants)
- Deleting from **user_tenants** does NOT delete user or tenant

---

## Indexing Strategy

### Query Performance Patterns

Every table uses a consistent indexing strategy for tenant-scoped queries:

```
Pattern: (tenant_id, other_fields)
Reason:  WHERE tenant_id = ? AND other_field = ?
Result:  Fast composite index lookup
```

### Index Examples by Access Pattern

**Pattern 1: Active records for a tenant**

```sql
-- Query
SELECT * FROM bookings
WHERE tenant_id = $1
  AND status = 'active'
  AND deleted_at IS NULL;

-- Optimal Index
CREATE INDEX idx_bookings_tenant_status
  ON bookings(tenant_id, status)
  WHERE deleted_at IS NULL;
```

**Pattern 2: User access verification**

```sql
-- Query
SELECT role FROM user_tenants
WHERE user_id = $1
  AND tenant_id = $2
  AND deleted_at IS NULL;

-- Optimal Index
CREATE INDEX idx_user_tenants_verify
  ON user_tenants(user_id, tenant_id)
  WHERE deleted_at IS NULL;
```

**Pattern 3: Tenant-wide search**

```sql
-- Query
SELECT * FROM resources
WHERE tenant_id = $1
  AND name ILIKE $2
  AND deleted_at IS NULL;

-- Optimal Index (PostgreSQL)
CREATE INDEX idx_resources_tenant_name
  ON resources(tenant_id, name)
  WHERE deleted_at IS NULL;

-- Or with text search
CREATE INDEX idx_resources_tenant_search
  ON resources USING GIN(tenant_id, search_vector);
```

### Indexing Rules

```
✅ DO:
- Index (tenant_id, other_field) combinations
- Filter indexes with WHERE deleted_at IS NULL
- Add covering indexes for frequently used columns
- Drop unused indexes quarterly

❌ DON'T:
- Create indexes on rarely-queried columns
- Index low-cardinality columns alone (tenant_id needs companions)
- Forget soft-delete filters in partial indexes
- Add too many indexes (degrades write performance)
```

---

## Constraints & Uniqueness

### Unique Constraints

**Tenant-scoped uniqueness:**

```sql
-- ✅ CORRECT: Unique per tenant
CREATE UNIQUE INDEX idx_email_per_tenant
  ON users_in_tenant(tenant_id, email)
  WHERE deleted_at IS NULL;

-- ❌ WRONG: Global uniqueness (conflicts across tenants)
-- CREATE UNIQUE INDEX idx_email_global ON users(email);
```

**Slug uniqueness:**

```sql
-- Tenant slug must be unique globally
CREATE UNIQUE INDEX idx_tenants_slug
  ON tenants(slug)
  WHERE deleted_at IS NULL;

-- API key prefix must be unique globally
CREATE UNIQUE INDEX idx_api_keys_prefix
  ON api_keys(key_prefix)
  WHERE deleted_at IS NULL;
```

### Check Constraints

```sql
-- Validate enum values
CHECK (status IN ('active', 'suspended', 'archived', 'deleted'))

-- Validate email format
CONSTRAINT email_valid CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$')

-- Validate UUID format
CONSTRAINT valid_uuid CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

-- Validate tenant slug
CONSTRAINT slug_format CHECK (slug ~ '^[a-z0-9-]{3,100}$')
```

---

## Soft Delete Pattern

### Why Soft Delete?

```
Hard Delete Problems:
- GDPR compliance: Must maintain audit trail
- Accidental deletion: No recovery option
- Referential integrity: Can't track who deleted what
- Data recovery: Backup-only recovery is slow

Soft Delete Benefits:
✅ Audit trail preserved
✅ Can query deletion history
✅ Easy recovery/restore
✅ Compliance-ready
```

### Implementation

**Every table has deleted_at:**

```sql
CREATE TABLE any_table (
  -- ... columns ...

  -- Soft delete marker
  deleted_at TIMESTAMP NULL,

  -- Audit
  deleted_by UUID,  -- Who deleted
  deletion_reason VARCHAR(500),

  -- Constraint: updated_at >= deleted_at
  CHECK (deleted_at IS NULL OR updated_at >= deleted_at)
);
```

**Query pattern: Always filter deleted**

```sql
-- ❌ WRONG: Includes deleted records
SELECT * FROM bookings WHERE tenant_id = $1;

-- ✅ CORRECT: Excludes deleted
SELECT * FROM bookings
WHERE tenant_id = $1
  AND deleted_at IS NULL;
```

**Restore functionality:**

```sql
-- Soft restore
UPDATE bookings
SET deleted_at = NULL
WHERE tenant_id = $1
  AND id = $2;

-- Purge after retention period (compliance)
DELETE FROM bookings
WHERE tenant_id = $1
  AND deleted_at < NOW() - INTERVAL '90 days';
```

---

## Normalization

### Design Decisions

#### 1. **User Tenants as Explicit Table**

Why not store role directly in users table?

```sql
-- ❌ WRONG: Stores only one tenant per user
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255),
  tenant_id UUID,        -- Can only assign one tenant!
  role VARCHAR(50),      -- Problem: User limited to single tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- ✅ CORRECT: Many-to-many relationship
CREATE TABLE user_tenants (
  user_id UUID,
  tenant_id UUID,
  role VARCHAR(50),      -- User can have different roles in different tenants
  PRIMARY KEY (user_id, tenant_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
```

#### 2. **Tenant Settings as Separate Table**

Why not include settings in tenants table?

```sql
-- ❌ WRONG: Tenants table becomes bloated
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  -- ... 10 essential columns ...
  -- ... 50 settings columns ...  ← Row becomes huge
  -- ... 30 config columns ...
);

-- ✅ CORRECT: Separate 1:1 table for optional data
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  -- ... 10 essential columns ...
  FOREIGN KEY (id) REFERENCES tenant_settings(tenant_id)
);

CREATE TABLE tenant_settings (
  tenant_id UUID PRIMARY KEY,
  -- ... 80 settings columns (only loaded when needed) ...
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
```

#### 3. **Feature Flags as JSONB**

Why not create separate table for every feature?

```sql
-- ❌ WRONG: One table per feature (overhead)
CREATE TABLE feature_api { tenant_id UUID, enabled BOOLEAN };
CREATE TABLE feature_webhooks { tenant_id UUID, enabled BOOLEAN };
CREATE TABLE feature_custom_domain { tenant_id UUID, enabled BOOLEAN };
-- ... 20 more tables ...

-- ✅ CORRECT: JSONB for flexible, often-queried features
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  feature_flags JSONB DEFAULT '{
    "api": false,
    "webhooks": false,
    "custom_domain": false
  }'::jsonb
);

-- Query
SELECT feature_flags->>'api' FROM tenants WHERE id = $1;
```

---

## Example: Complete Data Model Query

### Create a New Tenant with User

```sql
BEGIN;

-- 1. Create tenant
INSERT INTO tenants (slug, name, type, status, plan)
VALUES ('company-a', 'Company A', 'organization', 'active', 'professional')
RETURNING id INTO tenant_id;

-- 2. Create tenant settings
INSERT INTO tenant_settings (tenant_id, business_name, timezone)
VALUES (tenant_id, 'Company A LLC', 'America/New_York');

-- 3. Get or create user
INSERT INTO users (email, first_name, last_name, password_hash)
VALUES ('john@example.com', 'John', 'Doe', hash_password('password'))
ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
RETURNING id INTO user_id;

-- 4. Assign user to tenant as owner
INSERT INTO user_tenants (user_id, tenant_id, role, is_primary, is_active)
VALUES (user_id, tenant_id, 'owner', true, true);

-- 5. Assign permissions via role (through permissions table)
-- (Permissions are already seeded in permissions table by role)

COMMIT;

-- Result: User can now access tenant
SELECT * FROM user_tenants
WHERE user_id = user_id
  AND tenant_id = tenant_id;
```

---

## Summary

**The tenant data model provides:**

1. ✅ **Explicit tenant binding** on every table via `tenant_id`
2. ✅ **Composite indexing** for fast tenant-scoped queries
3. ✅ **Referential integrity** via foreign keys
4. ✅ **Audit trail** via timestamps and soft deletes
5. ✅ **Normalization** separating concerns appropriately
6. ✅ **Scalability** supporting millions of tenants and billions of records
7. ✅ **Compliance-ready** with soft deletes and audit fields

This foundation enables secure, performant, auditable multi-tenant data storage.
