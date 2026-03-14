-- =====================================================
-- MULTI-TENANT DATABASE INDEXES
-- Performance-critical indexes for common query patterns
-- =====================================================

-- =====================================================
-- 1. TENANT SCOPE INDEXES
-- Every table needs a tenant_id index for basic filtering
-- =====================================================

CREATE INDEX idx_customers_tenant_id ON customers(tenant_id);
CREATE INDEX idx_staff_employments_tenant_id ON staff_employments(tenant_id);
CREATE INDEX idx_bookings_tenant_id ON bookings(tenant_id);
CREATE INDEX idx_services_tenant_id ON services(tenant_id);
CREATE INDEX idx_invoices_tenant_id ON invoices(tenant_id);
CREATE INDEX idx_payments_tenant_id ON payments(tenant_id);
CREATE INDEX idx_time_off_tenant_id ON time_off(tenant_id);

-- =====================================================
-- 2. COMPOSITE INDEXES (Tenant + Business Columns)
-- Pattern: (tenant_id, other_filter_columns) WHERE deleted_at IS NULL
-- =====================================================

-- Customer Queries: Get active customers by tenant
CREATE INDEX idx_customers_active
  ON customers(tenant_id)
  WHERE deleted_at IS NULL;

-- Customer by email (authentication)
CREATE UNIQUE INDEX idx_customers_tenant_email
  ON customers(tenant_id, email)
  WHERE deleted_at IS NULL AND email IS NOT NULL;

-- Staff Employment Queries: Get available staff
CREATE INDEX idx_staff_employments_tenant_active
  ON staff_employments(tenant_id, status)
  WHERE deleted_at IS NULL AND status IN ('hired', 'active');

-- Staff visible to customers (for booking)
CREATE INDEX idx_staff_employments_tenant_visible
  ON staff_employments(tenant_id, is_visible_to_customers)
  WHERE deleted_at IS NULL
    AND is_visible_to_customers = true
    AND status = 'active';

-- Booking Queries: By customer and date (calendar view)
CREATE INDEX idx_bookings_customer_date
  ON bookings(tenant_id, customer_id, booking_date)
  WHERE deleted_at IS NULL;

-- Booking Queries: By staff and date (staff schedule)
CREATE INDEX idx_bookings_staff_date
  ON bookings(tenant_id, primary_staff_employment_id, booking_date)
  WHERE deleted_at IS NULL;

-- Booking Queries: By status and date (analytics)
CREATE INDEX idx_bookings_tenant_status_date
  ON bookings(tenant_id, status, booking_date)
  WHERE deleted_at IS NULL;

