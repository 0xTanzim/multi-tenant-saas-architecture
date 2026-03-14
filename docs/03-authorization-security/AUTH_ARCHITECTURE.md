# Portfolio Note

> Extracted from production system, sanitized for portfolio use.

---

# Authentication Architecture

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Schema](#2-database-schema)
3. [Cookie-Based Auth Model](#3-cookie-based-auth-model)
4. [Token Structure](#4-token-structure)
5. [Session Management](#5-session-management)
6. [Token Rotation](#6-token-rotation)
7. [OAuth Integration](#7-oauth-integration)
8. [Registration and Login Flows](#8-registration-and-login-flows)
9. [Middleware Chain](#9-middleware-chain)
10. [Edge Cases](#10-edge-cases)
11. [Security Considerations](#11-security-considerations)
12. [Production Configuration](#12-production-configuration)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Architecture Overview

The the Platform platform uses a cookie-based authentication system with JWT tokens, automatic token rotation, and session management. The architecture spans three layers:

- **Next.js Edge Middleware** handles token verification, automatic refresh, and route guarding
- **NestJS Backend** manages session lifecycle, token generation, and credential validation
- **PostgreSQL Database** stores user records, sessions, credentials, verifications, and OAuth identities

### Module Structure

The auth module (`apps/api/src/auth/`) is organized as:

```
auth/
  auth.module.ts
  config/
    jwt.config.ts
  constants/
  controllers/
    auth.controller.ts          # Login, register, refresh, logout
    admin.controller.ts         # Admin-only session management
  decorators/
    auth.decorator.ts           # @Auth() user extraction
    public.decorator.ts         # @Public() bypass guard
  guards/
    jwt-auth.guard.ts           # Global JWT validation
    self-or-admin.guard.ts      # Self-access or admin override
  repositories/
    auth.repository.ts          # User/credential queries
    session.repository.ts       # Session CRUD
  services/
    auth.service.ts             # Facade service
    management/
      admin.service.ts          # Admin operations
      session.service.ts        # Session lifecycle
      user-tenant.service.ts    # Tenant resolution
    security/
      email-verification.service.ts
      jwt.service.ts            # Token generation/validation
      password.service.ts       # Hashing, comparison
      password-reset.service.ts
    workflows/
      auth-login.service.ts     # Login orchestration
      auth-registration.service.ts
      auth-session.service.ts   # Session refresh
      auth-tenant.service.ts    # Tenant switching
      auth-walkin.service.ts    # Walk-in customer auth
  oauth/
    controllers/
      oauth.controller.ts       # OAuth callback handler
    repositories/
      oauth-identity.repository.ts
      oauth-token.repository.ts
    services/
      oauth-state.service.ts    # CSRF state management
      unified-oauth.service.ts  # Provider abstraction
      providers/
        google-oauth.service.ts
```

### Request Flow

```
Browser (cookies)
  --> Next.js Edge Middleware (withTokenRefresh -> withRouteGuard -> withI18n)
    --> NestJS API (JwtAuthGuard)
      --> Controller -> Service -> Repository
        --> PostgreSQL
```

---

## 2. Database Schema

All auth-related tables are defined in `packages/db/src/schema/auth/`.

### 2.1 Users (`users`)

Minimal authentication identity. Business/customer data lives in separate profile tables.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `serial` | Primary key |
| `email` | `varchar(255)` | Unique (excluding soft-deleted) |
| `hashed_email` | `varchar(128)` | Privacy lookups |
| `name` | `varchar(255)` | Display name |
| `avatar_url` | `text` | Profile image |
| `signup_intent` | `enum('customer','partner','staff')` | Post-login redirection |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |
| `deleted_at` | `timestamptz` | Soft delete |
| `anonymized_at` | `timestamptz` | GDPR anonymization |
| `legal_hold_until` | `timestamptz` | GDPR legal hold |

**Indexes:** Unique on `email` (where `deleted_at IS NULL`), unique on `hashed_email`.

### 2.2 User Credentials (`user_credentials`)

Separated from users for security isolation. One record per user.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `serial` | Primary key |
| `user_id` | `integer` | FK to `users.id` (cascade delete) |
| `password_hash` | `varchar(255)` | bcrypt hash |
| `failed_login_count` | `integer` | Brute-force tracking |
| `locked_until` | `timestamptz` | Account lockout |
| `password_changed_at` | `timestamptz` | |
| `created_at` | `timestamptz` | |

**Indexes:** Unique on `user_id`.

### 2.3 User Sessions (`user_sessions`)

Tracks active sessions with device fingerprinting.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `serial` | Primary key |
| `user_id` | `integer` | FK to `users.id` (cascade delete) |
| `session_id` | `varchar(64)` | Immutable JWT session identifier |
| `refresh_token_hash` | `varchar(128)` | SHA256 of current refresh token |
| `device_name` | `varchar(255)` | e.g., "Chrome on MacOS" |
| `device_type` | `varchar(50)` | `'web'`, `'ios'`, `'android'` |
| `ip_address` | `inet` | Client IP |
| `user_agent` | `text` | Full UA string |
| `expires_at` | `timestamptz` | Session expiration (7 days) |
| `last_used_at` | `timestamptz` | Updated on each refresh |
| `created_at` | `timestamptz` | |
| `invalidated_at` | `timestamptz` | Non-null = logged out |

**Indexes:** Unique on `session_id`, unique on `refresh_token_hash`, composite index on `(user_id, last_used_at)` where `invalidated_at IS NULL`, index on `expires_at` for cleanup.

### 2.4 User Verifications (`user_verifications`)

Handles email verification and password reset tokens.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `serial` | Primary key |
| `user_id` | `integer` | FK to `users.id` |
| `type` | `varchar(50)` | `'email_verification'`, `'password_reset'` |
| `code_hash` | `varchar(128)` | Hashed verification code |
| `email_verified` | `boolean` | Verification status |
| `attempts` | `integer` | Rate-limiting counter |
| `expires_at` | `timestamptz` | Token expiration |
| `verified_at` | `timestamptz` | Completion timestamp |
| `created_at` | `timestamptz` | |

**Indexes:** Unique on `(user_id, type)` where `verified_at IS NULL`, index on `code_hash`, index on `expires_at`.

### 2.5 OAuth Identities (`user_oauth_identities`)

Links external provider accounts to internal users.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `serial` | Primary key |
| `user_id` | `integer` | FK to `users.id` |
| `provider` | `varchar(50)` | `'google'`, `'facebook'`, `'apple'`, `'twitter'` |
| `provider_user_id` | `varchar(255)` | External user ID |
| `email_at_link` | `varchar(255)` | Email at time of linking |
| `linked_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

**Indexes:** Unique on `(provider, provider_user_id)`, unique on `(user_id, provider)`.

### 2.6 OAuth Tokens (`user_oauth_tokens`)

Stores provider access/refresh tokens for API integrations (e.g., Google Calendar sync).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `serial` | Primary key |
| `user_id` | `integer` | FK to `users.id` |
| `provider` | `varchar(50)` | Provider name |
| `access_token` | `text` | Provider access token |
| `refresh_token` | `text` | Provider refresh token (nullable) |
| `token_type` | `varchar(50)` | Default `'Bearer'` |
| `expires_at` | `timestamptz` | Token expiration |
| `scope` | `text` | Granted scopes |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

**Indexes:** Unique on `(user_id, provider)`, index on `expires_at`.

### 2.7 Enums

```
oauth_provider:     'google' | 'facebook' | 'apple' | 'twitter'
verification_type:  'email_verification' | 'password_reset' | 'phone_verification' | 'two_factor'
device_type:        'web' | 'ios' | 'android' | 'desktop'
signup_intent:      'customer' | 'partner' | 'staff'
```

---

## 3. Cookie-Based Auth Model

### 3.1 Cookie Configuration

Two httpOnly cookies carry authentication state:

| Cookie | Purpose | Flags |
|--------|---------|-------|
| `the platform_auth_token` | JWT access token | `httpOnly`, `secure`, `sameSite=lax` |
| `the platform_refresh_token` | JWT refresh token | `httpOnly`, `secure`, `sameSite=lax` |

Both cookies are:
- Not accessible via JavaScript (XSS protection)
- Only sent over HTTPS in production
- Sent on same-site and top-level GET navigations (OAuth redirect compatible)
- Scoped to the application domain (`path: /`)

### 3.2 Why `sameSite: 'lax'`

- `strict` would break OAuth redirects by not sending cookies on cross-site navigations
- `lax` sends cookies on top-level GET navigations while blocking cross-site POST requests
- Combined with CORS restrictions, this provides CSRF protection without explicit CSRF tokens

### 3.3 Mobile Client Support

Mobile apps use Bearer token headers instead of cookies. The backend supports both:

```typescript
const token =
  request.cookies['the platform_auth_token'] ||
  extractBearerToken(request.headers.authorization);
```

---

## 4. Token Structure

### 4.1 Access Token (JWT)

**TTL:** 15 minutes (production) | configurable via `JWT_ACCESS_TOKEN_TTL`

```json
{
  "sub": 24,
  "email": "user@example.com",
  "sessionId": "mjfvezbd-kz0nlc0bcbb",
  "customerId": "20",
  "platformRole": "customer",
  "activeTenant": {
    "id": 5,
    "role": "member",
    "permissions": ["booking:create", "booking:read"]
  },
  "aud": "the platform-api-users",
  "iss": "the platform-platform-auth"
}
```

### 4.2 Refresh Token (JWT)

**TTL:** 7 days | configurable via `JWT_REFRESH_TOKEN_TTL`

```json
{
  "sub": 24,
  "sessionId": "mjfvezbd-kz0nlc0bcbb",
  "type": "refresh",
  "aud": "the platform-api-users",
  "iss": "the platform-platform-auth"
}
```

The refresh token has a minimal payload. The `sessionId` is immutable across rotations, linking every token pair to the same database session record.

---

## 5. Session Management

### 5.1 Lifecycle

1. **Login** - Creates a `user_sessions` row with a unique `session_id`, stores the `refresh_token_hash` (SHA256), and returns both tokens as cookies.
2. **Active use** - Middleware verifies the access token and attaches user headers (`x-user-id`, `x-session-id`, etc.) to proxied requests.
3. **Token expired** - Middleware detects `ERR_JWT_EXPIRED` on the access token, sends the refresh token to `/auth/refresh`, receives new token pair, updates cookies.
4. **Refresh token expired** - Redirect to `/login` (full re-authentication required).
5. **Logout** - Backend sets `invalidated_at = NOW()` on the session, cookies are cleared.

### 5.2 Session Limit

**Max sessions per user:** 10 (configurable)

When a user exceeds the limit, the oldest sessions are invalidated (FIFO strategy).

### 5.3 Session Queries

Sessions are looked up by `session_id` (immutable), never by `refresh_token_hash`. The hash changes on every rotation, so hash-based lookups would break after the first refresh.

---

## 6. Token Rotation

### 6.1 Purpose

- Limits exposure if a refresh token is stolen
- Old tokens become invalid immediately after rotation
- Enables replay detection (reuse of a rotated token signals compromise)

### 6.2 Process

1. Client sends refresh token to `POST /auth/refresh`
2. Backend validates the JWT and extracts `sessionId`
3. Backend looks up session by `session_id` (not hash)
4. Backend generates new access + refresh tokens
5. Backend updates `refresh_token_hash` in the database
6. Old refresh token is now invalid (its hash no longer matches)

### 6.3 Timeline Example

```
T=0:00  Login       session_id=abc, refresh_hash=hash(JWT_A)
T=15:00 Refresh #1  session_id=abc, refresh_hash=hash(JWT_B)  [JWT_A invalid]
T=30:00 Refresh #2  session_id=abc, refresh_hash=hash(JWT_C)  [JWT_B invalid]
```

---

## 7. OAuth Integration

### 7.1 Supported Providers

Defined by the `oauth_provider` enum: `google`, `facebook`, `apple`, `twitter`.

Currently implemented: **Google OAuth**.

### 7.2 Module Structure

```
oauth/
  controllers/oauth.controller.ts       # Handles /auth/oauth/:provider and callbacks
  services/
    oauth-state.service.ts              # CSRF state token management
    unified-oauth.service.ts            # Provider-agnostic orchestration
    providers/google-oauth.service.ts   # Google-specific implementation
  repositories/
    oauth-identity.repository.ts        # user_oauth_identities CRUD
    oauth-token.repository.ts           # user_oauth_tokens CRUD
```

### 7.3 Flow

1. User clicks "Sign in with Google"
2. Backend generates a state token (CSRF protection) and redirects to provider
3. Provider redirects back with an authorization code
4. Backend exchanges code for provider tokens
5. Backend resolves or creates the local user via `user_oauth_identities`
6. Provider tokens are stored in `user_oauth_tokens` for API access (e.g., calendar sync)
7. A local session is created (same as password login)

---

## 8. Registration and Login Flows

### 8.1 Unified Identity Model

A user is a person, not a role. The same account supports customer, partner, and staff contexts without duplicate registrations.

- `signup_intent` on the `users` table records the original registration context
- Post-login behavior adapts based on tenant associations, not login page context

### 8.2 Registration

**Customer registration** (`intent=customer`):
1. Collect name, email, password
2. Create `users` + `user_credentials` records
3. Send email verification code
4. Redirect to `/verify-email`

**Partner registration** (`intent=partner`):
1. Same form, same records
2. After verification, redirect to onboarding wizard to create a tenant

### 8.3 Post-Login Redirection Matrix

| User State | Destination |
|------------|-------------|
| Email not verified | `/verify-email` |
| 0 tenants, intent = `customer` | `/explore` (booking) |
| 0 tenants, intent = `partner` | `/onboarding` (wizard) |
| 1 tenant (owner or staff) | `/dashboard` |
| Multiple tenants | `/select-tenant` (workspace switcher) |

### 8.4 Customer-to-Partner Upgrade

A logged-in customer can create a business from their profile menu ("List your Business"). The backend creates a new tenant and upgrades the session with tenant context. The user then sees a "Switch to Business" toggle.

### 8.5 Staff Invitation

When a user is invited as staff but has not registered, the invitation link sets `signup_intent = 'staff'`. After registration and verification, the user is automatically linked to the inviting tenant.

---

## 9. Middleware Chain

The Next.js edge middleware runs three chained handlers in order:

### 9.1 `withTokenRefresh`

1. Extracts `the platform_auth_token` from cookies
2. Verifies JWT using `jose` (edge-compatible library)
3. If valid: attaches user headers (`x-user-id`, `x-session-id`, `x-platform-role`, etc.)
4. If expired (`ERR_JWT_EXPIRED`): extracts `the platform_refresh_token` and calls `POST /auth/refresh` with Bearer header. Updates cookies with new tokens.
5. If refresh fails: clears cookies, marks as unauthenticated

### 9.2 `withRouteGuard`

1. Checks if the requested route is in the `PUBLIC_ROUTES` list
2. If route requires auth and user is unauthenticated: redirect to `/login`
3. Passes through otherwise

### 9.3 `withI18n`

Handles locale detection and routing.

---

## 10. Edge Cases

### 10.1 Concurrent Requests During Refresh

Multiple browser tabs may trigger simultaneous requests when a token expires. The first request to reach the backend performs the rotation; subsequent requests using the old token will receive a 401. The frontend should retry with the updated cookie on 401.

### 10.2 Token Expiry During Long Requests

Token validity is checked once at request start. A request that runs longer than the token TTL will complete normally; the next request triggers a refresh.

### 10.3 Session Invalidated Remotely

If a user logs out from Device A while using Device B, Device B's next request will find `invalidated_at` set on the session and redirect to login.

### 10.4 Browser Blocks Cookies

In privacy/incognito modes where cookies are blocked, authentication will fail. The system redirects to login on every request. This is expected behavior for httpOnly cookie-based auth.

### 10.5 Database Unavailable During Refresh

If the database is unreachable during a token refresh, the backend returns a 503 (Service Unavailable). The frontend shows a temporary error instead of logging the user out, allowing retry after recovery.

### 10.6 Interrupted Onboarding

If a partner registers, verifies email, but loses connectivity before completing the onboarding wizard, the `signup_intent = 'partner'` record persists. On next login, the redirection matrix detects 0 tenants + partner intent and routes back to the wizard.

### 10.7 Wrong Login Page

Login page context (customer vs. partner) is cosmetic only. Post-login routing uses the redirection matrix based on actual tenant associations, not the login URL.

---

## 11. Security Considerations

### 11.1 OWASP Top 10 Coverage

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Broken Access Control | JwtAuthGuard + tenant isolation | Implemented |
| Cryptographic Failures | SHA256 token hashing, secure JWT signing | Implemented |
| Injection | Prepared statements (Drizzle ORM) | Implemented |
| Insecure Design | Token rotation, session limits | Implemented |
| Security Misconfiguration | httpOnly, secure, sameSite cookies | Implemented |
| Identification Failures | Device tracking, account lockout | Partial (MFA not implemented) |
| Data Integrity Failures | HTTPS only, sameSite CSRF protection | Implemented |

### 11.2 Rate Limiting

- Login endpoint: 3 requests/second, 10 requests/minute
- Refresh endpoint: 20 requests/minute
- Protects against brute-force and token refresh abuse

### 11.3 Account Lockout

`user_credentials.failed_login_count` tracks failed attempts. `locked_until` enforces a temporary lockout after excessive failures.

### 11.4 Session Hijacking Prevention

- Device fingerprinting: `device_type`, `user_agent`, `ip_address` stored per session
- Token rotation: limits the exposure window of any single token
- Session invalidation: users can view and terminate active sessions

### 11.5 XSS and CSRF Protection

- **XSS**: httpOnly cookies prevent JavaScript access to tokens. React's default output encoding and CSP headers provide additional layers.
- **CSRF**: `sameSite=lax` cookies combined with CORS origin restrictions. No explicit CSRF tokens needed.

### 11.6 Token Size

JWT access tokens include tenant/permission data. If the payload approaches the 4KB cookie limit, large permission arrays should be moved to Redis cache with only reference IDs in the JWT.

---

## 12. Production Configuration

### 12.1 Environment Variables

```bash
JWT_SECRET=<strong-random-secret-min-32-chars>
JWT_ACCESS_TOKEN_TTL=900          # 15 minutes
JWT_REFRESH_TOKEN_TTL=604800      # 7 days
NODE_ENV=production
COOKIE_SECURE=true
NEXT_PUBLIC_API_URL=https://api.the platform.com
```

### 12.2 Infrastructure Recommendations

- **Load Balancer**: Enable sticky sessions for WebSocket connections
- **Database**: Connection pooling (min 10, max 50), read replicas for session lookups
- **Monitoring**: Track `auth.token.refresh.success`, `auth.token.refresh.failure`, `auth.session.active.count`
- **Alerts**: Refresh failure rate > 5% (5-min window), session creation spike, query latency > 500ms

### 12.3 Security Hardening

- Enable Helmet.js with CSP and HSTS headers
- CORS origin restricted to production domain
- SSL/TLS for database connections
- Encrypt `refresh_token_hash` at rest (PostgreSQL TDE)

---

## 13. Troubleshooting

### 13.1 User Redirected to Login Repeatedly

**Check:** Does the session exist and is it active?

```sql
SELECT id, session_id, invalidated_at
FROM user_sessions
WHERE user_id = ? AND invalidated_at IS NULL;
```

**Common causes:**
- Session was invalidated (logged out from another device)
- The `findActiveSessionBySessionId()` method is not finding the session
- Middleware refresh call is timing out

### 13.2 Infinite Redirect Loop

**Check:** Is `/login` included in the `PUBLIC_ROUTES` array? Verify the middleware chain order and ensure no circular redirects exist in the Next.js config.

### 13.3 Token Refresh Returns 400

**Check:** Is the refresh token being sent as a Bearer header? Verify the cookie is not expired and contains a valid JWT.

### 13.4 Session Not Found After Rotation

**Check:** Ensure session lookup is by `session_id` (immutable), not by `refresh_token_hash` (changes every rotation).

### 13.5 Debug Commands

```sql
-- Check active sessions for a user
SELECT id, user_id, session_id, created_at, last_used_at, invalidated_at
FROM user_sessions
WHERE user_id = ? AND invalidated_at IS NULL;
```

```bash
# Decode a JWT
echo "<token>" | npx jwt-cli decode

# Test refresh manually
curl -X POST http://localhost:8444/auth/refresh \
  -H "Authorization: Bearer <refresh_token>"
```

---

*Last updated: February 2026*
