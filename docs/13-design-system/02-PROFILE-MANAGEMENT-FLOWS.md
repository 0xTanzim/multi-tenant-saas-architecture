# Design System: Multi-Role Profile & Account Navigation Architecture

**Version**: 1.0
**Last Updated**: 2025-10-10
**Status**: Active

---

## Overview

This document describes the navigation and information architecture for multi-role account management in the service booking platform. Users can have multiple roles (customer, owner, staff, admin), each with distinct workflows and data contexts.

---

## The Dual-Profile Model

### Core Principle: Two Independent Identities

Every user has:

1. **Personal/Customer Identity** (`/my/*`)

   - Books services as a consumer
   - Leaves reviews and ratings
   - Manages personal preferences
   - Purchases memberships
   - Cross-tenant visibility (sees all bookings everywhere)

2. **Professional/Business Identity** (`/dashboard/*`)
   - Manages business operations
   - Schedules staff and services
   - Views customer base
   - Single-tenant scope (one business at a time)
   - Only visible if user is employed/owns business

---

## Navigation Structure

### Desktop Sidebar Navigation

#### Customer Dashboard (`/my/*`)

```
┌─────────────────────┐
│ 👤 My Account       │  ← Header
├─────────────────────┤
│  🏠 Dashboard       │
│  📅 My Bookings     │
│  ⭐ Bookings        │
│  ❤️ Favorites       │
│  💬 Messages        │
├─────────────────────┤
│  👤 Profile         │
│  ⚙️ Settings        │
│  🎁 Loyalty         │
│  💳 Wallet          │
├─────────────────────┤
│  📞 Support         │
│  📋 About           │
│  🚪 Logout          │
└─────────────────────┘
```

#### Business Dashboard (`/dashboard/*`)

```
┌──────────────────────────┐
│ 📊 My Business           │  ← Header with business name
├──────────────────────────┤
│  Dashboard               │
│  📅 Calendar             │
│  📋 Bookings             │
│  👥 Staff                │
│  🛎️ Services             │
│  💰 Payments             │
│  📊 Reports              │
│  ⭐ Reviews              │
│  💬 Messages             │
├──────────────────────────┤
│  👤 My Profile           │
│  ⚙️ Settings             │
│  👥 Team Management      │
│  🏢 Business Settings    │
├──────────────────────────┤
│  📞 Support              │
│  🚪 Logout               │
└──────────────────────────┘
```

### Context Switcher (Navbar)

Located in top-right of navigation header:

```
┌────────────────────────────────────┐
│  [👤 john@example.com ▼]           │
├────────────────────────────────────┤
│  📝 My Account                     │
│  ⚙️ Settings                       │
│  ────────────────────────────────  │
│  📊 Partner Dashboard   [icon]     │ ← If employed
│     "Salon A" (active)             │
│  ────────────────────────────────  │
│  🚪 Logout                         │
└────────────────────────────────────┘
```

Clicking "Partner Dashboard" navigates to `/dashboard` and switches context.

---

## Route Hierarchy

### Customer Routes (`/my/*`)

```
/my
├── /my/dashboard           (overview of bookings, preferences)
├── /my/bookings            (list of all customer bookings)
│   └── /my/bookings/:id    (booking detail & reschedule)
├── /my/favorites           (saved service providers)
├── /my/messages            (inbox with service providers)
├── /my/profile             (view/edit personal details)
│   ├── /my/profile/edit    (edit name, email, photo)
│   └── /my/profile/phone   (manage phone number)
├── /my/settings            (preferences)
│   ├── /my/settings/notifications
│   ├── /my/settings/privacy
│   └── /my/settings/billing
├── /my/loyalty             (membership status, points)
├── /my/wallet              (payment methods, balance)
└── /my/help                (support & FAQ)
```

### Business Routes (`/dashboard/*`)

