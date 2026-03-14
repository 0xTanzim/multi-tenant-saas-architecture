# Troubleshooting Multi-Tenant Systems

Common issues developers encounter when building multi-tenant systems, with diagnostic steps and solutions.

---

## Data & Isolation Issues

### Issue: Data Leak — Tenant A Sees Tenant B's Data

**Severity:** CRITICAL

**Symptoms:**

- Tenant A queries return data belonging to Tenant B
- Permission checks aren't stopping the leak
- Issue manifests inconsistently (only some records leak)

**Root causes (in order of likelihood):**

1. **Missing `tenant_id` filter in query**

   ```typescript
   // ❌ Wrong
   const bookings = await db.select().from(bookingsTable);

   // ✅ Correct
   const bookings = await db
     .select()
     .from(bookingsTable)
     .where(eq(bookingsTable.tenantId, tenantId));
   ```

   **Fix:** Add `WHERE tenant_id = ?` to every query

2. **`tenant_id` from client input instead of JWT**

   ```typescript
   // ❌ Wrong
   const tenantId = req.body.tenant_id; // Trusting client!

   // ✅ Correct
   const tenantId = req.user.tenantId; // From JWT
   ```

   **Fix:** Always extract tenant from JWT, never from request body

3. **Cache key doesn't include `tenant_id`**

   ```typescript
   // ❌ Wrong
   const key = `booking:${bookingId}`;

   // ✅ Correct
   const key = `booking:${tenantId}:${bookingId}`;
   ```

   **Fix:** Include `tenantId` in all cache keys

4. **Missing foreign key constraint**

   ```sql
   -- ❌ Wrong
   ALTER TABLE services
   ADD FOREIGN KEY (staff_id) REFERENCES staff(id);

   -- ✅ Correct
   ALTER TABLE services
   ADD FOREIGN KEY (tenant_id, staff_id)
   REFERENCES staff(tenant_id, id);
   ```

   **Fix:** Composite foreign keys prevent cross-tenant references

5. **ORM lazy loading bypassing tenant filter**

   ```typescript
   // ❌ If booking.getStaff() doesn't filter by tenantId
   const staff = await booking.getStaff();

   // ✅ Explicit filtered query
   const staff = await db
     .select()
     .from(staffTable)
     .where(
       and(
         eq(staffTable.tenantId, tenantId),
         eq(staffTable.id, booking.staffId),
       ),
     );
   ```

   **Fix:** Avoid ORM lazy loading; explicitly query with tenant filter

**Diagnosis steps:**

1. Enable query logging: `DEBUG=drizzle:*`
2. Look for queries missing `WHERE tenant_id = ?`
3. Check JWT extraction in middleware
4. Verify cache keys include tenant_id
5. Test with multiple tenants simultaneously

**Prevention:**

- Code review checklist: "Does this query filter by tenant_id?"
- Unit tests with multiple tenants
- Integration tests that verify isolation
- Database constraints enforcing composite keys

**See also:** [Security & Isolation](../04-security-isolation/)

---

### Issue: Permission Denied Unexpectedly

**Severity:** MEDIUM

**Symptoms:**

- User is trying an action they should have permission for
- Gets 403 Forbidden or permission denied error
- Same user, same role works in different tenant

**Root causes:**

1. **RBAC cache is stale**

   ```typescript
   // User's role was updated, but cache still has old permissions
   const permissions = cache.get(`role:${roleId}`); // Old data
   ```

   **Fix:**

   ```typescript
   // Clear cache when role changes
   await cache.delete(`role:${roleId}`);
   ```

2. **Role doesn't have permission in this tenant**

   ```sql
   -- User is Admin in Tenant A, but Guest in Tenant B
   SELECT * FROM user_roles WHERE user_id = X AND tenant_id = 'A'
   -- Returns: Admin

   SELECT * FROM user_roles WHERE user_id = X AND tenant_id = 'B'
   -- Returns: Guest
   ```

   **Fix:** Verify role assignment for the specific tenant

   ```sql
   SELECT ur.role_id, r.permissions
   FROM user_roles ur
   JOIN roles r ON ur.role_id = r.id
   WHERE ur.user_id = ? AND ur.tenant_id = ?;
   ```

3. **Permission was deleted or renamed**

   ```typescript
   // Code checks for 'view_analytics' but permission is now 'analytics:view'
   const hasPermission = permissions.includes('view_analytics');
   ```

   **Fix:** Verify permission name hasn't changed in the database

