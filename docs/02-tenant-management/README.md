# Tenant Management & Isolation

Implementation of multi-tenant isolation, access control, and tenant lifecycle management.

## Files

### 1. **TENANT_ARCHITECTURE.md**

Complete tenant management system design.

- Tenant creation and provisioning
- Tenant data isolation strategies
- Context propagation through layers
- Tenant deletion and data cleanup

### 2. **COMPLETE_FREELANCER_WIDGET_GUIDE.md**

Embedded widget API for cross-tenant integration.

- Embedded experience for customers
- Widget authentication
- Secure communication between systems
- Use case: salon booking widget on external websites

### 3. **WIDGET_API_INTEGRATION.md** (Enhanced)

Technical guide for widget API integration.

- API endpoints
- Authentication patterns
- Data boundaries
- Example implementations

## Key Concepts

- **Tenant Scoping**: Every operation filters data by tenant_id
- **Access Control**: Role-based access within tenant boundaries
- **Context Propagation**: Tenant ID flows from request → service → repository
- **Embedded Widgets**: Secure cross-tenant integration patterns

## Reading Order

1. Start with TENANT_ARCHITECTURE.md for system overview
2. Read COMPLETE_FREELANCER_WIDGET_GUIDE.md for embedding scenarios
3. Implement using WIDGET_API_INTEGRATION.md

## Related Documentation

- **Database implementation**: See `../04-database-design/TENANT_SCOPED_QUERIES.md`
- **API patterns**: See `../05-api-design/`
- **Authorization**: See `../03-authorization-security/`

---

**Common Scenarios:**

- New tenant onboarding
- Tenant data isolation verification
- Widget embed debugging
- Access boundary testing
