# Security Best Practices

Essential security practices for SaaS systems: data validation, audit logging, secrets management, common vulnerabilities, and incident response.

---

## Table of Contents

- [Input Validation](#input-validation)
- [Output Encoding](#output-encoding)
- [Audit Logging](#audit-logging)
- [Secrets Management](#secrets-management)
- [Common Vulnerabilities](#common-vulnerabilities)
- [Cryptography Basics](#cryptography-basics)
- [Secure Communication](#secure-communication)
- [Security Testing](#security-testing)
- [Incident Response](#incident-response)

---

## Input Validation

### **Principle: Never Trust Client Input**

Every byte of data entering the system must be validated.

```
Client Input
  ├─ Type Check     (is it the expected type?)
  ├─ Format Check   (does it match expected format?)
  ├─ Length Check   (is it within bounds?)
  ├─ Range Check    (is it within valid range?)
  ├─ Whitelist      (is it in the allowed set?)
  ├─ Sanitize       (remove/escape dangerous characters?)
  └─ Transform      (normalize to canonical form?)
```

### **Validation Strategy**

```typescript
// ❌ Minimal validation (vulnerable)
@Post('users')
async createUser(@Body() dto: CreateUserDto) {
  // Only type-checked by TypeScript, no runtime validation
  if (!dto.email) throw new Error('Email required');
  return this.usersService.createUser(dto);
}

// ✅ Better: Use class validator
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password: string;

  @IsString()
  @MaxLength(100)
  name: string;
}

@Post('users')
@UsePipes(new ValidationPipe({ transform: true }))
async createUser(@Body() dto: CreateUserDto) {
  // Validated at runtime before reaching handler
  return this.usersService.createUser(dto);
}
```

### **Specific Validation Rules**

#### **Email Validation**

```typescript
// ✅ Use email validator library
import isEmail from 'isemail';

function validateEmail(email: string): boolean {
  return isEmail.validate(email);
}

// ❌ Avoid regex (incomplete)
const regex = /^[\w\.-]+@[\w\.-]+\.\w+$/;
// Too permissive, misses edge cases

// ✅ Best: Standard format check
function validateEmail(email: string): boolean {
  return email.includes('@') && email.length <= 254;
  // RFC 5321 max length
}
```

#### **URL Validation**

```typescript
// ✅ Use URL parsing
function validateUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    // Verify protocol
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

// ❌ Avoid regex for complex formats
```

#### **File Upload Validation**

```typescript
// ✅ Validate file uploads
async validateUpload(file: Express.Multer.File) {
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

  // 1. Check MIME type
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    throw new BadRequestException('File type not allowed');
  }

  // 2. Check file size
  if (file.size > MAX_SIZE) {
    throw new BadRequestException('File too large');
  }

  // 3. Verify magic bytes (file signature)
  const magicBytes = file.buffer.slice(0, 8);
  if (!verifyMagicBytes(magicBytes, file.mimetype)) {
    throw new BadRequestException('File content does not match MIME type');
  }

  // 4. Scan for malware (optional)
  const isSafe = await scanForMalware(file.buffer);
  if (!isSafe) {
    throw new BadRequestException('File failed security scan');
  }

  return true;
}

function verifyMagicBytes(bytes: Buffer, mimeType: string): boolean {
  const signatures = {
    'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
    'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'application/pdf': Buffer.from([0x25, 0x50, 0x44, 0x46]),
  };

  const expected = signatures[mimeType];
  return expected && bytes.slice(0, expected.length).equals(expected);
}
```

---

## Output Encoding

### **Principle: Encode All Output**

Data output in different contexts requires different encoding:

```
Context → Encoding Method
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HTML     → HTML Entity Encoding
JavaScript → JavaScript String Encoding
URL      → URL Encoding
CSS      → CSS Encoding
JSON     → JSON Encoding
SQL      → Parameterized Queries (not concatenation)
```

### **HTML Encoding** (XSS Prevention)

```typescript
// ❌ Vulnerable: Direct output (XSS risk)
@Get('comments/:id')
async getComment(@Param('id') id: string) {
  const comment = await this.commentsService.getComment(id);
  // Response sent as-is
  return comment;
  // If comment.text = "<img src=x onerror=alert('XSS')>"
  // Browser executes JavaScript
}

// ✅ Secure: HTML encode output
import { escape } from 'html-escaper';

@Get('comments/:id')
async getComment(@Param('id') id: string) {
  const comment = await this.commentsService.getComment(id);
  return {
    ...comment,
    text: escape(comment.text), // Convert <, >, &, ", ' to entities
  };
}

// ✅ Better: Let framework handle it (React, Vue, etc.)
// Frontend frameworks auto-escape by default
// <div>{comment.text}</div> is safe
```

### **URL Encoding**

```typescript
// ❌ Vulnerable: Unencoded redirect
@Get('redirect')
async redirect(@Query('url') url: string) {
  return { redirectUrl: url };
}
// Attacker can craft: ?url=javascript:alert('XSS')

// ✅ Secure: Encode and validate
import { encodeURI } from 'js-uri';

@Get('redirect')
async redirect(@Query('url') url: string) {
  // Validate it's a safe URL
  if (!url.startsWith('https://trusted-domain.com/')) {
    throw new BadRequestException('Invalid redirect');
  }
  return { redirectUrl: encodeURI(url) };
}
```

### **JSON Encoding**

```typescript
// ✅ Secure: JSON.stringify auto-escapes
const data = {
  message: `<img src=x onerror="alert('XSS')">`,
};
const json = JSON.stringify(data);
// Output: {"message":"<img src=x onerror=\"alert('XSS')\">"}
// String is escaped, safe to send

// ❌ Don't do this (don't deserialize untrusted JSON as code)
// eval(userProvidedJson);  // NEVER
// Function(userProvidedJson)(); // NEVER
```

---

## Audit Logging

### **What to Log**

```
Security Events to Log:
  ✓ Authentication attempts (success + failure)
  ✓ Authorization failures (who tried to access what)
  ✓ Data access (read large datasets, exports)
  ✓ Data modifications (create, update, delete)
  ✓ Role changes (who assigned what)
  ✓ Administrative actions
  ✓ Configuration changes
  ✗ Passwords (never)
  ✗ Credit cards (never)
  ✗ Personally identifiable info (PII) without reason
```

### **Logging Implementation**

```typescript
// Audit Log Structure
interface AuditLog {
  timestamp: ISO8601;
  event_type: string; // 'AUTH_LOGIN', 'USER_CREATED', etc.
  actor_id: string; // Who did it
  actor_tenant_id: string; // Which tenant
  action: string; // What they did
  resource_type: string; // What they did it to
  resource_id: string; // Which resource
  status: 'success' | 'failure';
  reason?: string; // Why it failed (if failure)
  changes?: object; // What changed (before/after)
  ip_address: string; // Where from
  user_agent?: string; // What client
}

// Implementation
@Injectable()
export class AuditService {
  constructor(private db: Database) {}

  async log(event: AuditLog) {
    // 1. Sanitize sensitive data
    const sanitized = this.sanitizeEvent(event);

    // 2. Store in audit log table
    await this.db.query(
      `INSERT INTO audit_logs
       (timestamp, event_type, actor_id, actor_tenant_id, action, resource_type, resource_id, status, reason, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        new Date(),
        sanitized.event_type,
        sanitized.actor_id,
        sanitized.actor_tenant_id,
        sanitized.action,
        sanitized.resource_type,
        sanitized.resource_id,
        sanitized.status,
        sanitized.reason,
        sanitized.ip_address,
      ]
    );

    // 3. Emit to log aggregation service
    this.logger.info('Security event', sanitized);
  }

  private sanitizeEvent(event: AuditLog): AuditLog {
    // Remove sensitive fields
    const { email, password, credit_card, ...safe } = event;
    return safe;
  }
}
```

### **Audit Log Queries**

```typescript
// Who accessed a resource?
async getResourceAccessLog(resourceId: string, tenantId: string) {
  return this.db.query(
    `SELECT * FROM audit_logs
     WHERE resource_id = $1 AND actor_tenant_id = $2
     AND event_type IN ('DATA_READ', 'EXPORT')
     ORDER BY timestamp DESC LIMIT 100`,
    [resourceId, tenantId]
  );
}

// What did a user do?
async getUserActivityLog(userId: string, tenantId: string, days: number = 30) {
  return this.db.query(
    `SELECT * FROM audit_logs
     WHERE actor_id = $1 AND actor_tenant_id = $2
     AND timestamp > NOW() - INTERVAL '${days} days'
     ORDER BY timestamp DESC`,
    [userId, tenantId]
  );
}

// Detect suspicious activity
async detectSuspiciousActivity(tenantId: string) {
  return this.db.query(
    `SELECT * FROM audit_logs
     WHERE actor_tenant_id = $1
     AND status = 'failure'
     AND event_type = 'AUTH_LOGIN'
     AND timestamp > NOW() - INTERVAL '1 hour'
     GROUP BY actor_id
     HAVING COUNT(*) > 5  -- 5+ failed logins
     ORDER BY timestamp DESC`,
    [tenantId]
  );
}
```

### **Log Retention Policy**

```
Retention Duration:
  - Access logs (read): 30 days
  - Modification logs (create/update/delete): 1 year
  - Auth logs (login/logout): 90 days
  - Administrative logs: 2 years (compliance)
  - Security incidents: 3+ years (investigation)

Compliance Note:
  - GDPR: Right to deletion may conflict with audit requirements
  - PCI-DSS: Require 1 year retention for audit logs
  - HIPAA: Require 6 year retention for access logs
```

---

## Secrets Management

### **What Counts as a Secret?**

```
Secrets:
  ✓ API keys
  ✓ Database passwords
  ✓ JWT signing keys
  ✓ OAuth credentials
  ✓ Encryption keys
  ✓ Webhook signing secrets
  ✓ Third-party service credentials

NOT secrets (safe to commit):
  ✗ Public API keys (read-only)
  ✗ Environment names (dev, staging, prod)
  ✗ Configuration (e.g., page size, TTLs)
```

### **Secret Management Strategy**

```
┌─────────────────────────┐
│ Secret Vault            │
│ (AWS Secrets Manager,   │
│  HashiCorp Vault, etc.) │
└──────────────┬──────────┘
               │
               ▼
    ┌──────────────────────┐
    │ Application          │
    │ (running on EC2,     │
    │  Lambda, Pod, etc.)  │
    └──────────────────────┘

Flow:
  1. Application starts
  2. Request secret from vault (with IAM credentials)
  3. Vault verifies identity
  4. Vault returns secret
  5. Application uses secret
  6. Secret never written to disk
```

### **Development Environment**

```bash
# .env.local (NEVER commit this)
DATABASE_URL=postgresql://user:password@localhost/db
JWT_SECRET=dev-secret-never-use-in-prod
API_KEY_STRIPE=sk_test_...

# .env.example (COMMIT this, helps onboarding)
DATABASE_URL=postgresql://user:password@host/db
JWT_SECRET=generate-with-openssl-rand-hex-32
API_KEY_STRIPE=sk_test_... (get from Stripe dashboard)
```

### **Production Environment**

```typescript
// Load secrets from vault at startup
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        async () => {
          const secretsManager = new SecretsManager();
          const secrets = await secretsManager.getSecrets([
            'DATABASE_URL',
            'JWT_SECRET',
            'JWT_REFRESH_SECRET',
            'STRIPE_API_KEY',
          ]);
          return secrets;
        },
      ],
    }),
  ],
})
export class AppModule {}
```

### **Secret Rotation**

```
Rotation Strategy:
  1. Generate new secret
  2. Store alongside old secret (marked with version)
  3. Accept both old and new for grace period (e.g., 7 days)
  4. After grace period, accept only new
  5. Remove old secret