4. **Hierarchical role inheritance broken**
   ```sql
   -- Admin should inherit all Staff permissions, but doesn't
   SELECT * FROM role_inheritance
   WHERE parent_role_id = (SELECT id FROM roles WHERE name = 'Admin');
   ```
   **Fix:** Verify inheritance chain is complete

**Diagnosis steps:**

1. Check user's role in this tenant: `SELECT * FROM user_roles WHERE user_id = X AND tenant_id = Y`
2. Check role's permissions: `SELECT * FROM role_permissions WHERE role_id = X`
3. Check inheritance: `SELECT * FROM role_inheritance WHERE parent_role_id OR child_role_id = X`
4. Clear cache: `cache.delete(permission_key)`
5. Try again

**Prevention:**

- Include tenant_id in every permission query
- Document role hierarchy
- Add tests for each role's permissions
- Alert on permission cache misses

**See also:** [Security & Isolation](../04-security-isolation/)

---

### Issue: Cache Inconsistencies Across Tenants

**Severity:** HIGH

**Symptoms:**

- Tenant A's cache has Tenant B's data
- User switches tenants, gets wrong cached data
- Cache clearing doesn't fix the issue

**Root cause:**
Cache key doesn't include `tenant_id`, so tenants collide.

```typescript
// ❌ Problem
const booking = cache.get(`booking:${bookingId}`);
// Key "booking:123" could be from ANY tenant

// ✅ Solution
const booking = cache.get(`booking:${tenantId}:${bookingId}`);
// Key "booking:tenant-a:123" is unique per tenant
```

**Diagnosis:**

1. List cache keys: `redis-cli KEYS *`
2. Look for keys missing tenant prefix
3. Check Redis memory: `redis-cli INFO memory`

**Fix:**

1. Update all cache keys to include `tenantId` prefix
2. Clear existing cache: `redis-cli FLUSHDB` (be careful in production)
3. Verify new keys have tenant prefix: `redis-cli KEYS tenant-*`
4. Monitor for collisions

**Prevention:**

- Utility function for cache keys: `cacheKey(feature, tenantId, ...parts)`
- Code review: "Does cache key include tenant_id?"
- Tests with multiple tenants hitting cache

---

## Permission & Authorization Issues

### Issue: User Can Edit Other Tenant's Data

**Severity:** CRITICAL

**Symptoms:**

- User A can modify records owned by Tenant B
- Update request succeeds but affects wrong data
- Authorization check is passing incorrectly

**Root causes:**

1. **No ownership check before update**

   ```typescript
   // ❌ Wrong
   const booking = await db
     .update(bookingsTable)
     .set(data)
     .where(eq(bookingsTable.id, bookingId));

   // ✅ Correct
   const booking = await db
     .update(bookingsTable)
     .set(data)
     .where(
       and(
         eq(bookingsTable.id, bookingId),
         eq(bookingsTable.tenantId, tenantId),
       ),
     );
   ```

   **Fix:** Include `tenant_id` in WHERE clause for all mutations

2. **Authorization middleware placed after business logic**

   ```typescript
   // ❌ Wrong order
   router.put('/bookings/:id', (req, res) => {
     const booking = updateBooking(req.params.id); // Not authorized yet!
     checkPermission(req.user, booking);
   });

   // ✅ Correct order
   router.put(
     '/bookings/:id',
     authMiddleware,
     permissionMiddleware('edit_booking'),
     (req, res) => updateBooking(req.params.id),
   );
   ```

   **Fix:** Check permissions BEFORE executing action

3. **Soft-delete records accessible to other tenants**

   ```sql
   -- ❌ Wrong
   SELECT * FROM bookings WHERE deleted_at IS NULL;

   -- ✅ Correct
   SELECT * FROM bookings
   WHERE deleted_at IS NULL AND tenant_id = ?;
   ```

   **Fix:** Include `deleted_at` AND `tenant_id` filters

**Diagnosis steps:**

1. Check audit log: Who made changes and when?
   ```sql
   SELECT * FROM audit_logs WHERE resource_id = ? ORDER BY created_at DESC;
   ```
2. Verify update query has both `id` and `tenant_id`:
   ```typescript
   console.log(updateBooking.toSQL()); // See generated SQL
   ```
3. Check middleware order in routing config
4. Trace JWT: Is tenant_id correct?

**Prevention:**