```
/dashboard
├── /dashboard/calendar     (staff schedule & bookings)
├── /dashboard/bookings     (all business bookings)
│   └── /dashboard/bookings/:id
├── /dashboard/staff        (team management)
│   ├── /dashboard/staff/new
│   └── /dashboard/staff/:id/edit
├── /dashboard/services     (service catalog)
│   ├── /dashboard/services/new
│   └── /dashboard/services/:id/edit
├── /dashboard/customers    (customer database)
│   └── /dashboard/customers/:id
├── /dashboard/payments     (transaction history)
├── /dashboard/reports      (analytics & metrics)
├── /dashboard/reviews      (customer feedback)
├── /dashboard/messages     (customer inbox)
├── /dashboard/profile      (business profile)
│   ├── /dashboard/profile/edit
│   └── /dashboard/profile/photo
├── /dashboard/settings     (business settings)
│   ├── /dashboard/settings/hours
│   ├── /dashboard/settings/policies
│   └── /dashboard/settings/team
└── /dashboard/help         (support & documentation)
```

### Admin Routes (`/admin/*`) — Platform Super Admins Only

```
/admin
├── /admin/tenants          (business management)
├── /admin/users            (user management & moderation)
├── /admin/analytics        (platform-wide metrics)
├── /admin/reports          (financial reports)
├── /admin/disputes         (customer disputes)
└── /admin/system           (platform configuration)
```

---

## Role-Based Access Control (RBAC)

### Component Responsibility Matrix

| Route Pattern  | Customer Role  | Owner Role     | Staff Role             | Admin Role     |
| -------------- | -------------- | -------------- | ---------------------- | -------------- |
| `/my/*`        | ✅ Full access | ✅ Full access | ✅ Full access         | ✅ Full access |
| `/dashboard/*` | ❌ Forbidden   | ✅ Full access | ✅ Limited (view only) | ✅ Full access |
| `/admin/*`     | ❌ Forbidden   | ❌ Forbidden   | ❌ Forbidden           | ✅ Full access |

### Access Rules

```typescript
// Guard: Can access /dashboard?
canAccessDashboard(user) {
  // Must have at least one active employment
  return user.employments.some(e => e.status === 'active');
}

// Guard: Can edit business settings?
canEditBusinessSettings(user, businessId) {
  // Must be owner or manager of this business
  const employment = user.employments.find(e => e.tenantId === businessId);
  return employment?.role === 'owner' || employment?.role === 'manager';
}

// Guard: Can access /admin?
canAccessAdmin(user) {
  // Must have super_admin or admin platform role
  return user.platformRole === 'super_admin' || user.platformRole === 'admin';
}
```

---

## Feature × Role × Path Decision Matrix

**Q: Should a feature appear on Customer or Business Dashboard?**

Use this matrix to decide:

| Feature                     | Path                      | Owner/Manager | Staff          | Customer |
| --------------------------- | ------------------------- | ------------- | -------------- | -------- |
| View personal bookings      | `/my/bookings`            | ✅            | ✅             | ✅       |
| View business bookings      | `/dashboard/bookings`     | ✅            | ✅ (read-only) | ❌       |
| Reschedule own booking      | `/my/bookings/:id`        | ✅            | ✅             | ✅       |
| Reschedule customer booking | `/dashboard/bookings/:id` | ✅            | ✅ (limited)   | ❌       |
| Manage staff                | `/dashboard/staff`        | ✅            | ❌             | ❌       |
| Edit services               | `/dashboard/services`     | ✅            | ❌             | ❌       |
| View all staff schedules    | `/dashboard/calendar`     | ✅            | ✅ (own slot)  | ❌       |
| Leave review                | `/my/bookings/:id/review` | ✅            | ✅             | ✅       |
| Respond to review           | `/dashboard/reviews/:id`  | ✅            | ❌             | ❌       |
| View personal profile       | `/my/profile`             | ✅            | ✅             | ✅       |
| Edit business profile       | `/dashboard/profile`      | ✅            | ✅ (limited)   | ❌       |

---

## UX Flows

### Flow 1: Staff Member Double Role

Staff member Jane who also books services elsewhere:

```
1. Jane logs in → Context defaults to last used (/dashboard if was managing)
2. See "Partner Dashboard" in navbar menu → She's employed
3. She wants to book a haircut for herself
4. Click "My Account" in navbar → Navigate to /my/dashboard
5. See her personal bookings (not the salon's bookings)
6. Book appointment as customer
7. Appointment confirms in /my/bookings
8. Later, switch back to /dashboard to manage staff
```

