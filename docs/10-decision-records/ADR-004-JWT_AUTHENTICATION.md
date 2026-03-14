# ADR-004: JWT Tokens with Tenant Context Over Session-Based Auth

**Status:** Accepted
**Date:** 2025-05-10
**Audience:** Backend Engineers, Security Architects, Platform Leads
**Supersedes:** None
**Superseded By:** None

---

## Decision

We will use **stateless JWT (JSON Web Tokens) with embedded tenant context** for authentication rather than adopting traditional session-based authentication (server-side sessions with session stores).

JWT tokens will include the following claims:

- `sub` (subject): User ID
- `tenant_id`: Tenant ID (for multi-tenancy)
- `roles`: User roles within the tenant
- `iat` (issued at): Token issuance timestamp
- `exp` (expiration): Token expiration timestamp

---

## Context

The salon SaaS platform requires user authentication across three client types:

1. **Web browsers** (customer portal, staff dashboard, admin panel)
2. **Mobile apps** (Capacitor-wrapped PWA, iOS/Android native)
3. **API clients** (third-party integrations, mobile backends)

The platform operates as a distributed system with:

- Multiple application instances (horizontal scaling)
- Real-time features (WebSocket connections)
- Offline-first mobile support (token-based validation)
- Potential multi-region deployments

Authentication must support:

- **Statelessness:** No server-to-server session synchronization
- **Scalability:** Work across multiple backend instances
- **Mobile:** Token storage in secure mobile storage (not cookies)
- **Offline:** Token can be validated without hitting auth service
- **Tenant Context:** Token carries tenant information (not looked up on every request)

---

## Options Considered

### Option A: JWT Tokens (Stateless) ✓ CHOSEN

**Implementation:**
Authentication tokens are self-signed JWTs. User identity and tenant context embedded in token. Backend verifies signature and claims on every request.

**Token Example:**

```json
// JWT Payload (decoded)
{
  "sub": "user-123",
  "tenant_id": "salon-456",
  "roles": ["owner", "scheduler"],
  "email": "alice@salon.example.com",
  "iat": 1620000000,
  "exp": 1620086400  // Token valid for 24 hours
}

// Token Verification
const decoded = jwt.verify(token, publicKey);
// If verification succeeds: token is valid and unaltered
// Extract tenant_id from payload: tenant_id = decoded.tenant_id
```

**Login Flow:**

```typescript
// 1. User provides credentials
async login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
  // 2. Verify email/password against user records
  const user = await usersRepository.findByEmail(email);
  if (!user || !bcrypt.compare(password, user.passwordHash)) {
    throw new UnauthorizedException('Invalid credentials');
  }

  // 3. Generate JWT with tenant context
  const accessToken = jwt.sign(
    {
      sub: user.id,
      tenant_id: user.tenantId,  // 🔑 Tenant embedded
      roles: user.roles,
      email: user.email,
    },
    privateKey,
    { expiresIn: '24h' }
  );

  // 4. Generate refresh token (longer-lived, can be revoked in DB)
  const refreshToken = jwt.sign(
    { sub: user.id, tenant_id: user.tenantId },
    privateKey,
    { expiresIn: '7d' }
  );

  return { accessToken, refreshToken };
}
```

**Request Validation (Middleware):**

```typescript
// 1. Extract token from Authorization header
const token = req.headers.authorization?.split(' ')[1];

// 2. Verify token signature and expiration
const decoded = jwt.verify(token, publicKey);

// 3. Extract tenant context
const tenantId = decoded.tenant_id;

// 4. Inject tenant into request context
req.context = { userId: decoded.sub, tenantId, roles: decoded.roles };

// 5. All downstream handlers access tenant from context
```

**Pros:**

