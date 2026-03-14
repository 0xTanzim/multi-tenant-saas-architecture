# Tenant Architecture — Multi-Tenant System Design

**Version:** 1.0
**Status:** Reference Implementation
**Audience:** Architects, Backend Engineers, System Designers

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Principles](#architecture-principles)
3. [System Architecture](#system-architecture)
4. [Tenant Lifecycle](#tenant-lifecycle)
5. [Multi-Role User Architecture](#multi-role-user-architecture)
6. [Tenant Context Propagation](#tenant-context-propagation)
7. [Onboarding & Registration Flow](#onboarding--registration-flow)
8. [Clean Architecture Layers](#clean-architecture-layers)

---

## Overview

The **Tenant Management System** is the foundational multi-tenant infrastructure for SaaS platforms. It handles tenant registration, lifecycle management, onboarding, and tenant context propagation throughout the entire system.

### Core Capabilities

- **Tenant Registration**: Self-service tenant account creation
- **Tenant Lifecycle Management**: Creation, active, suspended, archived states
- **Multi-Role User Architecture**: Flexible role hierarchy per tenant
- **Role-Based Access Control (RBAC)**: Owner, Admin, Operator, User roles
- **Tenant Context Propagation**: JWT-based tenant context flow
- **Tenant Discovery**: API for retrieving tenant metadata
- **Onboarding Workflows**: Setup wizards and configuration
- **Settings Management**: Tenant-specific configuration persistence
- **Tenant Isolation**: Hard boundaries between tenant data

---

## Architecture Principles

### Foundation Principles

1. **Strict Tenant Isolation**

   - Every database query filters by `tenant_id`
   - Composite indexes on `(tenant_id, other_fields)`
   - No cross-tenant data leakage in any layer
   - Tenant context validated before every access

2. **Role-Based Authorization**

   - Roles define permissions, not hard-coded logic
   - Permissions checked at each boundary
   - Role hierarchy: Owner > Admin > Operator > User
   - Role scoped to single tenant (no cross-tenant roles)

3. **Context Propagation**

   - Tenant ID flows from HTTP layer through all services
   - Explicit tenant parameter in every service method
   - No implicit tenant assumptions
   - Middleware injects tenant context at entry point

4. **Separation of Concerns**

   - Controllers: HTTP handling only
   - Services: Business logic only
   - Repositories: Data access only
   - No layer violations

5. **Immutability**
   - DTOs are readonly
   - Data transformations create new objects
   - State changes tracked for audit

---

## System Architecture

### Layered Component Model

```
┌─────────────────────────────────────────────────────┐
│           API Gateway / Controllers (6)              │
│  ┌──────────────────────────────────────────────┐  │
│  │ Public Controller  • Owner Controller        │  │
│  │ Admin Controller   • Settings Controller     │  │
│  │ Setup Controller   • Integration Controller  │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│       Business Logic Layer (10 Services)             │
│  ┌─────────────┬─────────────┬──────────────────┐  │
│  │    Core     │  Features   │   Operations     │  │
│  ├─────────────┼─────────────┼──────────────────┤  │
│  │ TenantCore  │ Registration│ TenantSearch     │  │
│  │ Analytics   │ Onboarding  │ TenantSettings   │  │
│  │             │ Widget Mgmt │ TenantStatus     │  │
│  └─────────────┴─────────────┴──────────────────┘  │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│         Data Access Layer (Repository)               │
│           TenantRepository Pattern                   │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│         Infrastructure (PostgreSQL + Redis)         │
│   • Primary data store    • Cache layer              │
│   • Transaction support   • Performance optimization │
└─────────────────────────────────────────────────────┘
```

---

## Tenant Lifecycle

### State Diagram

```
┌─────────────┐
│   Created   │  Initial state after registration
└──────┬──────┘
       │
       ↓
┌─────────────┐    Normal operational state
│   Active    │    Users can access and transact
└──────┬──────┘
       │
       ├─────────────────────┬──────────────────────┐
       ↓                     ↓                      ↓
┌─────────────┐       ┌─────────────┐      ┌──────────────┐
│  Suspended  │       │   Archived  │      │   Deleted    │
│             │       │             │      │              │
│ Temp pause  │       │ No longer   │      │ Hard delete  │
│ by admin    │       │ listed/      │      │ or soft      │
│             │       │ indexed     │      │ delete with  │
│ Can resume  │       │             │      │ retention    │
└──────┬──────┘       └─────────────┘      └──────────────┘
       │
       └─────────────────────────────────────┐
                                             ↓
                                      ┌─────────────┐
                                      │   Active    │
                                      └─────────────┘
```

### Lifecycle States

| State         | Description                                               | User Access          | Data Retention           | Transition             |
| ------------- | --------------------------------------------------------- | -------------------- | ------------------------ | ---------------------- |
| **Created**   | Immediately after sign-up                                 | Limited (setup only) | Full                     | → Active               |
| **Active**    | Fully operational                                         | Full access          | Full                     | → Suspended, Archived  |
| **Suspended** | Temporary pause (payment, policy violation, admin action) | No access            | Retained                 | → Active, Deleted      |
| **Archived**  | Business closed but data retained                         | No access            | Retained                 | → Deleted (eventually) |
| **Deleted**   | Hard or soft delete                                       | No access            | May be purged per policy | Terminal               |

### Transition Rules

```
Created    → Active         (Post-onboarding completion)
Active     → Suspended      (Admin action or auto-trigger)
Suspended  → Active         (Resume subscription, payment)
Active     → Archived       (User initiated; no auto-reactivate)
*          → Deleted        (Compliance, GDPR, hard delete)
```

---

## Multi-Role User Architecture

### Role Hierarchy

```
┌──────────────────────────────────────────────────┐
│  Owner (Highest Privilege)                       │
│  • Full tenant configuration                     │
│  • Financial & billing access                    │
│  • User/staff management                         │
│  • System settings                               │
└──────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────┐
│  Admin                                           │
│  • Most features except billing                  │
│  • Staff management, reporting                   │
│  • Operational decisions                         │
└──────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────┐
│  Operator (Team Lead / Supervisor)               │
│  • Operational execution                         │
│  • Staff coordination                            │
│  • View-only reporting                           │
└──────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────┐
│  User (Lowest Privilege)                         │
│  • Execute assigned tasks                        │
│  • View own data/assignments                     │
└──────────────────────────────────────────────────┘
```

### Permission Matrix

| Resource            | Owner | Admin | Operator       | User |
| ------------------- | ----- | ----- | -------------- | ---- |
| Tenant Settings     | ✅    | ✅    | ❌             | ❌   |
| Billing & Payments  | ✅    | ❌    | ❌             | ❌   |
| User Management     | ✅    | ✅    | ❌             | ❌   |
| Operational Reports | ✅    | ✅    | ✅ (read-only) | ❌   |
| Task Execution      | ✅    | ✅    | ✅             | ✅   |
| Own Profile         | ✅    | ✅    | ✅             | ✅   |

### User-Role-Tenant Relationship

```
User
 ├─ Tenant A [Owner role]        ← Primary tenant
 ├─ Tenant B [Admin role]        ← Secondary tenants
 ├─ Tenant C [Operator role]
 └─ Tenant D [User role]

Same user, different roles per tenant
Roles are independent per tenant
```

---

## Tenant Context Propagation

### How Tenant Context Flows

```
┌───────────────────────────────────────────────────────┐
│ 1. HTTP Request with Authorization Header             │
│    GET /api/resources                                  │
│    Authorization: Bearer eyJhbG...                     │
└───────────────────────────────────────────────────────┘
                       ↓
┌───────────────────────────────────────────────────────┐
│ 2. JWT Middleware Extracts Tenant Context              │
│    Extract from JWT payload:                           │
│    {                                                   │
│      "userId": "user-123",                             │
│      "activeTenantId": "tenant-456",                   │
│      "activeTenantRole": "owner",                      │
│      "permissions": [...]                              │
│    }                                                   │
└───────────────────────────────────────────────────────┘
                       ↓
┌───────────────────────────────────────────────────────┐
│ 3. Guard/Middleware Validates Tenant Context           │
│    • Check: user has access to tenant                  │
│    • Check: role >= required role                      │
│    • Attach to request: req.tenant, req.user           │
└───────────────────────────────────────────────────────┘
                       ↓
┌───────────────────────────────────────────────────────┐
│ 4. Controller Receives Tenant Context                  │
│    @Controller('/resources')                           │
│    async getResources(@CurrentUser() user,             │
│                       @CurrentTenant() tenant) {       │
│      // tenant context available                       │
│    }                                                   │
└───────────────────────────────────────────────────────┘
                       ↓
┌───────────────────────────────────────────────────────┐
│ 5. Service Layer Uses Tenant Context                   │
│    async getResources(tenantId: string) {              │
│      // All queries filtered by tenantId               │
│      const resources =                                 │
│        await this.repo.find({                          │
│          where: { tenantId }  ← Mandatory filter       │
│        });                                             │
│    }                                                   │
└───────────────────────────────────────────────────────┘
                       ↓
┌───────────────────────────────────────────────────────┐
│ 6. Repository Enforces Tenant Filtering                │
│    async find(filters) {                               │
│      // Always add tenantId filter                     │
│      return db.query()                                 │
│        .where('tenantId', '=', tenantId)               │
│        .where(filters);  ← Other filters               │
│    }                                                   │
└───────────────────────────────────────────────────────┘
```

### Tenant Context Object

```typescript
// Tenant context attached to request
interface TenantContext {
  tenantId: string; // Primary key
  tenantSlug: string; // URL-safe identifier
  tenantName: string; // Display name
  tenantRole: 'owner' | 'admin' | 'operator' | 'user'; // User's role in this tenant
  permissions: string[]; // Granted permissions based on role
  isActive: boolean; // Tenant is operational
  features: {
    api: boolean; // API access enabled
    integrations: boolean; // Third-party integrations
    advancedReporting: boolean; // Premium features
  };
}
```

---

## Onboarding & Registration Flow

### Registration Sequence

```
┌─────────────────────────────────────────────────────────┐
│ Step 1: User Initiates Registration                     │
│ • Email + Password verification                         │
│ • Email confirmation link sent                          │
└─────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ Step 2: Create Tenant                                   │
│ • Generate unique tenant slug                           │
│ • Validate slug availability                            │
│ • Create tenant record                                  │
│ • Initialize default settings                           │
└─────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ Step 3: Assign Owner Role                               │
│ • Create user-role mapping                              │
│ • Grant 'owner' role to registrant                      │
│ • Set permissions based on role                         │
└─────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ Step 4: Initialize Tenant Configuration                 │
│ • Create default settings record                        │
│ • Initialize business profile                           │
│ • Set up default teams/groups                           │
└─────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ Step 5: Onboarding Workflow                             │
│ • Present setup checklist                               │
│ • Configure tenant preferences                          │
│ • Set business hours / operating schedule               │
│ • Upload business information                           │
└─────────────────────────────────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────────┐
│ Step 6: Tenant Activated                                │
│ • Set tenant.status = 'active'                          │
│ • Issue JWT with tenant context                         │
│ • Redirect to main dashboard                            │
│ • Send welcome email                                    │
└─────────────────────────────────────────────────────────┘
```

### Validation Rules

During registration, validate:

- **Email Uniqueness**: No duplicate email registrations globally
- **Slug Uniqueness**: Tenant slug must be unique across all tenants
- **Slug Format**: Lowercase alphanumeric + hyphens only, 3-50 characters
- **Password Strength**: Min 12 chars, special chars, numbers
- **Tenant Name**: Not empty, < 100 chars, no SQL injection attempts

---

## Clean Architecture Layers

### Layer 1: HTTP Controllers

**Responsibility**: HTTP request/response handling only

```typescript
// ❌ DO NOT: Access database directly
@Controller('tenants')
export class TenantController {
  @Post('register')
  async register(@Body() dto: RegisterTenantDto) {
    // ✅ DO: Delegate to service
    return this.tenantService.register(dto);
  }
}
```

Controllers have NO business logic. They:

- Parse input
- Validate input format
- Call service
- Format response
- Handle HTTP errors

### Layer 2: Business Logic Services

**Responsibility**: Implement business rules and orchestration

```typescript
@Injectable()
export class TenantService {
  async register(dto: RegisterTenantDto): Promise<TenantResponseDto> {
    // ✅ DO: Validate business rules
    await this.validateSlugAvailable(dto.slug);

    // ✅ DO: Orchestrate multi-step operations
    const tenant = await this.tenantRepository.create(dto);
    await this.roleService.setupDefaultRoles(tenant.id);

    // ❌ DO NOT: Access database directly
    // Use repository instead
  }
}
```

Services:

- Contain business logic
- Orchestrate operations
- Validate constraints
- Use repositories for data access
- Never access database directly

### Layer 3: Data Access (Repository)

**Responsibility**: Database queries and persistence

```typescript
@Injectable()
export class TenantRepository {
  // ✅ DO: Provide focused query methods
  async findBySlug(slug: string): Promise<Tenant | null> {
    return this.db.query().where('slug', '=', slug).first();
  }

  async findByTenantId(tenantId: string): Promise<Tenant> {
    return this.db.query().where('id', '=', tenantId).first();
  }
}
```

Repository Pattern:

- Single source of truth for queries
- No business logic
- Returns raw data
- Services transform data into DTOs

### Layer Interaction Example

```
Request
   ↓
Controller.register(dto)
   ├─ Validate input format
   ├─ Call TenantService.register(dto)
   │    ├─ Validate business rules
   │    ├─ Call TenantRepository.create(dto)
   │    │    ├─ Execute SQL INSERT
   │    │    └─ Return raw tenant data
   │    ├─ Call RoleService.setupRoles(tenantId)
   │    │    └─ Create default role records
   │    └─ Return business response
   ├─ Format HTTP response
   └─ Send response
```

---

## Key Design Decisions

### Why Strict Tenant Isolation?

- **Security**: Prevents accidental data leaks
- **Compliance**: Required for regulations like GDPR
- **Auditability**: Clear tenant boundaries aid debugging
- **Multi-tenancy**: Fundamental requirement

### Why Role-Based Access?

- **Flexibility**: Easy to add new roles without code changes
- **Scalability**: Permissions managed in database, not hardcoded
- **Auditability**: Easy to track who had access and when
- **Separation of Duties**: Clear responsibility boundaries

### Why Active Tenant Pattern?

See [MULTI_TENANT_ACCESS_FLOW.md](./MULTI_TENANT_ACCESS_FLOW.md) for detailed explanation of how users can belong to multiple tenants and switch between them.

---

## Summary

The tenant management system provides:

1. ✅ **Clear tenant lifecycle** from registration to deletion
2. ✅ **Flexible multi-role architecture** supporting various user types
3. ✅ **Strict isolation** preventing cross-tenant data leaks
4. ✅ **Clean layered architecture** separating concerns
5. ✅ **Explicit context propagation** through the entire system
6. ✅ **Scalable onboarding** workflow for new tenants

This foundation enables secure, isolated multi-tenant operations at scale.