### Flow 2: Business Owner Managing Profile

Owner Alice manages multiple business profiles:

```
1. Alice owns Salon A, employed at Salon B as manager
2. Logs in → /dashboard/profile (showing Salon A's profile)
3. Edit salon name, address, hours
4. Wants to check Salon B's profile
5. Click navbar → "Partner Dashboard" → See "Salon B" option
6. Select Salon B → Redirected to /dashboard/profile (now showing Salon B)
7. Can only edit if she has manager+ role there
```

---

## Component Structure

### Customer Pages (`/my/*`)

```tsx
<CustomerLayout>
  <Sidebar>
    <Nav items={CUSTOMER_NAV_ITEMS} />
    <ContextSwitcher />
  </Sidebar>
  <Main>
    <Outlet /> {/* Child route renders here */}
  </Main>
</CustomerLayout>
```

### Business Pages (`/dashboard/*`)

```tsx
<BusinessLayout>
  <Sidebar>
    <BusinessHeader businessName={activeBusiness.name} />
    <Nav items={BUSINESS_NAV_ITEMS} />
    <ContextSwitcher />
  </Sidebar>
  <Main>
    <Outlet />
  </Main>
</BusinessLayout>
```

### Shared Context Switcher

```tsx
function ContextSwitcher() {
  const { user } = useAuth();
  const router = useRouter();

  const navigate = (destination: 'customer' | 'business') => {
    if (destination === 'business') {
      router.push('/dashboard');
    } else {
      router.push('/my');
    }
  };

  return (
    <Dropdown>
      <DropdownItem onClick={() => navigate('customer')}>
        👤 My Account
      </DropdownItem>
      {user.employments.length > 0 && (
        <DropdownItem onClick={() => navigate('business')}>
          📊 Partner Dashboard
        </DropdownItem>
      )}
    </Dropdown>
  );
}
```

---

## Data Isolation Patterns

### Customer Context Queries (No Tenant Filter)

```typescript
// Get all bookings this user has (across all providers)
const bookings = await bookingRepository.findByCustomer(userId);
// WHERE customer_id = $1 (no tenant_id filter)
```

### Business Context Queries (With Tenant Filter)

```typescript
// Get all bookings for THIS business
const bookings = await bookingRepository.findByTenant(tenantId);
// WHERE tenant_id = $1 (scoped to active business)
```

### Never Mix Contexts

```typescript
// ❌ WRONG: In /my/profile, don't query business data
const staffList = await staffRepository.findByTenant(user.activeTenant);

// ✅ CORRECT: In /my/profile, query only customer data
const preferences = await userPreferencesRepository.findById(userId);
```

---

## UX Gaps & Recommendations

### Gap 1: Visual Distinction

**Current:** Both dashboards have similar layout.

**Recommendation:** Use subtle visual cues:

- Customer dashboard: Cool blue accents
- Business dashboard: Warm coral accents
- Distinct header styling

### Gap 2: Breadcrumbs Missing

**Current:** Hard to know "am I in customer or business dashboard?"

**Recommendation:** Add breadcrumbs:

- `/my/bookings` → "My Bookings"
- `/dashboard/bookings` → "My Business > Bookings"

### Gap 3: Deep Linking Between Contexts

**Current:** No quick link from business to customer view of same booking.

**Recommendation:** Add "View as Customer" link in business booking detail:

- Staff creates booking → Can click "View as Customer" → See from customer's perspective

### Gap 4: Profile Management Scattered

**Current:** Settings spread across multiple tabs.

**Recommendation:** Consolidate into single "Account Management" section:

- `/my/account` (centralized, tabs for profile/settings/billing/privacy)

---

## Summary

The multi-role profile architecture provides:

- **Dual Identities:** Seamless switching between customer and business contexts
- **Clear Navigation:** Distinct routes for each role (`/my/*` vs `/dashboard/*`)
- **RBAC Guards:** Role-based access control prevents unauthorized access
- **Data Isolation:** Customer queries don't leak business data and vice versa
- **UX Clarity:** Visual indicators and context switcher make role clear

This design allows service providers to be both operators and consumers on the same platform without confusion or data leakage.