- ✅ **Stateless:** No server-side session store needed; scale horizontally
- ✅ **Distributed:** Works across multiple backend instances without synchronization
- ✅ **Mobile-Friendly:** Token fits in secure mobile storage (no cookies needed)
- ✅ **Offline Validation:** Token can be verified client-side (if public key known)
- ✅ **Tenant Context:** Tenant ID available in token; no DB lookup needed
- ✅ **Scalable:** No session replication or clustering required
- ✅ **Industry Standard:** Widely adopted (Stripe, Auth0, Okta use JWTs)
- ✅ **Explicit Claims:** Token contents are transparent (payload readable, though signature-protected)

**Cons:**

- ❌ **Token Revocation Hard:** Can't invalidate token before expiration without checking a blacklist (adds statefulness)
- ❌ **Token Size:** Encoded payload increases HTTP header size (though typically <1KB, negligible)
- ❌ **Logout Complexity:** User "logout" requires either expiring token or maintaining a blacklist
- ❌ **Claims Staleness:** If user's role changes, token won't reflect it until next login
- ❌ **Secret Key Rotation:** Must maintain old keys to validate tokens issued before rotation

---

### Option B: Server-Side Sessions

**Implementation:**
Traditional session-based authentication. User logs in → server creates session → session ID stored in encrypted cookie → session state stored in server (database or cache).

**Session Flow:**

```typescript
// 1. User logs in
async login(email: string, password: string): Promise<string> {
  const user = await usersRepository.findByEmail(email);
  if (!user || !bcrypt.compare(password, user.passwordHash)) {
    throw new UnauthorizedException();
  }

  // 2. Create session in store
  const sessionId = generateUniqueId();
  await sessionStore.set(sessionId, {
    userId: user.id,
    tenantId: user.tenantId,
    roles: user.roles,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  // 3. Return session ID in HTTP-only cookie
  // Browser automatically attaches cookie to every request
  res.cookie('sessionId', sessionId, { httpOnly: true, secure: true, sameSite: 'strict' });
  return 'Login successful';
}

// 4. Request middleware: validate session
const session = await sessionStore.get(req.cookies.sessionId);
if (!session || session.expiresAt < Date.now()) {
  throw new UnauthorizedException('Session expired');
}
req.context = { userId: session.userId, tenantId: session.tenantId };
```

**Pros:**

- ✅ **Revocation Immediate:** Logout = delete session entry; instant invalidation
- ✅ **Claims Fresh:** Session updated immediately if user's role changes
- ✅ **Simpler Token Handling:** Session ID is opaque; no token contents to manage
- ✅ **Cookies Automatic:** Browser handles; no manual token management
- ✅ **CSRF Protection:** Cookies can leverage CSRF tokens (stateless JWTs have CSRF implications)

**Cons:**

- ❌ **Stateful:** Server must maintain session store (DB, Redis cluster)
- ❌ **Scaling Complexity:** Multi-instance deployments need distributed session store or sticky sessions
- ❌ **Mobile Awkward:** Cookies not the native pattern; workaround needed (Bearer token with sessionId)
- ❌ **Session Replication:** If using sessions, must replicate across regions
- ❌ **Logout Complexity at Scale:** Session cleanup across distributed session stores
- ❌ **Session Store Failure:** Session store outage = all users logged out (hard dependency)

---

### Option C: OAuth 2.0 / OpenID Connect

**Implementation:**
Delegate authentication to third-party identity provider (e.g., Auth0, Okta, Google, Microsoft). Platform validates tokens issued by provider.

**Flow:**

```
User → [Sign in with Google]
      ↓
      Google OAuth flow
      ↓
      [Redirect with authorization code]
      ↓
Platform backend exchanges code for ID token + access token
      ↓
Platform creates internal session/JWT with user + tenant
      ↓
User authenticated to platform
```

**Pros:**

- ✅ **Externalized Auth:** Offload security to trusted provider (Google, Microsoft)
- ✅ **Multi-Factor Authentication:** Provider handles MFA; platform gets verified user
- ✅ **Social Login:** Users can sign in with existing accounts
- ✅ **User Management:** Provider manages password resets, email verification
- ✅ **Compliance:** Providers maintain SOC 2, GDPR compliance