Example (JWT keys):
  Current Active: [key-v5]
  Rotation Start: [key-v5, key-v6]  (accept both)
  Rotation Done:  [key-v6]          (accept only new)
```

---

## Common Vulnerabilities

### **1. SQL Injection (SQLi)**

```typescript
// ❌ Vulnerable
const query = `SELECT * FROM users WHERE id = ${userId}`;
// If userId = "1; DROP TABLE users; --", table is deleted

// ✅ Secure: Parameterized query
const query = 'SELECT * FROM users WHERE id = $1';
await db.query(query, [userId]);
```

### **2. Cross-Site Scripting (XSS)**

```typescript
// ❌ Vulnerable
res.render('comment', { text: userProvidedText });
// If text contains <script>, it executes

// ✅ Secure: Auto-escape (React, Vue, Angular do this)
return <div>{userProvidedText}</div>; // Auto-escaped
```

### **3. Cross-Site Request Forgery (CSRF)**

```typescript
// ❌ Vulnerable: GET with state change
@Get('delete-account')
deleteAccount() { ... }
// Attacker can trick user into clicking link on malicious site

// ✅ Secure: POST with CSRF token
@Post('delete-account')
@UsePipes(new CsrfTokenPipe())
deleteAccount(@Body('csrf_token') csrfToken: string) { ... }
```

### **4. Broken Authentication**

```typescript
// ❌ Vulnerable: Weak password policy
if (password.length < 4) throw new Error();

