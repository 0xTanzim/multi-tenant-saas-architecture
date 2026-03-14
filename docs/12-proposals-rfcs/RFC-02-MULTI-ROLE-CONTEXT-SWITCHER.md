# RFC: Multi-Role Context Switcher for PWA & Standalone Apps

**Status**: Implemented
**Author**: Architecture Team
**Created**: 2025-10-20
**Risk Level**: MEDIUM (authentication context management, cross-context routing)

---

## Purpose

Enable users with multiple roles (salon owner who is also a customer, staff member who books services elsewhere) to seamlessly switch between contexts (customer dashboard ↔ partner dashboard) on web browsers, PWAs, and standalone Capacitor applications. This RFC defines the context model, resolution rules, and routing behavior.

---

## Problem

Current system treats authentication as binary:

- **User is authenticated** → show feature set A
- **User is not authenticated** → show feature set B

But real-world users have multiple identities:

- A salon owner is **simultaneously** a customer (books services elsewhere)
- A staff member is **both** an employee (manages schedules) and a consumer (books appointments)

The app must:

1. **Maintain two independent contexts** — customer identity vs. professional identity
2. **Switch between contexts** without re-authentication
3. **Remember user's last context** across app restarts (PWA persistence)
4. **Prevent context confusion** — never leak customer data into professional context
5. **Work in PWA standalone mode** — persisted context survives app restart

---

## Context Model

### Two Independent Contexts

```
User = Authentication Identity (always present)
├── Personal/Customer Context (always available)
│   ├── View: /my/bookings, /my/profile
│   ├── Data: Personal bookings, reviews, preferences
│   ├── Scope: Cross-tenant (user has bookings at N businesses)
│   └── Role: "customer"
│
└── Professional/Partner Context (if employed)
    ├── View: /dashboard/calendar, /dashboard/staff
    ├── Data: Salon-specific (one tenant_id = active tenant)
    ├── Scope: Single tenant (active employment)
    └── Role: "owner" | "manager" | "staff"
```

### Authentication State

```typescript
AuthState {
  isAuthenticated: boolean
  userId: string
  email: string
  sessionId: string

  activeContext: "customer" | "partner" | "admin"
  activeTenant?: {
    tenantId: string
    slug: string
    name: string
    role: "owner" | "manager" | "staff"
    employmentId: string
    permissions: string[]
  }

  customer?: {
    profileId: string
    preferences: object
  }

  sessionValid: boolean
}
```

---

## Context Resolution Algorithm

When user navigates or refreshes:

### Step 1: Load Session JWT

```typescript
const token = jwt.verify(cookieToken);
// Extract: userId, employments[], permissions
```

### Step 2: Determine Active Context Candidate

**Resolution order** (deterministic):

```
1. Check URL path:
   - /my/* → force "customer" context
   - /dashboard/* → force "partner" context (validate active employment)
   - /admin/* → force "admin" context (validate super_admin role)
   - /* → use user's last saved context

2. If URL is neutral, load from localStorage:
   - key: `lastContext:{userId}` = "customer" | "partner" | "admin"
   - default (first time): "customer"

3. Validate the candidate:
   - "partner" with no current employment → downgrade to "customer"
   - "admin" without super_admin role → downgrade to "customer"
   - "customer" → always valid
```

### Step 3: Resolve Active Tenant (if partner context)

If context = "partner":

```typescript
const activeEmployment = user.employments
  .filter((e) => e.status === 'active')
  .sort((a, b) => b.createdAt - a.createdAt)[0]; // Most recent

if (!activeEmployment) {
  // No active employment → downgrade to customer context
  activeContext = 'customer';
}

const activeTenant = activeEmployment.tenant;
```

### Step 4: Save Context to localStorage (PWA Persistence)

```typescript
localStorage.setItem(`lastContext:${userId}`, activeContext);
if (activeTenant) {
  localStorage.setItem(`lastTenant:${userId}`, JSON.stringify(activeTenant));
}
```

---

## Behavior Matrix

| Scenario                                     | JWT Valid | Path          | Last Saved | Decision                                                 |
| -------------------------------------------- | --------- | ------------- | ---------- | -------------------------------------------------------- |
| User opens app (new session)                 | ✓         | `/`           | "customer" | → /my (customer context)                                 |
| User opens app (returning, was in dashboard) | ✓         | `/`           | "partner"  | → /dashboard (if employment still active)                |
| User visits /dashboard but has no employment | ✓         | /dashboard/\* | —          | → /my (redirect, show error "no active role")            |
| User manually visits /my from /dashboard     | ✓         | /my/\*        | "partner"  | → /my (accept navigation, save context)                  |
| Session expires                              | ✗         | /\*           | —          | → /auth/login (any context)                              |
| Staff member loses employment                | ✓         | /dashboard/\* | —          | → /my (auto-downgrade, show "role removed" notification) |
| Owner upgrades to staff at another salon     | ✓         | /dashboard/\* | "partner"  | → Use new active employment                              |

---

## Routing Rules

### Desktop Navigation

```
/my/*                          (Customer Dashboard)
├── Guard: isAuthenticated
├── Context: Forced to "customer"
├── Props: No tenant_id filter (cross-tenant view)
└── Navigation: Sidebar shows profile, bookings, reviews, settings

/dashboard/*                   (Partner Dashboard)
├── Guard: isAuthenticated + hasActiveTenant
├── Context: Forced to "partner"
├── Props: tenant_id = activeTenant.id (single-tenant view)
└── Navigation: Sidebar shows calendar, bookings, staff, settings*

/admin/*                       (Admin Dashboard)
├── Guard: isAuthenticated + isSuperAdmin
├── Context: Forced to "admin"
└── Navigation: Admin-specific

/                              (Neutral / Landing)
├── Guard: N/A (public, but shows different nav if authenticated)
├── Context: Uses lastContext or defaults to "customer"
└── Navigation: Navbar shows "Go to Dashboard" or "Go to My Bookings"
```