**Cons:**

- ❌ **External Dependency:** Authentication relies on third-party provider availability
- ❌ **Complexity:** OAuth flow adds implementation complexity
- ❌ **Tenant Mapping:** Must map OAuth identity to internal tenants (additional logic)
- ❌ **Cost:** OAuth providers charge per active user or transaction
- ❌ **Vendor Lock-in:** Switching providers later requires migration
- ❌ **Offline Unsupported:** Can't work offline; always need provider
- ❌ **Overkill for Internal Use:** If only internal users or simple sign-up, OAuth adds overhead

---

## Chosen Option

**JWT Tokens with Tenant Context (Option A)**

### Rationale

1. **Stateless Architecture:** Platform is designed for horizontal scaling. JWTs eliminate session store as a bottleneck.

2. **Mobile First:** PWA and mobile apps require tokens (cookies not native). JWT is the standard token format.

3. **Distributed System:** Multiple backend instances serve requests. No need to synchronize sessions; JWTs are self-contained.

4. **Tenant Context:** Multi-tenant system benefits from tenant ID embedded in token. Eliminates DB lookup on every request.

5. **Offline-First Mobile:** PWA supports offline booking. Token can be cached and validated client-side.

6. **Industry Standard:** JWTs are the de facto standard for modern web/mobile APIs. Team familiarity high.

7. **Cost Effective:** No third-party OAuth provider needed; no per-user licensing fees.

8. **Revocation Mitigation:** For logout, can use refresh token revocation pattern:
   - Short-lived access tokens (1 hour)
   - Longer-lived refresh tokens (7 days)
   - Logout = revoke refresh token in DB
   - Even if access token stolen, useless after 1 hour

---

## Trade-Offs

| Aspect             | JWT                  | Sessions            | OAuth                |
| ------------------ | -------------------- | ------------------- | -------------------- |
| **Statefulness**   | Stateless            | Stateful            | Delegated (stateful) |
| **Scalability**    | Excellent            | Requires sync       | Depends on provider  |
| **Revocation**     | Delayed (until exp)  | Immediate           | Immediate            |
| **Mobile**         | Native               | Workaround          | Requires provider    |
| **Complexity**     | Medium               | Low                 | High                 |
| **Cost**           | Low                  | Medium (store)      | Medium-High          |
| **Tenant Context** | Embedded (efficient) | Looked up (DB call) | Mapped (custom)      |

---

## Consequences

### Positive Consequences

✅ **Scalable:** Works across distributed backend instances without synchronization.

✅ **Mobile-Optimized:** Tokens fit naturally in secure mobile storage.

✅ **Stateless:** No session store bottleneck or failover needed.

✅ **Tenant Context Efficient:** Tenant ID available in every request without DB lookup.

✅ **Offline Support:** Token can be validated offline (with public key).

✅ **API-Friendly:** Standard for REST/GraphQL APIs; easy for third-party integrations.

✅ **Clear Expiration:** Token expiration timestamp in payload; no implicit session timeout surprises.

### Negative Consequences

❌ **Logout Complexity:** Can't immediately invalidate token; must implement refresh token revocation or maintain a blacklist.

❌ **Claims Staleness:** If user's role changes mid-session, token won't reflect it until next login.

❌ **Token Size:** Payload increases HTTP header size (mitigated by short claims; typically <1KB).

❌ **Secret Key Rotation:** Must support multiple keys during rotation to avoid invalidating all tokens.

❌ **XSS Vulnerability:** If token stored in localStorage, vulnerable to XSS attacks (mitigation: secure HttpOnly cookies or secure mobile storage).

---

## Implementation Details

### Token Structure

