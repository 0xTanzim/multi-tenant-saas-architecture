-- =====================================================
-- MULTI-TENANT DATA QUERIES
-- Common query patterns with explanations
-- =====================================================

-- =====================================================
-- 1. BASIC TENANT-SCOPED QUERIES
-- Pattern: Always filter by tenant_id + deleted_at IS NULL
-- =====================================================

-- Get all active customers for a tenant
SELECT *
FROM customers
WHERE tenant_id = 1
  AND deleted_at IS NULL
ORDER BY created_at DESC;

-- Get customer by email (authentication lookup)
SELECT *
FROM customers
WHERE tenant_id = 1
  AND email = 'customer@example.com'
  AND deleted_at IS NULL
LIMIT 1;

-- Get all active staff for a tenant
SELECT *
FROM staff_employments
WHERE tenant_id = 1
  AND status IN ('hired', 'active')
  AND deleted_at IS NULL
ORDER BY employee_id;

-- Get visible staff (for customer booking interface)
SELECT se.*, sp.*, u.name as hired_by_name
FROM staff_employments se
JOIN staff_profiles sp ON se.staff_profile_id = sp.id
JOIN users u ON se.hired_by = u.id
WHERE se.tenant_id = 1
  AND se.is_visible_to_customers = true
  AND se.status = 'active'
  AND se.deleted_at IS NULL
ORDER BY se.display_order, u.name;

-- =====================================================
-- 2. BOOKING QUERIES
-- Pattern: Combine tenant_id + business filter + deleted_at
-- =====================================================

-- Get bookings for a customer (customer portal)
SELECT b.*, c.name, se.position, u.name as staff_name, s.name as service_name
FROM bookings b
JOIN customers c ON b.customer_id = c.id
JOIN staff_employments se ON b.primary_staff_employment_id = se.id
JOIN users u ON se.hired_by = u.id
LEFT JOIN services s ON b.service_id = s.id
WHERE b.tenant_id = 1
  AND b.customer_id = 42
  AND b.deleted_at IS NULL
ORDER BY b.booking_date DESC;

-- Get bookings for a staff member on a date (staff calendar)
SELECT b.*, c.name as customer_name, c.phone as customer_phone, s.name as service_name
FROM bookings b
JOIN customers c ON b.customer_id = c.id
LEFT JOIN services s ON b.service_id = s.id
WHERE b.tenant_id = 1
  AND b.primary_staff_employment_id = 42
  AND b.booking_date = '2026-05-15'
  AND b.deleted_at IS NULL
ORDER BY b.start_time;

-- Get all bookings for a tenant in date range
SELECT b.*, c.name as customer_name, se.position, s.name as service_name
FROM bookings b
JOIN customers c ON b.customer_id = c.id
JOIN staff_employments se ON b.primary_staff_employment_id = se.id
LEFT JOIN services s ON b.service_id = s.id
WHERE b.tenant_id = 1
  AND b.booking_date BETWEEN '2026-05-01' AND '2026-05-31'
  AND b.deleted_at IS NULL
ORDER BY b.booking_date, b.start_time;

-- Get pending bookings (need manager approval)
SELECT b.*, c.name as customer_name, se.position, s.name as service_name
FROM bookings b
JOIN customers c ON b.customer_id = c.id
JOIN staff_employments se ON b.primary_staff_employment_id = se.id
LEFT JOIN services s ON b.service_id = s.id
WHERE b.tenant_id = 1
  AND b.status = 'pending'
  AND b.deleted_at IS NULL
ORDER BY b.created_at;

-- Get no-shows for analytics
SELECT b.booking_date,
       se.position,
       COUNT(*) as no_show_count,
       COUNT(*) FILTER (WHERE b.is_no_show) as no_shows
FROM bookings b
JOIN staff_employments se ON b.primary_staff_employment_id = se.id
WHERE b.tenant_id = 1
  AND b.is_no_show = true
  AND b.booking_date >= CURRENT_DATE - INTERVAL '30 days'
  AND b.deleted_at IS NULL
GROUP BY b.booking_date, se.position
ORDER BY b.booking_date DESC;

-- =====================================================
-- 3. ANALYTICS & REPORTING QUERIES
-- Pattern: Use aggregates with tenant_id filter
-- =====================================================

-- Revenue by day
SELECT b.booking_date,
       COUNT(*) as bookings_count,
       SUM(b.total_amount)::DECIMAL(10, 2) as total_revenue,
       AVG(b.total_amount)::DECIMAL(10, 2) as avg_booking_value
