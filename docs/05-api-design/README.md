# API Design & Integration

RESTful API patterns, contract management, versioning, and multi-tenant integration.

## Files

### 1. **API_ENDPOINT_PATTERNS.md**

RESTful endpoint design.

- CRUD operations (GET, POST, PUT, DELETE)
- Resource naming conventions
- Query parameters and filtering
- Response formatting

### 2. **TENANT_CONTEXT_PROPAGATION.md**

How tenant context flows through API.

- JWT extraction from headers
- Tenant ID in request context
- Service layer access
- Response filtering

### 3. **RATE_LIMITING_AND_THROTTLING.md**

API rate limiting strategies.

- Per-tenant rate limits
- Throttling implementation
- Backoff strategies
- Quota management

### 4. **API_VERSIONING_STRATEGY.md**

Managing API changes over time.

- Versioning approaches (URL vs header)
- Backward compatibility
- Deprecation procedures
- Migration paths

### 5. **ERROR_HANDLING_AND_RESPONSES.md**

Standardized error responses.

- HTTP status codes
- Error response format
- Error messages (no sensitive data)
- Debugging guidance

### 6. **REQUEST_VALIDATION_AND_DTOs.md**

Input validation and data transfer objects.

- DTO validation rules
- Zod schema definitions
- Validation decorators
- Error messages

### 7. **WEBHOOK_AND_EVENT_INTEGRATION.md**

Asynchronous integration patterns.

- Webhook design
- Event publishing
- Retry strategies
- Dead letter queues

## API Contract

```typescript
// Standard response format
{
  success: boolean;
  data: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: ISO8601;
}
```

## Tenant Context in Requests

```
Request → Extract JWT → Get tenant_id from token
  → Pass tenant context to service
  → Service uses context for authorization
  → Repository filters by tenant_id
  → Return only tenant-scoped data
```

## Reading Order

1. Start with API_ENDPOINT_PATTERNS.md (overview)
2. Read TENANT_CONTEXT_PROPAGATION.md (multi-tenant)
3. Explore specific patterns in feature-specific sections
4. Reference ERROR_HANDLING_AND_RESPONSES.md for API design

## Common Scenarios

- Creating a new API endpoint
- Adding input validation
- Implementing rate limiting
- Handling multi-tenant requests
- API versioning and deprecation

---

**See Also**: Real-world patterns in `../07-real-world-patterns/`
