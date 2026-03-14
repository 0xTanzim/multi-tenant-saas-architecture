> **Source**: Extracted from production system, sanitized for portfolio use
> **Original**: DoneByMe Service Setup & Staff Invitation Workflow
> **Status**: Production-Ready Implementation

# Business Service Setup & Staff Invitation Workflow

---

## 1. Executive Summary

This document defines the complete architecture for onboarding services in a multi-tenant SaaS platform, with emphasis on:

1. **Service Catalog Creation** — Defining offerings with pricing
2. **Staff Invitation** — Bringing team members into the platform
3. **Service-Staff Assignment** — Matching capabilities to demand
4. **Permission Configuration** — Role-based access control

---

## 2. Why Service Setup Comes First

```
Critical Success Path:
Tenant Registration → Service Setup → Staff Planning → Go Live
```

**Why Services BEFORE Staff?**

1. **Business Logic**: Can't hire without knowing what services to offer
2. **Budget Planning**: Pricing determines revenue projections and staffing budgets
3. **Skill Matching**: Service requirements define needed staff expertise
4. **Client Experience**: Complete service catalog ready from day one
5. **Revenue Model**: Services define the business's core offerings

---

## 3. Service Lifecycle Stages

### Stage 1: Tenant Onboarding

- Business owner registers
- Basic tenant profile setup
- Payment method configuration

### Stage 2: Service Catalog Setup ⚡ CRITICAL

- Owner defines service categories (Hair, Nails, Skincare, etc.)
- Creates individual services with pricing
- Sets up service requirements and policies
- Configures booking rules and durations

### Stage 3: Staff Structure Planning

- Owner reviews service catalog
- Determines staffing needs
- Plans staff roles and specializations

### Stage 4: Staff Invitation & Onboarding

- Send invitation emails to potential staff
- Staff account creation and profile setup
- Service assignment to qualified staff
- Permission and access configuration

### Stage 5: Operations Launch

- Staff training and system familiarization
- Soft launch with limited services
- Full operational launch

---

## 4. Service Management Architecture

### Service Setup Wizard Approach

```typescript
interface ServiceSetupWizard {
  step1_categories: ServiceCategory[]; // Select relevant categories
  step2_services: ServiceDefinition[]; // Define individual services
  step3_pricing: PricingStrategy; // Set pricing rules
  step4_policies: BusinessPolicies; // Cancellation, rescheduling
  step5_preview: ServiceCatalogPreview; // Review before activation
}
```

### Progressive Service Addition

1. **Minimum Viable Service Set**: Start with 3-5 core services
2. **Gradual Expansion**: Add services as staff expertise grows
3. **Market Testing**: Enable/disable services based on demand

### Service Template Strategy

Pre-configured service templates by business type:

```
Professional Services Salon
├── Initial Consultation (30min, $50)
├── Standard Service (60min, $100)
├── Premium Service (90min, $150)
└── Express Service (30min, $75)

Fitness Studio
├── Drop-in Class (60min, $25)
├── 5-Class Package ($100)
├── Monthly Unlimited ($150)
└── Personal Training (60min, $100)

Medical Practice
├── New Patient Exam (60min, $200)
├── Follow-up Visit (30min, $100)
├── Telehealth Consultation (30min, $75)
└── Procedure (variable)
```

---

## 5. Service Data Model

### Core Service Schema

```typescript
service {
  id: unique identifier
  name: string              // "Haircut", "Color Treatment"
  category: string          // "hair_cut", "hair_color"
  base_price: decimal       // 250.00 (in tenant's currency)
  currency: string          // "DKK", "USD", "EUR"

  duration_minutes: integer // 60
  is_bookable_online: bool  // true/false
  display_order: integer    // UI ordering

  requires_deposit: bool    // pre-payment required?
  cancellation_policy: JSON // advance notice, refund rules

  is_active: bool           // soft enable/disable
  tenant_id: foreign_key    // multi-tenant isolation
}
```

### Supporting Tables

| Table                   | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `service_categories`    | Service groupings (Hair, Nails, Skincare)       |
| `service_bundles`       | Package deals ("Bridal Package", "Intro Combo") |
| `service_availability`  | Time-based availability rules                   |
| `staff_services`        | Which staff can provide which services          |
| `service_pricing_rules` | Dynamic pricing (peak hours, loyalty discounts) |

---

## 6. Service Pricing Strategy

### Flat Rate (Simple)

```
Haircut: $45 (always)
Color: $120 (always)
```

### Time-Based Pricing

```
Peak Hours (11am-1pm): +20%
Weekend: +15%
Evening (6pm+): +10%
```

### Demand-Based Pricing

```
High Demand Season (summer): +25%
Low Demand Season (winter): -15%
```

### Loyalty Discounts

```
Loyal Customer Tier 1 (5+ visits): -5%
Loyal Customer Tier 2 (20+ visits): -10%
VIP Member: -15%
```

### Service Bundles (Package Deals)

```
"Bridal Prep Package"
├── Haircut + Color (normally $170) = $150 (12% off)
├── Hair Treatment (normally $80) = included
├── Makeup (normally $60) = included
Total: $150 (normally $310, save $160)
```

---

## 7. Staff Invitation Workflow

### Entry Point: Staff Management Page

