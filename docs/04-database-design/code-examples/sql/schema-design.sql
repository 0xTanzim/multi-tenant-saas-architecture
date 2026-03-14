-- =====================================================
-- MULTI-TENANT DATABASE SCHEMA DESIGN
-- =====================================================
-- Shared schema model with tenant_id for logical isolation
-- All tables include tenant_id to enforce data boundaries
-- =====================================================

-- =====================================================
-- 1. PLATFORM TABLES (Global Scope, No Tenant ID)
-- =====================================================

-- Core users table (authentication identity)
-- Shared across all tenants
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  hashed_email VARCHAR(128) NOT NULL,
  name VARCHAR(255) NOT NULL,
  avatar_url TEXT,

  -- Account status
  email_verified BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_created_at ON users(created_at);

-- Tenant registry (who owns which salon/business)
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,

  -- Basic info
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  type VARCHAR(50) NOT NULL, -- 'salon', 'individual_provider', etc.
  description TEXT,

  -- Contact
  email VARCHAR(255),
  phone VARCHAR(20),
  website VARCHAR(255),

  -- Location
  country_code VARCHAR(2) DEFAULT 'DK',
  city VARCHAR(100),
  address_line1 VARCHAR(255),
  postal_code VARCHAR(20),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),

  -- Owner (references users table)
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- Status
  status VARCHAR(20) DEFAULT 'active', -- active, suspended, inactive
  subscription_plan VARCHAR(50) DEFAULT 'free', -- free, starter, pro, enterprise

  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_owner_id ON tenants(owner_id);
CREATE INDEX idx_tenants_created_at ON tenants(created_at);

-- =====================================================
-- 2. TENANT-SCOPED TABLES (Isolated Per Tenant)
-- =====================================================

-- Customer profiles (one per tenant's customers)
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,

  -- Tenant reference (MANDATORY for all tenant-scoped tables)
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- Customer identity
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),

  -- Customer data
  date_of_birth DATE,
  gender VARCHAR(20),
  preferred_language VARCHAR(10) DEFAULT 'en',

  -- Communication preferences
  accepts_marketing BOOLEAN DEFAULT TRUE,
  accepts_sms BOOLEAN DEFAULT FALSE,
  accepts_push_notifications BOOLEAN DEFAULT FALSE,

  -- Customer loyalty
  loyalty_balance DECIMAL(10, 2) DEFAULT 0.00,
  total_spent DECIMAL(10, 2) DEFAULT 0.00,

  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_customers_tenant_id ON customers(tenant_id);
CREATE UNIQUE INDEX idx_customers_tenant_email
  ON customers(tenant_id, email)
  WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_created_at ON customers(created_at);

-- Staff profiles (shared identity for staff members)
CREATE TABLE staff_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  professional_title VARCHAR(100),
  bio TEXT,
  certifications JSONB, -- Array of certification records
  years_experience INTEGER,

  -- Contact
  phone VARCHAR(20),
  email VARCHAR(255),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_staff_profiles_user_id ON staff_profiles(user_id);