FROM bookings b
WHERE b.tenant_id = 1
  AND b.status = 'completed'
  AND b.booking_date >= CURRENT_DATE - INTERVAL '30 days'
  AND b.deleted_at IS NULL
GROUP BY b.booking_date
ORDER BY b.booking_date DESC;

-- Revenue by staff member
SELECT se.employee_id,
       u.name as staff_name,
       COUNT(b.id) as total_bookings,
       COUNT(b.id) FILTER (WHERE b.status = 'completed') as completed,
       SUM(b.total_amount)::DECIMAL(10, 2) as total_revenue,
       AVG(b.total_amount)::DECIMAL(10, 2) as avg_booking_value,
       COUNT(b.id) FILTER (WHERE b.is_no_show) as no_shows
FROM staff_employments se
LEFT JOIN users u ON se.hired_by = u.id
LEFT JOIN bookings b ON b.primary_staff_employment_id = se.id
  AND b.tenant_id = se.tenant_id
  AND b.deleted_at IS NULL
WHERE se.tenant_id = 1
  AND se.deleted_at IS NULL
  AND (b.booking_date IS NULL OR b.booking_date >= CURRENT_DATE - INTERVAL '90 days')
GROUP BY se.id, se.employee_id, u.name
ORDER BY total_revenue DESC;

-- Revenue by service
SELECT s.name,
       COUNT(b.id) as bookings,
       SUM(b.total_amount)::DECIMAL(10, 2) as total_revenue,
       AVG(b.total_amount)::DECIMAL(10, 2) as avg_price
FROM services s
LEFT JOIN bookings b ON b.service_id = s.id
  AND b.tenant_id = s.tenant_id
  AND b.status = 'completed'
  AND b.deleted_at IS NULL
WHERE s.tenant_id = 1
  AND s.deleted_at IS NULL
GROUP BY s.id, s.name
ORDER BY total_revenue DESC;

-- Customer loyalty (top customers by spending)
SELECT c.first_name,
       c.email,
       COUNT(b.id) as total_bookings,
       COUNT(b.id) FILTER (WHERE b.status = 'completed') as completed_bookings,
       SUM(b.total_amount)::DECIMAL(10, 2) as total_spent,
       MAX(b.booking_date) as last_booking_date
FROM customers c
LEFT JOIN bookings b ON b.customer_id = c.id
  AND b.tenant_id = c.tenant_id
  AND b.deleted_at IS NULL
WHERE c.tenant_id = 1
  AND c.deleted_at IS NULL
GROUP BY c.id, c.first_name, c.email
ORDER BY total_spent DESC;

-- Staff utilization (bookings per day vs max allowed)
SELECT se.employee_id,
       u.name,
       se.max_bookings_per_day,
       b.booking_date,
       COUNT(b.id) as bookings_count,
       CASE
         WHEN se.max_bookings_per_day IS NULL THEN 'No Limit'
         WHEN COUNT(b.id) >= se.max_bookings_per_day THEN 'At Capacity'
         ELSE 'Available'
       END as utilization_status
FROM staff_employments se
JOIN users u ON se.hired_by = u.id
LEFT JOIN bookings b ON b.primary_staff_employment_id = se.id
  AND b.tenant_id = se.tenant_id
  AND b.deleted_at IS NULL
  AND b.booking_date >= CURRENT_DATE
WHERE se.tenant_id = 1
  AND se.status = 'active'
  AND se.deleted_at IS NULL
GROUP BY se.id, se.employee_id, u.name, se.max_bookings_per_day, b.booking_date
ORDER BY b.booking_date DESC, se.employee_id;

-- =====================================================
-- 4. SOFT DELETE QUERIES
-- Pattern: Filter deleted_at column appropriately
-- =====================================================

-- Find recently deleted records (for recovery)
SELECT id, name, deleted_at,
       EXTRACT(DAY FROM NOW() - deleted_at) as days_since_deletion
FROM customers
WHERE tenant_id = 1
  AND deleted_at IS NOT NULL
  AND deleted_at >= NOW() - INTERVAL '30 days'
ORDER BY deleted_at DESC;

-- Recover deleted customer (restore)
UPDATE customers
SET deleted_at = NULL
WHERE id = 42
  AND tenant_id = 1
  AND deleted_at IS NOT NULL;

-- Hard delete old records (GDPR compliance - after retention period)
-- This is permanent, only do after careful review
DELETE FROM bookings
WHERE tenant_id = 1
  AND deleted_at IS NOT NULL
  AND deleted_at < NOW() - INTERVAL '7 years';