- Always include `tenant_id` in WHERE clause for mutations
- Write to audit log on every data change
- Test: "Can User A edit User B's data?" (should be NO)
- Run this query in tests:
  ```sql
  SELECT * FROM bookings WHERE tenant_id != ? AND modified_by = ?;
  -- Should return 0 rows
  ```

---

### Issue: N+1 Query Problem with Multi-Tenant Filtering

**Severity:** MEDIUM

**Symptoms:**

- Booking detail page loads slowly (3-5 seconds)
- Query count is very high (50+ queries for 10 items)
- Database CPU is high

**Root cause:**
Loading related data in a loop, missing joins.

```typescript
// ❌ N+1 Problem
const bookings = await db
  .select()
  .from(bookingsTable)
  .where(eq(bookingsTable.tenantId, tenantId));

for (const booking of bookings) {
  booking.customer = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, booking.customerId));
  // ← One query per booking!
}

// ✅ Solved with JOIN
const bookings = await db
  .select()
  .from(bookingsTable)
  .leftJoin(
    customersTable,
    and(
      eq(bookingsTable.customerId, customersTable.id),
      eq(customersTable.tenantId, tenantId), // ← Must include tenant
    ),
  )
  .where(eq(bookingsTable.tenantId, tenantId));
```

**Diagnosis:**

1. Enable query logging: `DEBUG=drizzle:*`
2. Count queries: How many for one page load?
3. Check query patterns: Do you see the same query repeated?
4. Profile: `time curl http://localhost:3001/bookings` (check response time)

**Fix:**

1. Use JOIN instead of loop queries
2. Use batch loading: `db.select().where(inArray(customersTable.id, ids))`
3. Add indexes on foreign keys

**Prevention:**

- Query profiling on every feature
- Alert if query count > 50 for a page
- Database-level query plan analysis
- Load testing with real data volumes

**See also:** [Scaling & Performance](../08-scaling-performance/)

---

## API & Integration Issues

### Issue: API Returns Different Data Based on Time of Day

**Severity:** HIGH

**Symptoms:**

- Same API call returns different results at different times
- Data is correct but inconsistent
- Pagination seems broken

**Root cause:**
Cache TTL or stale reads from read replica.

**Diagnosis:**

1. Check cache TTL:
   ```typescript
   const ttl = redis.ttl(`booking:${tenantId}:${id}`);
   console.log(`Cache expires in ${ttl} seconds`);
   ```
2. Check if using read replica:
   ```typescript
   // Is this querying a read replica?
   const booking = await readDb.select()...
   ```
3. Check replication lag:
   ```sql
   -- On read replica
   SELECT EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp()))
   AS replication_lag_seconds;
   ```

**Fix:**

1. For real-time data, don't cache or use short TTL
2. Read from primary (not replica) for sensitive operations
3. Check replica lag before querying
4. Add cache invalidation on write

---

### Issue: Pagination Cursor Doesn't Work Across Tenants

**Severity:** MEDIUM

**Symptoms:**

- Cursor from Tenant A's request doesn't work in Tenant B
- Results seem to repeat or skip
- Page boundaries are inconsistent

**Root cause:**
Cursor isn't tenant-scoped.

```typescript
// ❌ Wrong
const cursor = booking.id; // Could be from any tenant

// ✅ Correct
const cursor = `${tenantId}:${booking.id}`;
```

**Fix:**

1. Include `tenantId` in cursor
2. Verify cursor still belongs to same tenant
3. Test cursor across tenant boundaries

---

## Deployment & Operations Issues

### Issue: Zero-Downtime Deployment Fails for Multi-Tenant System

**Severity:** MEDIUM

**Symptoms:**

- Some requests fail during deployment
- Data inconsistency after rolling update
- One tenant gets error while another works

**Root cause:**
Multiple API versions running simultaneously with incompatible schemas.

**Fix:**

1. **Backward-compatible migrations** — Never remove columns
2. **Version negotiation** — Old clients work with new API
3. **Separate schema migration** — Migrate before code deployment
4. **Rollback plan** — Always have a way to go back

**See also:** [Deployment & Operations](../06-deployment-operations/)

---

### Issue: Database Connection Pool Exhausted

**Severity:** HIGH

**Symptoms:**

- "too many connections" errors
- Performance degrades under load
- Connections not being returned

**Root cause:**
Connection leaks or pool size too small.