### Mobile Navigation (PWA/Standalone)

Same context rules as desktop. Bottom nav routes are scoped:

```
Customer Context Bottom Tabs:
├── Home (/my)
├── Search (/search)
├── Bookings (/my/bookings)
├── Profile (/my/profile)
└── More (drawer with additional options)

Partner Context Bottom Tabs:
├── Home (/dashboard)
├── Calendar (/dashboard/calendar)
├── Bookings (/dashboard/bookings)
├── More (drawer with settings, staff, etc.)
```

---

## Context Switching UI

### Desktop Header Dropdown

```
┌─────────────────────────────────┐
│  👤 [User Email] ▼              │
├─────────────────────────────────┤
│  My Account (→ /my/profile)     │
│  My Settings (→ /my/settings)   │
│  ─────────────────────────────  │
│  📊 Partner Dashboard            │ ← If has employment
│     "Salon Name" (active)        │
│  ─────────────────────────────  │
│  🚪 Logout                       │
└─────────────────────────────────┘
```

Clicking "Partner Dashboard" navigates to `/dashboard` and saves context.

### Mobile Sheet Menu

Same items as dropdown, tappable full-width.

---

## Cookie-Based Intent (PWA Specific)

For PWA standalone mode (`display-mode: standalone`), localStorage may be unreliable.

Backup persistence via **HTTP-only cookie** (set by backend on login):

```
Set-Cookie: lastContext={userId}:{context}; HttpOnly; SameSite=Strict; Max-Age=31536000
```

Resolution order (browser):

1. Try localStorage (faster, user-controlled)
2. Fall back to cookie value (server-persisted)
3. Default to "customer"

---

## Authorization Guards

### Guard: `TenantContextGuard`

Validates partner routes require active employment:

```typescript
@Injectable()
export class TenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;

    // Must have an active employment
    if (!user.activeTenant) {
      throw new ForbiddenException(
        'No active role. Switch to Customer Dashboard or join a business.'
      );
    }

    return true;
  }
}
```

### Guard: `SuperAdminGuard`

Validates admin routes:

```typescript
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: JwtPayload = request.user;

    if (user.platformRole !== 'super_admin' && user.platformRole !== 'admin') {
      throw new ForbiddenException('Admin access required.');
    }

    return true;
  }
}
```

---

## Middleware: Context Injection

After JWT verification, inject `user.activeTenant` and `user.activeContext` into all requests:

```typescript
@Injectable()
export class ContextInjectionMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // JWT already verified by JwtAuthGuard
    const user = req.user;

    // Load employments from DB if not cached
    if (!user.activeTenant && user.employments) {
      const active = user.employments.find((e) => e.status === 'active');
      if (active) {
        user.activeTenant = active.tenant;
        user.activeContext = 'partner';
      }
    }

    // Default context if not already set
    if (!user.activeContext) {
      user.activeContext = 'customer';
    }

    next();
  }
}
```

---

## Root Router: Deterministic Redirect

At application root (`/`), a router component decides where to go:

```typescript
function RootRouter() {
  const { user, isLoading } = useAuth();

  if (isLoading) return <LoadingScreen />;
  if (!user) return <Navigate to="/auth/login" />;

  // Load last context from localStorage
  const lastContext =
    localStorage.getItem(`lastContext:${user.id}`) || 'customer';

  if (lastContext === 'partner' && user.activeTenant) {
    return <Navigate to="/dashboard" />;
  }

  return <Navigate to="/my" />;
}
```

---

## Preventing Context Confusion

### Rule 1: Tenant Filter in All Partner Queries

Every partner route request must filter by `user.activeTenant.id`:

```typescript
// ❌ WRONG: Fetches all bookings for user across all salons
const bookings = await this.bookingRepository.findByCustomer(user.id);

// ✅ CORRECT: Fetches bookings only at active salon
const bookings = await this.bookingRepository.findByCustomerAtTenant(
  user.id,
  user.activeTenant.id
);
```

### Rule 2: Customer Context is Tenant-Agnostic

Customer dashboard shows data across ALL salons:

```typescript
// ✅ CORRECT: Shows all bookings for this user everywhere
const bookings = await this.bookingRepository.findByCustomer(user.id);
// No tenant filter
```

### Rule 3: Never Leak Professional Data into Customer View

Salon names, staff lists, pricing — only visible in `/dashboard`, never in `/my`.

---

## Redirect Loop Prevention

### Scenario: User logs out while viewing /dashboard

```
1. User at /dashboard/calendar
2. User clicks logout
3. JWT expires
4. Guard redirects to /auth/login
5. User logs back in
6. RootRouter checks lastContext = "partner"
7. But activeTenant is now stale → downgrade to "customer"
8. Redirect to /my
```

**No loop** because context is re-resolved after login.

---

## Summary

The multi-role context switcher provides:

- **Dual-identity support** — customer + professional simultaneously
- **Deterministic resolution** — no ambiguous context state
- **PWA persistence** — survives app restart and offline
- **Authorization enforcement** — guards prevent context leakage
- **Seamless switching** — no re-authentication required
- **Cross-platform** — works on web, PWA, and Capacitor

This design allows service providers to be both operators of their business and consumers of other services on the same platform.