```
┌─────────────────────────────────┐
│  Staff Management               │
├─────────────────────────────────┤
│                                 │
│  Current Staff: 3               │
│  ┌──────────────────────────┐   │
│  │ Sarah (Manager)          │   │
│  │ John (Stylist)           │   │
│  │ Maria (Nail Technician)  │   │
│  └──────────────────────────┘   │
│                                 │
│  [+ Invite New Staff Member]    │
│                                 │
│  Pending Invitations: 1         │
│  ┌──────────────────────────┐   │
│  │ alex@example.com         │   │
│  │ (Sent Feb 18, expires Mar 4) │
│  │ [Resend]  [Revoke]       │   │
│  └──────────────────────────┘   │
│                                 │
└─────────────────────────────────┘
```

### Invitation Flow Sequence

```
Owner clicks [+ Invite Staff]
    ↓
Invitation form opens:
  Email: alex@example.com
  Role: [Stylist ▾]
  Services: ☑ Haircut ☑ Color ☐ Treatment
    ↓
Owner clicks "Send Invitation"
    ↓
Backend generates unique invitation link:
  https://app.example.com/invite/token-abc123
    ↓
Email sent to alex@example.com:
  "Join [Business Name] as a Stylist"
  [Accept Invitation]  [Decline]
    ↓
Alex clicks [Accept Invitation]
    ↓
Alex creates account / password
    ↓
Alex account activated ✅
    ↓
Backend assigns services (Haircut, Color)
    ↓
Alex can now log in and see assigned services
```

---

## 8. Role-Based Staff Management

### Role Hierarchy

| Role           | Permissions                                               | Scope             |
| -------------- | --------------------------------------------------------- | ----------------- |
| **Owner**      | Full platform access, billing, staff management           | Entire business   |
| **Manager**    | Bookings, staff, customers, reports (not payments)        | Entire business   |
| **Staff**      | View own schedule, log time off, access assigned services | Own bookings only |
| **Contractor** | View own schedule, assigned services                      | Own bookings only |

### Service Assignment by Role

| Role       | Can Provide Services | Can Edit Services | Can Invite Staff    |
| ---------- | -------------------- | ----------------- | ------------------- |
| Owner      | Yes                  | Yes               | Yes                 |
| Manager    | Yes (if qualified)   | No                | Yes (with approval) |
| Staff      | Yes (if assigned)    | No                | No                  |
| Contractor | Yes (if assigned)    | No                | No                  |

---

## 9. Key Architectural Patterns

### 1. Service-First Approach

**Why Services Before Staff?**

- Business logic foundation
- Budget planning prerequisite
- Role definition enabler
- Client experience baseline

### 2. Template-Based Service Creation

**Benefits:**

- Quick setup (5-10 minutes)
- Best practices pre-loaded
- Industry-standard pricing suggestions
- Consistency across tenants
- Full customization available

### 3. Progressive Service Activation

**Recommended Flow:**

1. Minimum Viable Services (3-5 core offerings)
2. Staff Assignment (match available staff to services)
3. Gradual Expansion (add services as staff expertise grows)
4. Performance Optimization (enable/disable based on demand)

---

## 10. Implementation Phases

### Phase 1: Core Service Management (Week 1-2)

- [ ] Service creation forms with category selection
- [ ] Service pricing configuration
- [ ] Service policy setup (cancellation, rescheduling)
- [ ] Service activation/deactivation UI
- [ ] Service list management

### Phase 2: Staff Invitation & Management (Week 2-3)

- [ ] Staff invitation form + email template
- [ ] Invitation token generation and validation
- [ ] Account creation from invitation
- [ ] Service-staff assignment UI
- [ ] Role-based permission configuration

### Phase 3: Service Templates (Week 3-4)

- [ ] Pre-configured templates by business type
- [ ] One-click template application
- [ ] Template customization UI
- [ ] Template library management

### Phase 4: Advanced Features (Week 4-5)

- [ ] Dynamic pricing rules
- [ ] Service bundles (package deals)
- [ ] Staff availability scheduling
- [ ] Service availability windows

---

## 11. Database Schema

### Essential Tables

```sql
-- Services
CREATE TABLE tenant_services (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id),
  name VARCHAR(100),
  category VARCHAR(50),
  base_price DECIMAL(10, 2),
  currency VARCHAR(3),
  duration_minutes INTEGER,
  is_bookable_online BOOLEAN,
  is_active BOOLEAN,
  display_order INTEGER
);

-- Staff-Service Assignments
CREATE TABLE staff_services (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER REFERENCES staff_profiles(id),
  service_id INTEGER REFERENCES tenant_services(id),
  proficiency_level VARCHAR(50), -- 'expert', 'experienced', 'learning'
  is_active BOOLEAN,
  created_at TIMESTAMP
);

-- Staff Invitations
CREATE TABLE staff_invitations (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id),
  email VARCHAR(255),
  role VARCHAR(50),
  invitation_token VARCHAR(255) UNIQUE,
  invited_by INTEGER REFERENCES users(id),
  accepted_at TIMESTAMP,
  expires_at TIMESTAMP,
  created_at TIMESTAMP
);
```

---

## 12. Success Criteria

- [ ] Service setup completes in < 10 minutes
- [ ] Staff invitation sent within 30 seconds
- [ ] New staff can login within 5 minutes of accepting invitation
- [ ] Service-staff assignments take < 2 minutes
- [ ] 0 errors in service availability calculation
- [ ] 100% invitation delivery rate (no bounces)
- [ ] Support tickets about setup < 5% of new tenants
