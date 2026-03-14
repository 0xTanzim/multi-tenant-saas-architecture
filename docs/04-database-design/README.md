# Database Design & Schema

Database architecture, schema patterns, query optimization, and data integrity strategies.

## Files

### 1. **SCHEMA_DESIGN_PATTERNS.md**

Core schema patterns for multi-tenant systems.

- Shared schema with tenant_id approach
- Table structure with tenant context
- Composite primary keys
- Foreign key relationships

### 2. **TENANT_SCOPED_QUERIES.md**

Query patterns that maintain tenant isolation.

- Drizzle ORM patterns
- Filtering by tenant_id in WHERE clauses
- Eager loading related data
- Performance optimization with indexes

### 3. **SOFT_DELETE_STRATEGY.md**

Logical deletion for audit compliance.

- deleted_at column pattern
- Retrieving soft-deleted data
- Cascading deletes vs logical deletes
- Data recovery procedures

### 4. **MIGRATION_STRATEGY.md**

Safe database migration procedures.

- Backward-compatible changes
- Rollback strategies
- Data migration patterns
- Deployment procedures

### 5. **SCHEMA_ORGANIZATION_GUIDE.md**

Reference guide for 18 domain schema folders.

- How schemas are organized by domain
- Relationships between domains
- Schema conventions
- How to add new schemas

### 6. **INDEX_STRATEGY.md**

Query performance optimization with indexes.

- Composite indexes with tenant_id
- Query analysis and performance
- Index creation strategies
- Monitoring slow queries

## Database Stack

- **ORM**: Drizzle (type-safe SQL)
- **Database**: PostgreSQL
- **Pattern**: Shared schema with row-level tenant_id filtering
- **Isolation**: Application-enforced (no RLS)

## Reading Order

1. Start with SCHEMA_DESIGN_PATTERNS.md (understand the pattern)
2. Read TENANT_SCOPED_QUERIES.md (implementation)
3. Explore specific domain schemas in referenced folders
4. Read MIGRATION_STRATEGY.md for schema changes

## Key Principles

- **Tenant Column on Everything**: Every table has tenant_id
- **Composite Indexes**: (tenant_id, other_columns) for performance
- **Foreign Keys**: Maintain referential integrity
- **Audit Trail**: Use soft deletes for compliance

## Related Files

- **Data model design**: `../01-core-concepts/MULTI_TENANT_DATA_MODEL.md`
- **Query implementation**: `../09-testing-quality/` (integration tests)
- **Performance tuning**: `../06-caching-performance/`

---

**Common Tasks:**

- Adding a new table
- Querying by tenant
- Optimizing slow queries
- Rolling back migrations