// ❌ Vulnerable: No rate limiting
while(true) {
  try { login(email, randomPassword); }
  catch { continue; }
}

// ✅ Secure: Strong password + rate limiting
const passwordRequirements = {
  minLength: 12,
  requireUppercase: true,
  requireNumbers: true,
  requireSpecial: true,
};

// Rate limit login attempts
@RateLimit({ windowMs: 15 * 60 * 1000, max: 5 })
@Post('login')
async login(@Body() dto: LoginDto) { ... }
```

### **5. Sensitive Data Exposure**

```typescript
// ❌ Vulnerable: Storing plaintext password
users = {
  id: 1,
  email: 'user@example.com',
  password: 'MyPassword123', // NEVER
};

// ❌ Vulnerable: Sending credit card in response
return {
  order: { ... },
  payment: { creditCard: '4111-1111-1111-1111' }, // NEVER
};

// ✅ Secure: Hash password
const passwordHash = await bcrypt.hash(password, 12);
users = { id: 1, email: 'user@example.com', passwordHash };

// ✅ Secure: Only return masked credit card
return {
  order: { ... },
  payment: { creditCardMasked: '****-****-****-1111' },
};
```

### **6. Insecure Deserialization**

```typescript
// ❌ Vulnerable: Arbitrary object deserialization
const obj = JSON.parse(userInput);
// Attacker could inject objects