-- =====================================================
-- 5. PERMISSION & ACCESS CONTROL QUERIES
-- Pattern: Verify user has access before returning data
-- =====================================================

-- Get tenant for user (authorization check)
SELECT t.* FROM tenants t
JOIN staff_employments se ON se.tenant_id = t.id
JOIN staff_profiles sp ON sp.id = se.staff_profile_id
WHERE sp.user_id = 123  -- current_user_id
  AND se.status IN ('hired', 'active')
  AND se.deleted_at IS NULL
  AND t.deleted_at IS NULL;

-- Get user's permissions for a tenant
SELECT se.role,
       se.can_manage_bookings,
       se.can_manage_staff,
       se.can_view_analytics
FROM staff_employments se
JOIN staff_profiles sp ON sp.id = se.staff_profile_id
WHERE sp.user_id = 123
  AND se.tenant_id = 1
  AND se.status IN ('hired', 'active')
  AND se.deleted_at IS NULL
LIMIT 1;

-- =====================================================
-- 6. INVOICE & PAYMENT QUERIES
-- Pattern: Business process queries
-- =====================================================

-- Get unpaid invoices (collections)
SELECT i.*, c.name as customer_name, c.email, c.phone
FROM invoices i
JOIN customers c ON i.customer_id = c.id
WHERE i.tenant_id = 1
  AND i.status IN ('unpaid', 'partially_paid', 'overdue')
  AND i.deleted_at IS NULL
ORDER BY i.due_date;

-- Get overdue invoices (urgent collections)
SELECT i.*, c.name, c.email,
       EXTRACT(DAY FROM CURRENT_DATE - i.due_date) as days_overdue
FROM invoices i
JOIN customers c ON i.customer_id = c.id
WHERE i.tenant_id = 1
  AND i.status IN ('unpaid', 'partially_paid')
  AND i.due_date < CURRENT_DATE
  AND i.deleted_at IS NULL
ORDER BY i.due_date;

-- Get payment history for customer
SELECT p.*,
       CASE WHEN b.id IS NOT NULL THEN b.booking_number ELSE i.invoice_number END as reference,
       CASE WHEN b.id IS NOT NULL THEN 'Booking' ELSE 'Invoice' END as type
FROM payments p
LEFT JOIN bookings b ON p.booking_id = b.id
LEFT JOIN invoices i ON p.invoice_id = i.id
WHERE p.tenant_id = 1
  AND p.customer_id = 42
  AND p.deleted_at IS NULL
ORDER BY p.created_at DESC;

-- Get outstanding balance (what customer owes)
SELECT c.name, c.email,
       COALESCE(SUM(i.total_amount - COALESCE(i.amount_paid, 0)), 0)::DECIMAL(10, 2) as outstanding_balance
FROM customers c
LEFT JOIN invoices i ON i.customer_id = c.id
  AND i.tenant_id = c.tenant_id
  AND i.status IN ('unpaid', 'partially_paid')
  AND i.deleted_at IS NULL
WHERE c.tenant_id = 1
  AND c.id = 42
  AND c.deleted_at IS NULL
GROUP BY c.id, c.name, c.email;

-- =====================================================
-- 7. TIME OFF & SCHEDULING QUERIES
-- Pattern: Availability and conflict checking
-- =====================================================

-- Get staff time off for date range (scheduling conflict check)
SELECT se.employee_id, u.name,
       to_start_date, to_end_date, to_type
FROM staff_employments se
JOIN users u ON se.hired_by = u.id
LEFT JOIN (
  SELECT staff_employment_id, start_date as to_start_date, end_date as to_end_date, type as to_type
  FROM time_off
  WHERE tenant_id = 1
    AND status = 'approved'
    AND deleted_at IS NULL
) to ON to.staff_employment_id = se.id
WHERE se.tenant_id = 1
  AND se.status = 'active'
  AND se.deleted_at IS NULL
  AND (to.to_start_date IS NULL OR to.to_start_date <= CURRENT_DATE + INTERVAL '90 days')
ORDER BY se.employee_id, to_start_date;

-- Check if staff member is available on date (for booking)
SELECT EXISTS (
  SELECT 1
  FROM staff_employments se
  LEFT JOIN time_off to ON to.staff_employment_id = se.id
    AND to.tenant_id = se.tenant_id
    AND to.status = 'approved'
    AND to.deleted_at IS NULL
  WHERE se.tenant_id = 1
    AND se.id = 42
    AND se.status = 'active'
    AND se.deleted_at IS NULL
    AND (to.id IS NULL
         OR NOT ('2026-05-15'::DATE BETWEEN to.start_date AND to.end_date))
) as is_available;