-- Booking Queries: All bookings for tenant (analytics, export)
CREATE INDEX idx_bookings_tenant_created
  ON bookings(tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Service Queries: Available services in tenant
CREATE INDEX idx_services_tenant_available
  ON services(tenant_id, is_available)
  WHERE deleted_at IS NULL;

-- Invoice Queries: By customer and date
CREATE UNIQUE INDEX idx_invoices_tenant_number
  ON invoices(tenant_id, invoice_number)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_invoices_customer_date
  ON invoices(tenant_id, customer_id, invoice_date DESC)
  WHERE deleted_at IS NULL;

-- Invoice Queries: By status (unpaid invoices, overdue, etc.)
CREATE INDEX idx_invoices_status
  ON invoices(tenant_id, status, due_date)
  WHERE deleted_at IS NULL;

-- Payment Queries: By customer (payment history)
CREATE INDEX idx_payments_customer_date
  ON payments(tenant_id, customer_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Payment Queries: By status (pending payments)
CREATE INDEX idx_payments_status
  ON payments(tenant_id, status)
  WHERE deleted_at IS NULL;

-- Time Off Queries: By staff member
CREATE INDEX idx_time_off_staff_dates
  ON time_off(tenant_id, staff_employment_id, start_date, end_date)
  WHERE deleted_at IS NULL;

-- Time Off Queries: Future time off (scheduling)
CREATE INDEX idx_time_off_future
  ON time_off(tenant_id, start_date)
  WHERE deleted_at IS NULL AND start_date >= CURRENT_DATE;

-- =====================================================
-- 3. LOOKUP INDEXES (Finding related records)
-- Pattern: Cross-tenant lookups without tenant_id
-- =====================================================

-- User lookups (authentication)
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;

-- Customer lookups by phone (deduplication, search)
CREATE INDEX idx_customers_phone ON customers(phone);

-- Staff profile lookups
CREATE UNIQUE INDEX idx_staff_profiles_user_id ON staff_profiles(user_id);

-- Tenant lookups by slug (URL routing)
CREATE UNIQUE INDEX idx_tenants_slug ON tenants(slug);

-- Tenant lookups by owner (user dashboard)
CREATE INDEX idx_tenants_owner_id ON tenants(owner_id);

-- Booking lookups by booking number (customer confirmation)
CREATE UNIQUE INDEX idx_bookings_booking_number ON bookings(booking_number);

-- Booking lookups by stripe payment intent (payment webhook)
CREATE INDEX idx_bookings_stripe_payment_intent
  ON bookings(stripe_payment_intent_id);

-- Payment lookups by stripe transaction (payment confirmation)
CREATE INDEX idx_payments_stripe_intent
  ON payments(stripe_payment_intent_id);

-- Booking lookups by related invoice (invoice details)
CREATE INDEX idx_bookings_invoice_reference
  ON bookings(booking_number) INCLUDE (total_amount, customer_id, tenant_id);

-- =====================================================
-- 4. PARTIAL INDEXES (For specific use cases)
-- Pattern: WHERE clause filters index to relevant subset
-- =====================================================

-- Pending bookings (action required)
CREATE INDEX idx_bookings_pending
  ON bookings(tenant_id, created_at DESC)
  WHERE status = 'pending' AND deleted_at IS NULL;

-- Completed bookings (revenue tracking)
CREATE INDEX idx_bookings_completed
  ON bookings(tenant_id, booking_date DESC)
  WHERE status = 'completed' AND deleted_at IS NULL;

-- No-shows (customer behavior analysis)
CREATE INDEX idx_bookings_no_show
  ON bookings(tenant_id, booking_date DESC)
  WHERE is_no_show = true AND deleted_at IS NULL;

-- Active staff (for customer booking interface)
CREATE INDEX idx_staff_active
  ON staff_employments(tenant_id, position)
  WHERE status = 'active' AND deleted_at IS NULL;

-- Unpaid invoices (billing dashboard)
CREATE INDEX idx_invoices_unpaid
  ON invoices(tenant_id, due_date)
  WHERE status IN ('unpaid', 'partially_paid', 'overdue')
    AND deleted_at IS NULL;

-- Overdue invoices (collections)
CREATE INDEX idx_invoices_overdue
  ON invoices(tenant_id, due_date)
  WHERE status IN ('unpaid', 'partially_paid')
    AND due_date < CURRENT_DATE
    AND deleted_at IS NULL;

-- Pending payments (reconciliation)
CREATE INDEX idx_payments_pending
  ON payments(tenant_id, created_at DESC)
  WHERE status = 'pending' AND deleted_at IS NULL;

-- Pending time off (HR workflow)
CREATE INDEX idx_time_off_pending
  ON time_off(tenant_id, created_at DESC)
  WHERE status = 'pending' AND deleted_at IS NULL;

-- Approved time off (scheduling)
CREATE INDEX idx_time_off_approved
  ON time_off(tenant_id, start_date, end_date)
  WHERE status = 'approved' AND deleted_at IS NULL;

-- =====================================================
-- 5. AGGREGATE/REPORTING INDEXES
-- Pattern: Optimized for SUM, COUNT, AVG queries
-- =====================================================

-- Revenue tracking: SUM(total_amount) GROUP BY booking_date
CREATE INDEX idx_bookings_revenue
  ON bookings(tenant_id, booking_date, status)
  WHERE status = 'completed' AND deleted_at IS NULL;

-- Staff performance: COUNT(*) GROUP BY staff_id
CREATE INDEX idx_bookings_by_staff
  ON bookings(tenant_id, primary_staff_employment_id, status, booking_date)
  WHERE deleted_at IS NULL;

-- Customer loyalty: SUM(total_amount) by customer
CREATE INDEX idx_bookings_by_customer
  ON bookings(tenant_id, customer_id, status, booking_date DESC)
  WHERE status = 'completed' AND deleted_at IS NULL;

-- Service popularity: COUNT(*) by service
CREATE INDEX idx_bookings_by_service
  ON bookings(tenant_id, service_id, booking_date)
  WHERE deleted_at IS NULL;

-- =====================================================
-- 6. UNIQUE CONSTRAINTS (Prevent duplicates)
-- Pattern: (tenant_id, business_key) WITH SOFT DELETE
-- =====================================================

-- One active employment per staff per tenant
CREATE UNIQUE INDEX staff_employments_tenant_active_uq
  ON staff_employments(staff_profile_id, tenant_id)
  WHERE deleted_at IS NULL AND status IN ('hired', 'active', 'suspended');

-- Employee ID unique within tenant
CREATE UNIQUE INDEX staff_employments_tenant_employee_id_uq
  ON staff_employments(tenant_id, employee_id)
  WHERE deleted_at IS NULL AND employee_id IS NOT NULL;

-- Email unique per tenant (optional per schema)
CREATE UNIQUE INDEX customers_tenant_email_uq
  ON customers(tenant_id, email)
  WHERE deleted_at IS NULL AND email IS NOT NULL;

-- Invoice number unique within tenant
CREATE UNIQUE INDEX invoices_tenant_number_uq
  ON invoices(tenant_id, invoice_number)
  WHERE deleted_at IS NULL;

-- User email unique globally
CREATE UNIQUE INDEX users_email_uq
  ON users(email)
  WHERE deleted_at IS NULL;

-- =====================================================
-- 7. FOREIGN KEY INDEXES (For JOIN performance)
-- Note: PostgreSQL automatically indexes PK side of FK
--       but you may want explicit indexes on FK columns
-- =====================================================

-- Speed up JOIN: bookings.customer_id -> customers.id
CREATE INDEX idx_bookings_customer_id ON bookings(customer_id);

-- Speed up JOIN: bookings.primary_staff_employment_id -> staff_employments.id
CREATE INDEX idx_bookings_staff_employment_id ON bookings(primary_staff_employment_id);

-- Speed up JOIN: bookings.service_id -> services.id
CREATE INDEX idx_bookings_service_id ON bookings(service_id);

-- Speed up JOIN: invoices.customer_id -> customers.id
CREATE INDEX idx_invoices_customer_id ON invoices(customer_id);

-- Speed up JOIN: invoices.booking_id -> bookings.id
CREATE INDEX idx_invoices_booking_id ON invoices(booking_id);

-- Speed up JOIN: payments.customer_id -> customers.id
CREATE INDEX idx_payments_customer_id ON payments(customer_id);

-- Speed up JOIN: staff_employments.staff_profile_id -> staff_profiles.id
CREATE INDEX idx_staff_employment_staff_profile ON staff_employments(staff_profile_id);

-- =====================================================
-- 8. AUDIT INDEXES
-- Pattern: Fast lookups for audit queries
-- =====================================================

CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX idx_audit_logs_table_action
  ON audit_logs(table_name, action, created_at DESC);
CREATE INDEX idx_audit_logs_user_date
  ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_date
  ON audit_logs(created_at DESC);

-- =====================================================
-- INDEX MAINTENANCE QUERIES
-- =====================================================

-- List all indexes (to verify they're created)
-- SELECT schemaname, tablename, indexname
-- FROM pg_indexes
-- WHERE schemaname = 'public'
-- ORDER BY tablename, indexname;

-- Check index size (identify bloat)
-- SELECT schemaname, tablename, indexname,
--        pg_size_pretty(pg_relation_size(indexrelid)) AS size
-- FROM pg_indexes
-- WHERE schemaname = 'public'
-- ORDER BY pg_relation_size(indexrelid) DESC;

-- Check index usage (identify unused indexes)
-- SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
-- FROM pg_stat_user_indexes
-- WHERE schemaname = 'public'
-- ORDER BY idx_scan ASC;

-- Rebuild index (if bloated)
-- REINDEX INDEX CONCURRENTLY idx_bookings_customer_date;

-- =====================================================
-- QUERY EXECUTION PLAN EXAMPLES
-- Use EXPLAIN ANALYZE to verify index usage
-- =====================================================

-- Example 1: Verify customer lookup uses index
-- EXPLAIN ANALYZE
-- SELECT * FROM customers
-- WHERE tenant_id = 1 AND email = 'customer@example.com' AND deleted_at IS NULL;
-- Expected: Index Scan using idx_customers_tenant_email

-- Example 2: Verify booking date range uses index
-- EXPLAIN ANALYZE
-- SELECT * FROM bookings
-- WHERE tenant_id = 1
--   AND booking_date BETWEEN '2026-05-01' AND '2026-05-31'
--   AND deleted_at IS NULL
-- ORDER BY booking_date DESC;
-- Expected: Index Scan using idx_bookings_active

-- Example 3: Verify composite index with all columns
-- EXPLAIN ANALYZE
-- SELECT * FROM bookings
-- WHERE tenant_id = 1
--   AND primary_staff_employment_id = 42
--   AND booking_date = '2026-05-15'
--   AND deleted_at IS NULL;
-- Expected: Index Scan using idx_bookings_staff_date

-- =====================================================
-- INDEX STRATEGY SUMMARY
-- =====================================================
--
-- 1. TENANT_ID FIRST in all composite indexes
--    - Reduces search space dramatically
--    - Enables proper isolation
--
-- 2. SOFT DELETE (WHERE deleted_at IS NULL)
--    - Always include in index WHERE clause
--    - Keeps index small and fast
--
-- 3. COMMONLY FILTERED COLUMNS
--    - status, created_at, booking_date
--    - Included in composite index if frequently used together
--
-- 4. UNIQUE INDEXES for Business Keys
--    - (tenant_id, email) for deduplication
--    - (tenant_id, invoice_number) for uniqueness within tenant
--
-- 5. PARTIAL INDEXES for Specific States
--    - Pending, completed, unpaid
--    - Dramatically smaller than full index
--
-- 6. VERIFY WITH EXPLAIN ANALYZE
--    - Always check that indexes are actually used
--    - Look for "Index Scan" not "Seq Scan"
--