-- Staff employments (staff member's relationship with tenant/salon)
CREATE TABLE staff_employments (
  id SERIAL PRIMARY KEY,

  -- Tenant reference
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- Staff reference
  staff_profile_id INTEGER NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,

  -- Employment details
  employee_id VARCHAR(50), -- Custom ID within tenant
  position VARCHAR(100) NOT NULL,
  employment_type VARCHAR(20) DEFAULT 'full_time', -- full_time, part_time, contract
  status VARCHAR(20) DEFAULT 'active', -- hired, active, suspended, terminated

  -- Permissions
  role VARCHAR(50) DEFAULT 'staff', -- staff, manager, owner
  can_manage_bookings BOOLEAN DEFAULT FALSE,
  can_manage_staff BOOLEAN DEFAULT FALSE,
  can_view_analytics BOOLEAN DEFAULT FALSE,

  -- Compensation
  hourly_rate DECIMAL(10, 2),
  commission_rate DECIMAL(5, 2),
  currency VARCHAR(3) DEFAULT 'DKK',

  -- Schedule constraints
  max_bookings_per_day INTEGER,
  max_hours_per_week INTEGER,
  min_hours_per_week INTEGER,
  max_advance_booking_days INTEGER DEFAULT 90,
  min_booking_notice_hours INTEGER DEFAULT 2,

  -- Booking rules
  auto_approve_bookings BOOLEAN DEFAULT FALSE,
  requires_deposit BOOLEAN DEFAULT FALSE,
  deposit_percentage DECIMAL(5, 2),
  cancellation_hours_notice INTEGER DEFAULT 24,

  -- Visibility
  is_visible_to_customers BOOLEAN DEFAULT TRUE,
  allow_direct_booking BOOLEAN DEFAULT TRUE,
  calendar_color VARCHAR(7) DEFAULT '#3b82f6',

  -- Dates
  start_date TIMESTAMP WITH TIME ZONE NOT NULL,
  end_date TIMESTAMP WITH TIME ZONE,
  probation_end_date TIMESTAMP WITH TIME ZONE,

  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Unique constraint: One active employment per staff per tenant
CREATE UNIQUE INDEX staff_employments_tenant_active_uq
  ON staff_employments(staff_profile_id, tenant_id)
  WHERE deleted_at IS NULL AND status IN ('hired', 'active', 'suspended');

-- Unique constraint: Employee ID unique within tenant
CREATE UNIQUE INDEX staff_employments_tenant_employee_id_uq
  ON staff_employments(tenant_id, employee_id)
  WHERE deleted_at IS NULL AND employee_id IS NOT NULL;

-- Other indexes
CREATE INDEX idx_staff_employments_tenant_id ON staff_employments(tenant_id);
CREATE INDEX idx_staff_employments_staff_profile_id ON staff_employments(staff_profile_id);
CREATE INDEX idx_staff_employments_status ON staff_employments(status) WHERE deleted_at IS NULL;

-- Services catalog (services offered by tenant)
CREATE TABLE services (
  id SERIAL PRIMARY KEY,

  -- Tenant reference
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- Service details
  name VARCHAR(255) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL,

  -- Pricing
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'DKK',

  -- Availability
  is_available BOOLEAN DEFAULT TRUE,
  is_bookable_by_customers BOOLEAN DEFAULT TRUE,

  -- Service categorization
  category VARCHAR(100),
  tags TEXT ARRAY,

  -- Display
  display_order INTEGER DEFAULT 0,

  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_services_tenant_id ON services(tenant_id);
CREATE INDEX idx_services_category ON services(category);
CREATE INDEX idx_services_available ON services(is_available) WHERE deleted_at IS NULL;

-- Bookings (appointments/reservations)
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,

  -- Tenant reference (MANDATORY)
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- References to other entities
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  primary_staff_employment_id INTEGER NOT NULL REFERENCES staff_employments(id) ON DELETE RESTRICT,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,

  -- Unique identifier
  booking_number VARCHAR(50) NOT NULL UNIQUE,

  -- Booking details
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  total_duration_minutes INTEGER NOT NULL,
  timezone VARCHAR(50) DEFAULT 'UTC',

  -- Status
  status VARCHAR(20) DEFAULT 'pending', -- pending, confirmed, completed, cancelled, no_show
  is_no_show BOOLEAN DEFAULT FALSE,

  -- Pricing
  service_price DECIMAL(10, 2) NOT NULL,
  total_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  discount_amount DECIMAL(10, 2) DEFAULT 0.00,
  tax_amount DECIMAL(10, 2) DEFAULT 0.00,
  currency VARCHAR(3) DEFAULT 'DKK',

  -- Payment
  payment_status VARCHAR(20) DEFAULT 'unpaid', -- unpaid, partial, paid, refunded

  -- Notes
  customer_notes TEXT,
  internal_notes TEXT,
  cancellation_reason TEXT,

  -- Timestamps for key events
  confirmed_at TIMESTAMP WITH TIME ZONE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  checked_in_at TIMESTAMP WITH TIME ZONE,
  checked_out_at TIMESTAMP WITH TIME ZONE,

  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_bookings_tenant_id ON bookings(tenant_id);
CREATE INDEX idx_bookings_customer_date ON bookings(customer_id, booking_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_bookings_staff_date ON bookings(primary_staff_employment_id, booking_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_bookings_tenant_status_date ON bookings(tenant_id, status, booking_date) WHERE deleted_at IS NULL;

-- Invoices (billing records)
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,

  -- Tenant reference
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- References
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Invoice details
  invoice_number VARCHAR(50) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,

  -- Amount
  subtotal DECIMAL(10, 2) NOT NULL,
  tax_amount DECIMAL(10, 2) DEFAULT 0.00,
  total_amount DECIMAL(10, 2) NOT NULL,
  amount_paid DECIMAL(10, 2) DEFAULT 0.00,
  currency VARCHAR(3) DEFAULT 'DKK',

  -- Status
  status VARCHAR(20) DEFAULT 'draft', -- draft, sent, paid, partially_paid, overdue, cancelled

  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_invoices_tenant_number ON invoices(tenant_id, invoice_number) WHERE deleted_at IS NULL;
CREATE INDEX idx_invoices_customer_date ON invoices(customer_id, invoice_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_invoices_status ON invoices(status) WHERE deleted_at IS NULL;

-- Payments (payment records)
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,

  -- Tenant reference
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- References
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Payment details
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'DKK',
  payment_method VARCHAR(50), -- credit_card, cash, bank_transfer, etc.

  -- External payment reference
  stripe_payment_intent_id VARCHAR(255),
  transaction_id VARCHAR(255),

  -- Status
  status VARCHAR(20) DEFAULT 'pending', -- pending, completed, failed, refunded

  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_payments_tenant_id ON payments(tenant_id);
CREATE INDEX idx_payments_customer_id ON payments(customer_id);
CREATE INDEX idx_payments_booking_id ON payments(booking_id);
CREATE INDEX idx_payments_status ON payments(status) WHERE deleted_at IS NULL;

-- Time off (staff vacation/sick leave)
CREATE TABLE time_off (
  id SERIAL PRIMARY KEY,

  -- Tenant reference
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- Staff reference
  staff_employment_id INTEGER NOT NULL REFERENCES staff_employments(id) ON DELETE CASCADE,

  -- Period
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,

  -- Type
  type VARCHAR(50), -- vacation, sick_leave, training, etc.
  reason VARCHAR(255),

  -- Approval workflow
  status VARCHAR(20) DEFAULT 'pending', -- pending, approved, rejected
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMP WITH TIME ZONE,

  -- Soft delete
  deleted_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_time_off_tenant_id ON time_off(tenant_id);
CREATE INDEX idx_time_off_staff_employment_id ON time_off(staff_employment_id);
CREATE INDEX idx_time_off_dates ON time_off(start_date, end_date);

-- =====================================================
-- 3. AUDIT TABLES
-- =====================================================

CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,

  -- Tenant reference
  tenant_id INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,

  -- Who made the change
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- What changed
  table_name VARCHAR(100) NOT NULL,
  record_id INTEGER NOT NULL,
  action VARCHAR(50) NOT NULL, -- INSERT, UPDATE, DELETE

  -- Changes
  old_values JSONB,
  new_values JSONB,

  -- Metadata
  ip_address INET,
  user_agent TEXT,

  -- Timestamp
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX idx_audit_logs_table_name ON audit_logs(table_name);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- =====================================================
-- SUMMARY OF DESIGN PATTERNS
-- =====================================================
--
-- 1. TENANT ISOLATION
--    - Every tenant-scoped table has: tenant_id INT NOT NULL + FK to tenants(id)
--    - All queries filter by tenant_id
--    - ON DELETE CASCADE ensures data cleanup when tenant deleted
--
-- 2. SOFT DELETES
--    - deleted_at TIMESTAMP WITH TIME ZONE (NULL = active)
--    - Indexes use WHERE deleted_at IS NULL (partial index)
--    - Queries always filter: deleted_at IS NULL
--
-- 3. COMPOSITE INDEXES
--    - tenant_id FIRST: (tenant_id, other_columns)
--    - Commonly filtered columns included
--    - Soft delete always in WHERE clause
--
-- 4. UNIQUE CONSTRAINTS WITH TENANT SCOPE
--    - (tenant_id, column) not just (column)
--    - Partial unique indexes exclude deleted_at IS NULL
--
-- 5. FOREIGN KEY STRATEGY
--    - ON DELETE CASCADE: For dependent records
--    - ON DELETE RESTRICT: For critical records (prevent deletion)
--    - ON DELETE SET NULL: For optional references
--
-- 6. AUDIT TRAIL
--    - created_at, updated_at on all tables
--    - deleted_at for soft deletes
--    - Separate audit_logs table for sensitive changes
--