-- Pending time off requests (manager workflow)
SELECT to.*, se.employee_id, u.name as requested_by
FROM time_off to
JOIN staff_employments se ON to.staff_employment_id = se.id
JOIN staff_profiles sp ON sp.id = se.staff_profile_id
JOIN users u ON u.id = sp.user_id
WHERE to.tenant_id = 1
  AND to.status = 'pending'
  AND to.deleted_at IS NULL
ORDER BY to.created_at;

-- =====================================================
-- 8. AUDIT & COMPLIANCE QUERIES
-- Pattern: Track changes and access
-- =====================================================

-- Get audit trail for a record
SELECT al.action, al.old_values, al.new_values, u.name, al.created_at
FROM audit_logs al
LEFT JOIN users u ON al.user_id = u.id
WHERE al.tenant_id = 1
  AND al.table_name = 'bookings'
  AND al.record_id = 42
ORDER BY al.created_at DESC;

-- Get all changes made by a user
SELECT al.table_name, al.record_id, al.action, al.old_values, al.new_values, al.created_at
FROM audit_logs al
WHERE al.tenant_id = 1
  AND al.user_id = 123
  AND al.created_at >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY al.created_at DESC;

-- Get all deletions in a date range
SELECT al.table_name, al.record_id, u.name, al.created_at
FROM audit_logs al
LEFT JOIN users u ON al.user_id = u.id
WHERE al.tenant_id = 1
  AND al.action = 'DELETE'
  AND al.created_at >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY al.created_at DESC;

-- =====================================================
-- 9. BULK OPERATIONS (With caution!)
-- Pattern: Update many records efficiently
-- =====================================================

-- Mark many bookings as no-show (after deadline passed)
UPDATE bookings
SET is_no_show = true,
    no_show_recorded_at = NOW()
WHERE tenant_id = 1
  AND status NOT IN ('completed', 'cancelled')
  AND booking_date < CURRENT_DATE - INTERVAL '1 day'
  AND checked_in_at IS NULL
  AND deleted_at IS NULL;

-- Update customer loyalty points (bulk, after payment received)
UPDATE customers
SET loyalty_balance = loyalty_balance + 100
WHERE tenant_id = 1
  AND id IN (
    SELECT DISTINCT customer_id
    FROM payments
    WHERE tenant_id = 1
      AND status = 'completed'
      AND created_at >= NOW() - INTERVAL '1 hour'
      AND deleted_at IS NULL
  );

-- =====================================================
-- 10. PERFORMANCE VERIFICATION QUERIES
-- Use EXPLAIN ANALYZE to verify index usage
-- =====================================================

-- Verify index is used for customer lookup
-- EXPLAIN ANALYZE
-- SELECT * FROM customers
-- WHERE tenant_id = 1 AND email = 'test@example.com' AND deleted_at IS NULL;
-- Expected: Index Scan using idx_customers_tenant_email

-- Verify composite index for bookings
-- EXPLAIN ANALYZE
-- SELECT * FROM bookings
-- WHERE tenant_id = 1
--   AND primary_staff_employment_id = 42
--   AND booking_date = '2026-05-15'
--   AND deleted_at IS NULL;
-- Expected: Index Scan using idx_bookings_staff_date

-- Check for missing indexes (Seq Scan on large table = bad)
-- EXPLAIN ANALYZE
-- SELECT * FROM bookings
-- WHERE status = 'pending' AND deleted_at IS NULL;
-- If shows Seq Scan: Consider adding idx_bookings_pending

-- =====================================================
-- QUERY OPTIMIZATION PRINCIPLES
-- =====================================================
--
-- 1. ALWAYS filter by tenant_id first
--    - Reduces result set dramatically
--    - Ensures isolation
--
-- 2. ALWAYS filter by deleted_at IS NULL
--    - Soft delete support
--    - Indexes are partial (WHERE deleted_at IS NULL)
--
-- 3. USE INDEX hints when needed
--    - FORCE INDEX / USING in MySQL
--    - In PostgreSQL, indexes are chosen automatically
--
-- 4. USE EXPLAIN ANALYZE
--    - Verify every complex query
--    - Look for "Index Scan" not "Seq Scan"
--
-- 5. AVOID N+1 queries
--    - Use JOINs instead of loops
--    - Eager load relationships
--
-- 6. PAGINATE large result sets
--    - Use LIMIT + OFFSET for pagination
--    - Or use cursor-based pagination
--
-- 7. BATCH updates carefully
--    - Large updates can lock table
--    - Consider breaking into batches
--