```json
{
  "header": {
    "alg": "RS256", // RSA signature algorithm (more secure than HS256)
    "typ": "JWT"
  },
  "payload": {
    "sub": "user-uuid", // User ID
    "tenant_id": "salon-uuid", // Tenant ID (CRITICAL for multi-tenancy)
    "roles": ["owner"], // User roles within tenant
    "email": "user@salon.com",
    "iat": 1620000000, // Issued at
    "exp": 1620086400 // Expires in 24 hours
  },
  "signature": "HMACSHA256(header + payload, secret)"
}
```

### Token Lifecycle

```
Login
  ↓
Generate Access Token (24 hours) + Refresh Token (7 days)
  ↓
Client stores both tokens (secure storage)
  ↓
Access token expires → Client uses refresh token to get new access token
  ↓
User logs out → Revoke refresh token in DB
  ↓
Refresh token expires → Force re-login
```

### Logout Flow

```typescript
async logout(tenantId: string, userId: string): Promise<void> {
  // Revoke refresh tokens in database
  await refreshTokenRepository.revokeByUser(userId);
  // Access token expires naturally (24 hours)
  // Client discards stored tokens
}
```

### Token Refresh Flow

```typescript
async refreshAccessToken(refreshToken: string): Promise<string> {
  // Verify refresh token signature
  const decoded = jwt.verify(refreshToken, publicKey);

  // Check if refresh token revoked
  const isRevoked = await refreshTokenRepository.isRevoked(decoded.jti); // jti = token ID
  if (isRevoked) {
    throw new UnauthorizedException('Refresh token revoked');
  }

  // Generate new access token
  return jwt.sign(
    { sub: decoded.sub, tenant_id: decoded.tenant_id, roles: decoded.roles },
    privateKey,
    { expiresIn: '24h' }
  );
}
```

---

## Enforcement Mechanisms

### 1. Mandatory Tenant Inclusion

Every JWT must include `tenant_id` claim. Code review checklist:

- [ ] `tenant_id` included in token payload
- [ ] Middleware extracts `tenant_id` and injects into request context
- [ ] All repositories receive `tenantId` as explicit parameter

### 2. Signature Verification

```typescript
const publicKey = fs.readFileSync('/path/to/public-key.pem', 'utf-8');
const decoded = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
// If verification fails: throw UnauthorizedException
```

### 3. Expiration Enforcement

Never use `jwt.decode()` without verification. Always use `jwt.verify()`:

```typescript
// ❌ WRONG: Doesn't verify signature or expiration
const decoded = jwt.decode(token);

// ✅ CORRECT: Verifies signature, expiration, and claims
const decoded = jwt.verify(token, publicKey);
```

### 4. Refresh Token Revocation on Logout

```typescript
async logout(userId: string): Promise<void> {
  // Mark all refresh tokens for user as revoked
  await db.update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.userId, userId));
}
```

---

## Migration Path: JWT → OAuth or Session-Based

If requirements change (e.g., centralized auth provider, enterprise SSO):

**Phase 1: Abstraction Layer**

- Extract authentication logic into `AuthenticationStrategy` interface
- Implement both JWT and alternative strategy
- Route requests based on configuration

**Phase 2: Gradual Migration**

- Deploy OAuth/Session strategy alongside JWT
- Migrate users gradually (opt-in, then enforce)
- Run parallel validation (both auth methods work for single user)

**Phase 3: Deprecate JWT**

- Once all users migrated, disable JWT generation
- Existing tokens still valid until expiration
- Old tokens eventually expire naturally

**Estimated Effort:** 2-3 sprints

---

## Decision Log

**Approved by:** Architecture Review Board
**Approved Date:** 2025-05-10
**Implementation Started:** Q2 2025
**Related Issues:** AUTH-0001, AUTH-0002
**Related ADRs:** ADR-001 (Shared Schema), ADR-002 (Row Filtering)

---

## References

- [AUTH_ARCHITECTURE.md](../03-authorization-security/AUTH_ARCHITECTURE.md)
- JWT.io: Introduction to JSON Web Tokens
- RFC 7519: JSON Web Token (JWT)
- OWASP: Session Management Cheat Sheet
- Auth0 Blog: Best Practices for JWT Handling