```typescript
// ❌ Leak — connection never returned
const connection = pool.acquire();
const result = db.query(connection, sql);
// ← Forgot to connection.release()!

// ✅ Correct
const connection = await pool.acquire();
try {
  const result = await db.query(connection, sql);
  return result;
} finally {
  await connection.release(); // ← Always release
}
```

**Diagnosis:**

```sql
SELECT count(*) FROM pg_stat_activity;
-- Compare to max_connections setting
SHOW max_connections;
```

**Fix:**

1. Increase pool size if legitimate load
2. Find connection leaks in code
3. Set timeout for idle connections
4. Monitor connection count over time

---

## Testing & Debugging

### How to Debug Tenant Isolation Issues

**Systematic approach:**

1. **Enable query logging**

   ```bash
   DEBUG=drizzle:* npm run dev
   ```

2. **Check the generated SQL**

   ```
   query: SELECT "id", "tenant_id", "name" FROM "bookings"
   WHERE "bookings"."tenant_id" = $1
   params: ["tenant-a"]
   ```

   Look for `WHERE tenant_id = ?` in every query.

3. **Test with multiple tenants**

   ```typescript
   const bookingA = await createBooking({tenantId: 'a', ...});
   const bookingB = await createBooking({tenantId: 'b', ...});

   // Query as Tenant A
   const results = await getBookings({tenantId: 'a'});
   expect(results).toContainEqual(bookingA);
   expect(results).not.toContainEqual(bookingB);
   ```

4. **Check the database directly**

   ```sql
   SELECT * FROM bookings WHERE id = 'booking-123';
   -- What's the actual tenant_id?
   ```

5. **Review JWT**

   ```typescript
   const decoded = jwt.decode(token);
   console.log(decoded); // Is tenant_id correct?
   ```

6. **Add temporary logging**
   ```typescript
   console.log('Query tenant_id:', tenantId);
   console.log('Generated SQL:', query.toSQL());
   ```

---

## Performance Issues

### Query Takes 2+ Seconds

**Diagnosis:**

```sql
EXPLAIN ANALYZE
SELECT * FROM bookings
WHERE tenant_id = 'tenant-a'
AND created_at > NOW() - INTERVAL '30 days';
```

Look for "Seq Scan" — that's a missing index.

**Fix:**

```sql
CREATE INDEX idx_bookings_tenant_created
ON bookings(tenant_id, created_at DESC);
```

---

### Memory Usage Growing Continuously

**Likely cause:** Cache leak or query result accumulation.

**Diagnosis:**

```javascript
// Node.js process memory
console.log(process.memoryUsage());

// Redis memory
redis-cli INFO memory

// Database connections
SELECT count(*) FROM pg_stat_activity;
```

**Fix:**

1. Clear cache periodically
2. Limit query result sets
3. Close unused connections
4. Profile with node --inspect

---

## When All Else Fails

### Debug Checklist

- [ ] Enable query logging (`DEBUG=drizzle:*`)
- [ ] Review generated SQL for `tenant_id` filter
- [ ] Check JWT extraction and tenant claim
- [ ] Verify cache keys include `tenant_id`
- [ ] Test with multiple tenants simultaneously
- [ ] Query database directly to verify data
- [ ] Check middleware order (auth before business logic)
- [ ] Review error logs and audit logs
- [ ] Profile queries with EXPLAIN ANALYZE
- [ ] Check database connections and pool

### Getting Help

1. **Reproduce with minimal example** — Isolated test case
2. **Enable full logging** — Show all SQL queries
3. **Share relevant code** — Service, repository, schema
4. **Describe expected vs. actual** — What should happen vs. what does
5. **Include error messages** — Full stack trace if available

---

## Prevention: Checklist for New Features

Before merging any feature:

- [ ] Does every SELECT filter by `tenant_id`?
- [ ] Does every INSERT explicitly set `tenant_id`?
- [ ] Does every UPDATE include `tenant_id` in WHERE?
- [ ] Does every DELETE include `tenant_id` in WHERE?
- [ ] Are related records scoped to same tenant (composite FK)?
- [ ] Is cache key tenant-scoped?
- [ ] Are there integration tests with 2+ tenants?
- [ ] Did JWT middleware run before business logic?
- [ ] Is `tenant_id` from JWT, never from request?
- [ ] Is sensitive data (cache, logs) tenant-scoped?

---

**Last updated:** 2025-01-15
Still stuck? Check [COMMON_QUESTIONS.md](./COMMON_QUESTIONS.md) or open an issue.