// ✅ Secure: Validate schema
const schema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
});
const { error, value } = schema.validate(userInput);
if (error) throw new ValidationError();
```

### **7. Insufficient Logging & Monitoring**

```typescript
// ❌ Vulnerable: No logging
@Post('login')
async login(@Body() dto: LoginDto) {
  const user = await this.usersService.authenticate(dto.email, dto.password);
  return { token: generateToken(user) };
}

// ✅ Secure: Log security events
@Post('login')
async login(@Body() dto: LoginDto, @Req() req: Request) {
  try {
    const user = await this.usersService.authenticate(dto.email, dto.password);
    this.auditService.log({
      event_type: 'AUTH_LOGIN',
      status: 'success',
      actor_id: user.id,
      ip_address: req.ip,
    });
    return { token: generateToken(user) };
  } catch (error) {
    this.auditService.log({
      event_type: 'AUTH_LOGIN',
      status: 'failure',
      reason: error.message,
      ip_address: req.ip,
    });
    throw error;
  }
}
```

---

## Cryptography Basics

### **Hashing vs Encryption**

```
Hashing:
  - One-way function
  - Same input → same output (deterministic)
  - Used for: passwords, checksums, integrity checks
  - Cannot be decrypted
  Example: password → hash (store hash, verify by re-hashing)

Encryption:
  - Two-way function
  - Can be encrypted and decrypted
  - Used for: sensitive data, PII, communication
  - Requires key management
  Example: plaintext → ciphertext (encrypt with key, decrypt with key)
```

### **Password Hashing**

```typescript
import bcrypt from 'bcrypt';

// Hash password on registration
const passwordHash = await bcrypt.hash(password, 12);
// Cost factor 12 = ~100ms on modern CPU

// Verify on login
const isValid = await bcrypt.compare(inputPassword, storedHash);
```

### **Data Encryption**

```typescript
import crypto from 'crypto';

// Encrypt sensitive data
function encrypt(data: string, key: Buffer, iv: Buffer): string {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

// Decrypt when needed
function decrypt(encrypted: string, key: Buffer, iv: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Usage
const key = crypto.randomBytes(32); // 256-bit key
const iv = crypto.randomBytes(16); // Initialization vector
const encrypted = encrypt('sensitive-data', key, iv);
const decrypted = decrypt(encrypted, key, iv);
```

---

## Secure Communication

### **HTTPS/TLS**

```
✓ All communication encrypted
✓ Server identity verified (certificate)
✓ Protection against MITM attacks
✓ Perfect forward secrecy (old sessions can't be decrypted if key is compromised)

Configuration:
  - TLS 1.2+
  - Strong cipher suites (no weak algorithms)
  - HSTS (HTTP Strict Transport Security)
  - Certificate pinning (optional, for mobile apps)
```

### **API Security Headers**

```typescript
// Recommended headers
app.use((req, res, next) => {
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', "default-src 'self'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=()'
  );
  next();
});
```

---

## Security Testing

### **Unit Test: Input Validation**

```typescript
describe('Input Validation', () => {
  it('should reject email with invalid format', async () => {
    const dto = new CreateUserDto();
    dto.email = 'not-an-email';
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('email');
  });

  it('should reject password shorter than 12 chars', async () => {
    const dto = new CreateUserDto();
    dto.password = 'short';
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });
});
```

### **Integration Test: Authorization**

```typescript
describe('Authorization', () => {
  it('should deny access without valid token', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/protected')
      .set('Authorization', 'Bearer invalid-token');

    expect(response.status).toBe(401);
  });

  it('should deny access to unowned resource', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/orders/other-user-order-id')
      .set('Authorization', `Bearer ${userAToken}`);

    expect(response.status).toBe(403);
  });
});
```

### **Security Audit Tools**

```bash
# OWASP Dependency Check (finds known vulnerabilities)
dependency-check --scan ./node_modules

