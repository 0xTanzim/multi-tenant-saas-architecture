# Portfolio Note

> Extracted from production system, sanitized for portfolio use.

---

# RBAC Implementation Guide

A practical guide to using the the Platform RBAC system. Covers backend guard usage, frontend component guards, code examples, common patterns, quick reference tables, debugging tips, and edge cases.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Backend Guards and Decorators](#backend-guards-and-decorators)
- [Controller Patterns](#controller-patterns)
- [Frontend Guards](#frontend-guards)
- [Frontend Middleware](#frontend-middleware)
- [Sidebar Configuration](#sidebar-configuration)
- [Hooks and Utilities](#hooks-and-utilities)
- [Common Patterns](#common-patterns)
- [Guard Implementation Details](#guard-implementation-details)
- [Testing](#testing)
- [Quick Reference](#quick-reference)
- [Debugging](#debugging)
- [Edge Cases](#edge-cases)

---

## Quick Start

### Backend (NestJS)

```typescript
import {
  Public,
  RequirePlatformRoles,
  RequireTenantRoles,
  RequirePermissions,
  RequireAnyPermission,
} from '@app/decorators';

// Public endpoint (no auth)
@Public()
@Get('health')
healthCheck() { return { status: 'ok' }; }

// Authenticated (any user)
@Get('profile')
getProfile(@Req() req) { return req.user; }

// Platform admin only
@RequirePlatformRoles(PLATFORM_ROLES.ADMIN)
@Get('admin/dashboard')
adminDashboard() { ... }

// Tenant owner or manager
@RequireTenantRoles(TENANT_ROLES.MANAGER)
@Post('staff')
createStaff(@Body() dto: CreateStaffDto) { ... }

// Specific permission required
@RequirePermissions('tenant.staff.create')
@Post('staff')
createStaff(@Body() dto: CreateStaffDto) { ... }

// Combined (all must pass)
@RequireTenantRoles(TENANT_ROLES.MANAGER)
@RequirePermissions('tenant.staff.create')
@Post('staff')
createStaff(@Body() dto: CreateStaffDto) { ... }
```

### Frontend (React)

```tsx
import { TenantRoleGuard, PermissionGuard } from '@/components/guards';
import { usePermissions } from '@/hooks/usePermissions';

// Component guard
<TenantRoleGuard roles={['owner', 'manager']}>
  <StaffManagementPanel />
</TenantRoleGuard>

// Permission guard
<PermissionGuard permissions={['tenant.staff.create']}>
  <button>Add Staff</button>
</PermissionGuard>

// Hook
const { hasPermission, hasTenantRole } = usePermissions();
if (hasPermission('tenant.staff.create')) {
  // show create button
}
```

---

## Backend Guards and Decorators

### Available Decorators

| Decorator | Purpose | Example |
|-----------|---------|---------|
| `@Public()` | Skip authentication | Login, register, health check |
| `@RequirePlatformRoles(...)` | Require platform role | Admin dashboard, user management |
| `@RequireTenantRoles(...)` | Require tenant role | Staff management, organization/business settings |
| `@RequirePermissions(...)` | Require ALL listed permissions (AND) | Fine-grained access control |
| `@RequireAnyPermission(...)` | Require ANY listed permission (OR) | Flexible permission checks |

### Decorator Behavior

**`@RequirePlatformRoles(PLATFORM_ROLES.ADMIN)`**
- Activates `PlatformRoleGuard`
- Checks `user.platformRole` from JWT
- Uses hierarchy: `super_admin` passes check for `admin`

**`@RequireTenantRoles(TENANT_ROLES.MANAGER)`**
- Activates `TenantRoleGuard`
- Checks `user.activeTenant.role` from JWT
- Uses hierarchy: `owner` passes check for `manager`
- Blocks if user has no active tenant context

**`@RequirePermissions('tenant.staff.create', 'tenant.staff.manage')`**
- Activates `PermissionGuard` with AND logic
- User must have ALL listed permissions

**`@RequireAnyPermission('tenant.reports.view', 'tenant.analytics.view')`**
- Activates `PermissionGuard` with OR logic
- User must have at least ONE listed permission

---

## Controller Patterns

### Pattern 1: Public Authentication Endpoints

```typescript
@Controller('auth')
export class AuthController {
  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  // Authenticated but no role requirement
  @Post('refresh')
  async refresh(@Req() req) {
    return this.authService.refresh(req.user);
  }
}
```

### Pattern 2: Role-Based Staff Management

```typescript
@Controller('tenants/:tenantId/staff')
export class StaffController {
  @RequireTenantRoles(TENANT_ROLES.MANAGER)
  @Get()
  async listStaff(@Param('tenantId') tenantId: number) {
    return this.staffService.findAll(tenantId);
  }

  @RequireTenantRoles(TENANT_ROLES.MANAGER)
  @RequirePermissions('tenant.staff.create')
  @Post()
  async createStaff(
    @Param('tenantId') tenantId: number,
    @Body() dto: CreateStaffDto,
  ) {
    return this.staffService.create(tenantId, dto);
  }

  @RequireTenantRoles(TENANT_ROLES.OWNER)
  @Delete(':staffId')
  async removeStaff(
    @Param('tenantId') tenantId: number,
    @Param('staffId') staffId: number,
  ) {
    return this.staffService.remove(tenantId, staffId);
  }
}
```

### Pattern 3: Analytics with OR Logic

```typescript
@Controller('tenants/:tenantId/analytics')
export class AnalyticsController {
  @RequireTenantRoles(TENANT_ROLES.MANAGER)
  @RequireAnyPermission('tenant.reports.view', 'tenant.analytics.view')
  @Get()
  async getAnalytics(@Param('tenantId') tenantId: number) {
    return this.analyticsService.getTenantAnalytics(tenantId);
  }
}
```

### Pattern 4: Booking with Ownership Guard

```typescript
@Controller('tenants/:tenantId/bookings')
export class BookingController {
  // Any tenant member can view their own bookings
  @RequireTenantRoles(TENANT_ROLES.STAFF)
  @Get(':bookingId')
  async getBooking(
    @Param('tenantId') tenantId: number,
    @Param('bookingId') bookingId: number,
    @Req() req,
  ) {
    // Service-layer ownership check
    return this.bookingService.getBooking(bookingId, req.user);
  }

  // Managers+ can view all bookings
  @RequireTenantRoles(TENANT_ROLES.MANAGER)
  @Get()
  async listBookings(@Param('tenantId') tenantId: number) {
    return this.bookingService.findAll(tenantId);
  }
}
```

### Pattern 5: Platform Admin Endpoints

```typescript
@Controller('admin')
@RequirePlatformRoles(PLATFORM_ROLES.ADMIN)
export class AdminController {
  @Get('tenants')
  async listAllTenants() {
    return this.tenantService.findAll();
  }

  @RequirePlatformRoles(PLATFORM_ROLES.SUPER_ADMIN)
  @Delete('tenants/:id')
  async deleteTenant(@Param('id') id: number) {
    return this.tenantService.delete(id);
  }
}
```

### Pattern 6: Defense in Depth

```typescript
@Controller('tenants/:tenantId/settings')
export class SettingsController {
  @RequireTenantRoles(TENANT_ROLES.OWNER)
  @RequirePermissions('tenant.settings.manage')
  @Patch()
  async updateSettings(
    @Param('tenantId') tenantId: number,
    @Body() dto: UpdateSettingsDto,
    @Req() req,
  ) {
    // Guard ensures: owner+ role AND settings.manage permission
    // Service adds: business rule validation
    return this.settingsService.update(tenantId, dto, req.user);
  }
}
```

---

## Frontend Guards

### Component Guards

Four React guard components for UI-level permission gating:

#### TenantRoleGuard

Renders children only if user has the required tenant role.

```tsx
<TenantRoleGuard roles={['owner', 'manager']}>
  <StaffManagementSection />
</TenantRoleGuard>

// With fallback
<TenantRoleGuard
  roles={['owner']}
  fallback={<p>Only organization/business owners can access this section.</p>}
>
  <DangerZoneSettings />
</TenantRoleGuard>
```

#### PlatformRoleGuard

Renders children only if user has the required platform role.

```tsx
<PlatformRoleGuard roles={['admin', 'super_admin']}>
  <AdminPanel />
</PlatformRoleGuard>
```

#### PermissionGuard

Renders children only if user has all required permissions.

```tsx
<PermissionGuard permissions={['tenant.staff.create']}>
  <button onClick={openCreateStaffModal}>Add team member</button>
</PermissionGuard>
```

#### RolePermissionGuard

Combines role and permission checks.

```tsx
<RolePermissionGuard
  tenantRoles={['manager', 'owner']}
  permissions={['tenant.reports.view']}
>
  <ReportsSection />
</RolePermissionGuard>
```

### Guard Decision Matrix

| Need | Use This Guard | Example |
|------|---------------|---------|
| Hide a page section by role | `<TenantRoleGuard>` | Staff management panel |
| Hide a button by permission | `<PermissionGuard>` | "Add Staff" button |
| Show admin-only UI | `<PlatformRoleGuard>` | Admin dashboard link |
| Role + permission combo | `<RolePermissionGuard>` | Reports with export |
| Conditional rendering in code | `usePermissions()` hook | Inline logic |

---

## Frontend Middleware

### Route-Level Role Guards

The Next.js middleware (`withRoleBasedRouting`) runs before page loads to redirect unauthorized users:

```typescript
// Route access configuration
const ROUTE_ACCESS_RULES: RouteAccessRule[] = [
  {
    path: '/dashboard/admin',
    platformRoles: ['super_admin', 'admin'],
    redirect: '/dashboard',
  },
  {
    path: '/dashboard/staff',
    tenantRoles: ['owner', 'manager', 'staff'],
    redirect: '/login',
  },
  {
    path: '/dashboard/settings',
    tenantRoles: ['owner'],
    redirect: '/dashboard',
  },
];
```

### Three Security Layers Working Together

```
Middleware (Layer 1): Route-level role check
  "Can this role access /dashboard/admin?"
  Uses roles (fast, no DB lookup)

Component Guards (Layer 2): UI-level permission check
  "Should this user see the Delete Staff button?"
  Uses permissions (more granular)

Backend Guards (Layer 3): API-level enforcement (final authority)
  "Can this user actually delete this team member?"
  Guards + service-layer business rules
```

**Middleware is for UX improvement** (prevent loading a page the user cannot use). **Backend is for security** (never bypassed regardless of client behavior).

---

## Sidebar Configuration

### Config-Based Approach (Recommended)

```typescript
interface SidebarItem {
  label: string;
  href: string;
  icon: React.ComponentType;
  requiredRoles?: TenantRole[];
  requiredPermissions?: string[];
}

const SIDEBAR_CONFIG: SidebarItem[] = [
  {
    label: 'Dashboard',
    href: '/dashboard',
    icon: HomeIcon,
    // No role/permission = visible to all authenticated users
  },
  {
    label: 'Staff',
    href: '/dashboard/staff',
    icon: UsersIcon,
    requiredRoles: ['manager', 'owner'],
  },
  {
    label: 'Analytics',
    href: '/dashboard/analytics',
    icon: ChartIcon,
    requiredRoles: ['owner'],
    requiredPermissions: ['tenant.analytics.view'],
  },
  {
    label: 'Settings',
    href: '/dashboard/settings',
    icon: CogIcon,
    requiredRoles: ['owner'],
  },
];
```

### Rendering the Sidebar

```tsx
function Sidebar() {
  const { hasTenantRole, hasPermission } = usePermissions();

  return (
    <nav>
      <ul>
        {SIDEBAR_CONFIG.filter(item => {
          if (item.requiredRoles && !item.requiredRoles.some(r => hasTenantRole(r))) {
            return false;
          }
          if (item.requiredPermissions && !item.requiredPermissions.every(p => hasPermission(p))) {
            return false;
          }
          return true;
        }).map(item => (
          <li key={item.href}>
            <Link href={item.href}>
              <item.icon />
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

---

## Hooks and Utilities

### usePermissions Hook

```typescript
const {
  hasPermission,       // (permission: string) => boolean
  hasAnyPermission,    // (permissions: string[]) => boolean
  hasAllPermissions,   // (permissions: string[]) => boolean
  hasPlatformRole,     // (role: string) => boolean
  hasTenantRole,       // (role: string) => boolean
  permissions,         // string[] - all current permissions
  platformRole,        // string - current platform role
  tenantRole,          // string - current tenant role
} = usePermissions();
```

### Usage Examples

```tsx
function StaffActions({ staffId }: { staffId: number }) {
  const { hasPermission, hasTenantRole } = usePermissions();

  return (
    <div>
      {hasPermission('tenant.staff.manage') && (
        <button onClick={() => editStaff(staffId)}>Edit</button>
      )}
      {hasTenantRole('owner') && (
        <button onClick={() => deleteStaff(staffId)}>Remove</button>
      )}
    </div>
  );
}
```

---

## Common Patterns

### Full CRUD with Escalating Permissions

```typescript
@Controller('tenants/:tenantId/services')
export class ServiceController {
  // READ: Any tenant member
  @RequireTenantRoles(TENANT_ROLES.STAFF)
  @Get()
  async list(@Param('tenantId') tid: number) { ... }

  @RequireTenantRoles(TENANT_ROLES.STAFF)
  @Get(':id')
  async get(@Param('tenantId') tid: number, @Param('id') id: number) { ... }

  // CREATE: Manager+ with create permission
  @RequireTenantRoles(TENANT_ROLES.MANAGER)
  @RequirePermissions('tenant.services.create')
  @Post()
  async create(@Param('tenantId') tid: number, @Body() dto: CreateServiceDto) { ... }

  // UPDATE: Manager+ with manage permission
  @RequireTenantRoles(TENANT_ROLES.MANAGER)
  @RequirePermissions('tenant.services.manage')
  @Patch(':id')
  async update(@Param('tenantId') tid: number, @Param('id') id: number, @Body() dto: UpdateServiceDto) { ... }

  // DELETE: Owner only
  @RequireTenantRoles(TENANT_ROLES.OWNER)
  @Delete(':id')
  async delete(@Param('tenantId') tid: number, @Param('id') id: number) { ... }
}
```

### Self-Service with Admin Override (Booking Ownership)

```typescript
@Injectable()
export class BookingService {
  async getBooking(bookingId: number, user: AuthenticatedUser): Promise<Booking> {
    const booking = await this.bookingRepo.findById(bookingId);

    if (!booking) throw new NotFoundException('Booking not found');

    if (!this.canAccessBooking(booking, user)) {
      throw new ForbiddenException('You cannot access this booking');
    }

    return booking;
  }

  private canAccessBooking(booking: Booking, user: AuthenticatedUser): boolean {
    // Platform admin bypass
    if (['super_admin', 'admin'].includes(user.platformRole)) return true;
    // Customer who booked
    if (booking.customer_id === user.customerId) return true;
    // Same tenant: manager/owner see all
    if (booking.tenant_id === user.tenantId) {
      if (['owner', 'manager'].includes(user.tenantRole)) return true;
      // Assigned staff
      if (booking.primary_staff_employment_id === user.staffEmploymentId) return true;
    }
    return false;
  }
}
```

### Time-Off with Status Check

```typescript
@Injectable()
export class TimeOffService {
  async updateRequest(requestId: number, dto: UpdateTimeOffDto, user: AuthenticatedUser) {
    const request = await this.findRequest(requestId, user.tenantId);

    if (!request) throw new NotFoundException();

    // Ownership: only the team member can edit
    if (request.staff_employment_id !== user.staffEmploymentId) {
      throw new ForbiddenException('You cannot edit this request');
    }

    // Status: can only edit pending requests
    if (request.status !== 'pending') {
      throw new BadRequestException('Can only edit pending requests');
    }

    return this.repo.update(requestId, dto);
  }
}
```

### Conditional Permissions

```typescript
@Controller('tenants/:tenantId/bookings')
export class BookingController {
  @RequireTenantRoles(TENANT_ROLES.STAFF)
  @Post(':bookingId/complete')
  async completeBooking(
    @Param('tenantId') tenantId: number,
    @Param('bookingId') bookingId: number,
    @Req() req,
  ) {
    const booking = await this.bookingService.findById(tenantId, bookingId);

    // Staff can only complete their own bookings
    if (req.user.tenantRole === 'staff') {
      if (booking.primary_staff_employment_id !== req.user.staffEmploymentId) {
        throw new ForbiddenException('Can only complete your own bookings');
      }
    }

    return this.bookingService.complete(bookingId);
  }
}
```

---

## Guard Implementation Details

### PermissionGuard (Production Code)

```typescript
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Check for AND permissions
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Check for OR permissions
    const anyPermissions = this.reflector.getAllAndOverride<string[]>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // PASSIVE: No decorator = allow access
    if (!requiredPermissions?.length && !anyPermissions?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // Collect effective permissions from JWT
    const effectivePermissions = new Set<string>([
      ...(user.platformPermissions || []),
      ...(user.activeTenant?.permissions || []),
    ]);

    // AND logic: user must have ALL required permissions
    if (requiredPermissions?.length) {
      const hasAll = requiredPermissions.every(p => effectivePermissions.has(p));
      if (!hasAll) {
        throw new ForbiddenException(
          `Missing required permissions: ${requiredPermissions.filter(p => !effectivePermissions.has(p)).join(', ')}`
        );
      }
    }

    // OR logic: user must have ANY of the listed permissions
    if (anyPermissions?.length) {
      const hasAny = anyPermissions.some(p => effectivePermissions.has(p));
      if (!hasAny) {
        throw new ForbiddenException(
          `Requires at least one of: ${anyPermissions.join(', ')}`
        );
      }
    }

    return true;
  }
}
```

### TenantRoleGuard (Production Code)

```typescript
@Injectable()
export class TenantRoleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private tenantRoleHierarchy: TenantRoleHierarchyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<TenantRole[]>(
      TENANT_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // PASSIVE: No decorator = allow access
    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // Edge case: tenant role required but no active tenant
    const tenantId = this.extractTenantFromRequest(request);
    if (!tenantId) {
      throw new BadRequestException(
        'This endpoint requires tenant membership. Please select an active tenant.'
      );
    }

    const userRole = user.activeTenant?.role;
    if (!userRole) {
      throw new ForbiddenException('No tenant role assigned');
    }

    // Hierarchy check: owner passes manager check, manager passes staff check
    const hasRole = requiredRoles.some(required =>
      this.tenantRoleHierarchy.hasMinimumRole(userRole, required)
    );

    if (!hasRole) {
      throw new ForbiddenException(
        `Requires tenant role: ${requiredRoles.join(' or ')}. Your role: ${userRole}`
      );
    }

    return true;
  }
}
```

---

## Testing

### Unit Testing Guards

```typescript
describe('PermissionGuard', () => {
  it('should allow access when no decorator is present (passive)', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const result = guard.canActivate(mockContext);

    expect(result).toBe(true);
  });

  it('should allow when user has all required permissions (AND)', () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(['tenant.staff.create', 'tenant.staff.manage'])
      .mockReturnValueOnce(undefined);

    mockRequest.user = {
      activeTenant: {
        permissions: ['tenant.staff.create', 'tenant.staff.manage', 'tenant.bookings.view'],
      },
    };

    const result = guard.canActivate(mockContext);

    expect(result).toBe(true);
  });

  it('should deny when user is missing a required permission', () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(['tenant.staff.create', 'tenant.staff.manage'])
      .mockReturnValueOnce(undefined);

    mockRequest.user = {
      activeTenant: {
        permissions: ['tenant.staff.create'], // missing staff.manage
      },
    };

    expect(() => guard.canActivate(mockContext)).toThrow(ForbiddenException);
  });

  it('should allow when user has ANY required permission (OR)', () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(['tenant.reports.view', 'tenant.analytics.view']);

    mockRequest.user = {
      activeTenant: {
        permissions: ['tenant.analytics.view'],
      },
    };

    const result = guard.canActivate(mockContext);

    expect(result).toBe(true);
  });
});
```

### Integration Testing

```typescript
describe('Staff Management (Integration)', () => {
  it('should allow manager to create staff', async () => {
    const response = await request(app.getHttpServer())
      .post(`/tenants/${tenantId}/staff`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: 'New Staff', role: 'staff' })
      .expect(201);

    expect(response.body.name).toBe('New Staff');
  });

  it('should deny staff from creating other staff', async () => {
    await request(app.getHttpServer())
      .post(`/tenants/${tenantId}/staff`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ name: 'New Staff', role: 'staff' })
      .expect(403);
  });

  it('should prevent cross-tenant access', async () => {
    await request(app.getHttpServer())
      .get(`/tenants/${otherTenantId}/staff`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(403);
  });
});
```

### Testing Checklist

- [ ] Public endpoints accessible without JWT
- [ ] Authenticated endpoints reject missing JWT (401)
- [ ] Role-protected endpoints reject insufficient role (403)
- [ ] Permission-protected endpoints reject missing permission (403)
- [ ] AND permissions require ALL permissions
- [ ] OR permissions require ANY permission
- [ ] Hierarchy grants access to higher roles
- [ ] Tenant role required blocks users without active tenant (400)
- [ ] Cross-tenant access is denied
- [ ] Service-layer ownership blocks unauthorized resource access

---

## Quick Reference

### Common Decorator Combinations

```typescript
// 1. Public (no auth)
@Public()

// 2. Authenticated only (any user)
// (no decorators needed)

// 3. Platform admin
@RequirePlatformRoles(PLATFORM_ROLES.ADMIN)

// 4. Tenant role
@RequireTenantRoles(TENANT_ROLES.MANAGER)

// 5. Specific permission
@RequirePermissions('tenant.staff.create')

// 6. Any of multiple permissions
@RequireAnyPermission('tenant.reports.view', 'tenant.analytics.view')

// 7. Role + permission (both must pass)
@RequireTenantRoles(TENANT_ROLES.MANAGER)
@RequirePermissions('tenant.staff.create')

// 8. Platform + tenant (both must pass)
@RequirePlatformRoles(PLATFORM_ROLES.ADMIN)
@RequireTenantRoles(TENANT_ROLES.OWNER)
```

### Permission Naming Convention

```
{scope}.{resource}.{action}

Scopes:    platform | tenant | user
Resources: staff | bookings | services | reports | analytics | settings | customers
Actions:   view | create | manage | update | delete | pricing | export | financial
```

### Role Hierarchy Quick Check

```
Platform:                    Tenant:
  super_admin (4) ──┐         owner (3) ──┐
  admin (3) ────────┤         manager (2) ┤
  support (2) ──────┤         staff (1) ──┘
  customer (1) ─────┘

Higher roles inherit all lower role access.
@RequireTenantRoles(MANAGER) allows: manager, owner
@RequirePlatformRoles(ADMIN) allows: admin, super_admin
```

### Frontend Guard Quick Reference

| Component | Props | Use Case |
|-----------|-------|----------|
| `<TenantRoleGuard>` | `roles`, `fallback?` | Hide sections by tenant role |
| `<PlatformRoleGuard>` | `roles`, `fallback?` | Hide sections by platform role |
| `<PermissionGuard>` | `permissions`, `fallback?` | Hide elements by permission |
| `<RolePermissionGuard>` | `tenantRoles?`, `platformRoles?`, `permissions?`, `fallback?` | Combined checks |

| Hook | Returns | Use Case |
|------|---------|----------|
| `usePermissions()` | `{ hasPermission, hasTenantRole, hasPlatformRole, ... }` | Programmatic checks |

---

## Debugging

### Common Issues

**1. "403 Forbidden" on an endpoint you expect to work**

- Check JWT payload: decode with `echo "<token>" | base64 -d | jq .`
- Verify `platformRole` and `activeTenant.role` values
- Check if decorator requires higher role than user has
- Verify permissions array includes the required permission

**2. "400 Bad Request: tenant membership required"**

- User has no active tenant context
- Switch to a tenant before accessing tenant-scoped endpoints
- Check JWT has `activeTenant` field populated

**3. Frontend guard hides content that should be visible**

- Check `usePermissions()` returns expected values
- Verify AuthProvider is properly wrapping the component tree
- Check that permissions in JWT match what the guard expects
- Force refresh: clear cache and re-login

**4. Permission works in one tenant but not another**

- Permissions are per-role-per-tenant
- User may have different roles in different tenants
- Cache may be stale: wait for TTL expiry or trigger refresh

### Debug Logging

```typescript
// Enable in development
// .env.development
LOG_LEVEL=debug

// Guards log at debug level:
// "PlatformRoleGuard: No decorator found, allowing access"
// "TenantRoleGuard: Required roles: [manager], User role: staff - DENIED"
// "PermissionGuard: Required: [tenant.staff.create], Has: [tenant.staff.create, ...] - ALLOWED"
```

### Verify Guard Order

```typescript
// Guards execute in this order:
// 1. JwtAuthGuard    → Is user authenticated?
// 2. PlatformRoleGuard → Does platform role match?
// 3. TenantRoleGuard   → Does tenant role match?
// 4. PermissionGuard   → Does user have permissions?
```

---

## Edge Cases

### Platform Admin with No Tenant

When a platform admin tries to access a tenant-scoped endpoint:

```typescript
@RequireTenantRoles(TENANT_ROLES.OWNER)
@Patch('tenants/:id/settings')
updateSettings() { ... }
```

Result: **400 Bad Request** - "This endpoint requires tenant membership."

The platform admin must be a member of the tenant to access tenant-scoped resources. Use `@RequirePlatformRoles(PLATFORM_ROLES.ADMIN)` instead for platform-level admin actions.

### Combining Platform and Tenant Decorators

Both checks use AND logic. The user must pass both:

```typescript
@RequirePlatformRoles(PLATFORM_ROLES.ADMIN)
@RequireTenantRoles(TENANT_ROLES.OWNER)
@Post('admin/tenants/:id/override')
```

Only users who are both a platform admin AND a tenant owner can access this endpoint.

### Mixing @Public() with Role Decorators

```typescript
// This is wrong - @Public() bypasses JwtAuthGuard,
// so role guards have no user to check
@Public()
@RequireTenantRoles(TENANT_ROLES.OWNER)  // Never checked
@Get('data')
```

`@Public()` skips authentication entirely. Role decorators become meaningless because there is no authenticated user. Do not combine them.

### Staff Accessing Another Staff's Data

Service-layer checks handle this:

```typescript
// Staff can only view their own bookings
if (user.tenantRole === 'staff') {
  if (booking.primary_staff_employment_id !== user.staffEmploymentId) {
    throw new ForbiddenException('This booking is not assigned to you');
  }
}
```

### Review Edit Window

Business rules in the service layer:

```typescript
private canEditReview(review: Review, user: AuthenticatedUser): boolean {
  if (review.customer_id !== user.customerId) return false;

  const daysSinceCreation = differenceInDays(new Date(), review.created_at);
  if (daysSinceCreation > 7) return false;

  if (review.salon_response) return false;

  return true;
}
```

### Cache Staleness After Role Change

When a user's role changes:
1. Cache for the old role is not invalidated (it serves other users with that role)
2. The user's JWT still contains the old role until token refresh
3. On next login or token refresh, new role is embedded in JWT
4. New role's permissions are loaded from cache (or DB on miss)

For immediate effect: invalidate the user's session and force re-login.
