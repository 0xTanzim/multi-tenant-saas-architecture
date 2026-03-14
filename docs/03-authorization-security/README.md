# Authorization & Security

Multi-tenant security, authentication, role-based access control (RBAC), and isolation patterns.

## Files

### 1. **RBAC_ARCHITECTURE.md**

Role-based access control system design.

- Roles: Owner, Admin, Staff, User
- Permission hierarchy
- Tenant-scoped roles
- Dynamic permission checking

### 2. **RBAC_IMPLEMENTATION_GUIDE.md**

Implementation details for RBAC.

- Permission decorators (NestJS)
- Role checks in controllers
- Service-level authorization
- Permission validation patterns

### 3. **MULTI_TENANT_ISOLATION.md**

Security patterns for tenant data isolation.

- Cross-tenant access prevention
- Tenant context validation
- Trust boundaries
- Testing tenant isolation

### 4. **SECURITY_BEST_PRACTICES.md**

Security guidelines for multi-tenant systems.

- Input validation
- Output encoding
- SQL injection prevention
- XSS prevention
- CSRF protection
- Authentication best practices

### 5. **AUTH_ARCHITECTURE.md**

Authentication system design.

- JWT structure with tenant_id claim
- Token generation and validation
- Session management
- Refresh token strategy

## Security Pyramid

```
Application Security ← Input validation, output encoding
Authorization (RBAC) ← Permission checks, role validation
Authentication (JWT) ← Token generation, verification
Tenant Isolation ← tenant_id in every query
Database Constraints ← Unique indexes, foreign keys
```

## Reading Order

1. **New to the system?** Start with AUTH_ARCHITECTURE.md
2. **Implementing features?** Read RBAC_ARCHITECTURE.md
3. **Security audit?** Read SECURITY_BEST_PRACTICES.md
4. **Debugging access issues?** Read MULTI_TENANT_ISOLATION.md

## Related Files

- **Database tenant filtering**: `../04-database-design/TENANT_SCOPED_QUERIES.md`
- **API security**: `../05-api-design/`
- **Testing security**: `../09-testing-quality/`

---

**Key Security Rules:**

1. Every query MUST filter by tenant_id
2. Every role check MUST validate tenant context
3. Every token MUST contain tenant_id claim
4. Every API response MUST be tenant-scoped