# Snyk (vulnerability scanning)
snyk test

# ESLint security plugin
npm install --save-dev eslint-plugin-security
# .eslintrc: { "plugins": ["security"] }

# SAST (Static Application Security Testing)
# SonarQube, Semgrep, etc.
semgrep --config=p/security-audit .

# Dynamic scanning
# OWASP ZAP, Burp Suite
```

---

## Incident Response

### **Security Incident Response Plan**

```
1. DETECT
   └─ Monitoring alerts, user reports, security scans

2. TRIAGE
   ├─ Severity assessment (critical, high, medium, low)
   └─ Scope determination (which systems/data affected)

3. CONTAIN
   ├─ Isolate affected systems
   ├─ Prevent further damage
   ├─ Preserve logs for investigation

4. INVESTIGATE
   ├─ Root cause analysis
   ├─ Determine attack vector
   ├─ Identify compromised accounts

5. REMEDIATE
   ├─ Patch vulnerabilities
   ├─ Force password resets
   ├─ Revoke compromised tokens

6. COMMUNICATE
   ├─ Notify affected users
   ├─ Notify regulators (if required)
   ├─ Publish post-mortem

7. IMPROVE
   ├─ Prevent similar incidents
   ├─ Update security controls
   ├─ Conduct security training
```

### **Breach Notification Template**

```
Subject: Security Incident Notification - [Date]

Dear [User/Organization],

We are writing to inform you of a security incident that may have affected your account.

What happened:
- [Brief description of incident]
- Date: [When incident occurred]
- Discovered: [When we discovered it]

What information was affected:
- [List of data types: email, username, hashed password, etc.]

What we're doing:
- [Actions taken: forced password reset, revoked tokens, etc.]
- [Investigation: third-party security firm, etc.]

What you should do:
1. Change your password immediately
2. Enable two-factor authentication
3. Monitor for suspicious activity
4. [Other recommended actions]

Support:
- Contact: [Email/phone]
- Information: [URL to incident details]
```

---

## Security Checklist

### **Pre-Launch**

- [ ] All input validated and sanitized
- [ ] All output encoded appropriately
- [ ] Authentication implemented (strong passwords, MFA)
- [ ] Authorization enforced (RBAC, ownership checks)
- [ ] HTTPS/TLS enabled with strong ciphers
- [ ] Secrets stored in vault, not in code
- [ ] Rate limiting implemented
- [ ] Audit logging in place
- [ ] Error messages don't leak sensitive info
- [ ] Security headers set
- [ ] CSRF protection enabled
- [ ] Dependencies scanned for vulnerabilities

### **Post-Launch**

- [ ] Monitoring and alerting in place
- [ ] Regular security audits scheduled
- [ ] Incident response plan documented
- [ ] Backup and recovery tested
- [ ] Penetration testing completed
- [ ] Compliance requirements verified (GDPR, CCPA, etc.)
- [ ] Security training completed by team
- [ ] On-call security response established

---

## Summary

Security is multi-layered:

1. ✓ **Input Validation**: Never trust client input
2. ✓ **Output Encoding**: Encode for context (HTML, URL, JSON, etc.)
3. ✓ **Authentication**: Strong passwords, MFA, session management
4. ✓ **Authorization**: RBAC, ownership checks, permission validation
5. ✓ **Audit Logging**: Log security events, retain for investigation
6. ✓ **Secrets Management**: Use vault, rotate regularly
7. ✓ **Cryptography**: Hash passwords, encrypt sensitive data
8. ✓ **Secure Communication**: HTTPS, security headers
9. ✓ **Testing**: Unit, integration, and security tests
10. ✓ **Monitoring**: Detect breaches early, respond quickly

This completes the Security & Authorization workstream documentation.
