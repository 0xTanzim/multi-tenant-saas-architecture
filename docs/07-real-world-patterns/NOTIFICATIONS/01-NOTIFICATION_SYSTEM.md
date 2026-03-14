# Case Study: Multi-Tenant Notification System

**Context:** Transactional notification system serving multiple tenants via email, SMS, and push channels

**Complexity:** Tenant context propagation, delivery guarantees, retry logic, audit trails, rate limiting

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Architecture Overview](#architecture-overview)
3. [Tenant Context Propagation](#tenant-context-propagation)
4. [Notification Model](#notification-model)
5. [Delivery Channels](#delivery-channels)
6. [Retry & Deduplication](#retry--deduplication)
7. [Audit & Compliance](#audit--compliance)
8. [Rate Limiting](#rate-limiting)

---

## Problem Statement

A platform sends transactional notifications to users across multiple tenants:

- **Booking confirmation:** "Your appointment is confirmed for 2pm"
- **Staff notification:** "New booking assigned to you"
- **Reminder:** "Your appointment is in 24 hours"
- **Follow-up:** "How was your appointment?"

**Multi-Tenant Constraints:**

- Each tenant's emails must come from their own domain (noreply@mytenant.com)
- Tenant A's notifications must never reach Tenant B's users
- Retry logic must respect tenant timezone (don't send at 3am)
- Each tenant has different notification preferences
- Some tenants have custom notification templates

### Interview Problem

> "Design a notification system for 10k tenants where:
>
> - Each tenant sends from their own domain
> - Notifications respect tenant timezone
> - Failed deliveries retry with backoff
> - We maintain a 6-month audit trail
> - Performance remains constant as volume grows to 1M+ daily messages"

---

## Architecture Overview

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Event Source                              │
│          (Booking System, Payment System, etc.)              │
└──────────────────────┬──────────────────────────────────────┘
                       │ Event with tenant_id
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Notification Service                            │
│        (Validates, enriches, routes by channel)             │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
    Email Queue   SMS Queue   Push Queue
        │              │              │
        ├─────────────┴──────────────┤
        │                            │
        ▼                            ▼
   Email Service (SendGrid)    SMS Service (Twilio)
        │                            │
        └────────┬───────────────────┘
                 │
        ┌────────▼────────┐
        │  Notification   │
        │    Audit Log    │
        └─────────────────┘
```

---

## Tenant Context Propagation

### Principle: Tenant Context in Every Step

```typescript
interface NotificationContext {
  tenantId: string;
  userId: string;
  userEmail: string;
  userPhone?: string;
  userTimezone: string;
  channel: 'email' | 'sms' | 'push';
  eventType: string; // 'booking_confirmed', 'reminder', etc.
  eventData: Record<string, any>;
}

async function sendNotification(context: NotificationContext) {
  // Step 1: Load tenant configuration
  const tenant = await db.query(`SELECT * FROM organizations WHERE id = $1`, [
    context.tenantId,
  ]);

  if (!tenant) throw new Error('Tenant not found');

  // Step 2: Load user preferences (scoped to tenant)
  const preferences = await db.query(
    `SELECT * FROM notification_preferences
     WHERE tenant_id = $1 AND user_id = $2`,
    [context.tenantId, context.userId]
  );

  if (preferences.opt_out_all) {
    console.log(`User ${context.userId} opted out of notifications`);
    return;
  }

  // Step 3: Load notification template (scoped to tenant)
  const template = await db.query(
    `SELECT * FROM notification_templates
     WHERE tenant_id = $1 AND event_type = $2`,
    [context.tenantId, context.eventType]
  );

  // Step 4: Render template with tenant + event data
  const message = renderTemplate(template, {
    tenantName: tenant.name,
    ...context.eventData,
  });

  // Step 5: Queue notification (with tenant context)
  await db.query(
    `INSERT INTO notification_queue
     (tenant_id, user_id, channel, message, scheduled_for)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      context.tenantId,
      context.userId,
      context.channel,
      message,
      context.userTimezone, // Respect timezone
    ]
  );
}
```

### Critical: Tenant Validation at Each Boundary

```typescript
// ✓ CORRECT: Tenant context flows through entire pipeline
async function processNotificationQueue() {
  const batch = await db.query(
    `SELECT * FROM notification_queue
     WHERE status = 'pending'
     AND scheduled_for <= NOW()
     LIMIT 100`
  );

  for (const notification of batch) {
    try {
      // Re-validate tenant before sending
      const tenant = await validateTenant(notification.tenant_id);

      await sendViaChannel(notification.channel, notification.message, {
        tenantId: notification.tenant_id, // ← Explicit tenant context
        senderEmail: tenant.email_from,
        senderName: tenant.display_name,
      });

      // Mark as sent with tenant context
      await db.query(
        `UPDATE notification_queue
         SET status = 'sent', sent_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [notification.id, notification.tenant_id]
      );
    } catch (error) {
      // Failure handling (see Retry & Deduplication section)
      await handleRetry(notification);
    }
  }
}
```

---

## Notification Model

### Database Schema

```sql
-- Notification templates (customizable per tenant)
CREATE TABLE notification_templates (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  event_type VARCHAR NOT NULL,
  channel VARCHAR NOT NULL, -- 'email', 'sms', 'push'

  subject VARCHAR, -- For email only
  body_template TEXT NOT NULL, -- Handlebars template

  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (tenant_id, event_type, channel),
  INDEX (tenant_id)
);

-- User notification preferences
CREATE TABLE notification_preferences (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,

  opt_out_all BOOLEAN DEFAULT false,
  opt_out_email BOOLEAN DEFAULT false,
  opt_out_sms BOOLEAN DEFAULT false,
  opt_out_push BOOLEAN DEFAULT false,

  -- Timezone for scheduling (e.g., "America/New_York")
  timezone VARCHAR DEFAULT 'UTC',

  -- Quiet hours (don't send 10pm-8am)
  quiet_hours_start TIME,
  quiet_hours_end TIME,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (tenant_id, user_id),
  INDEX (tenant_id)
);

-- Notification queue (pending deliveries)
CREATE TABLE notification_queue (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  user_id INTEGER NOT NULL,
  channel VARCHAR NOT NULL,

  message TEXT NOT NULL,
  recipient_email VARCHAR,
  recipient_phone VARCHAR,

  status VARCHAR DEFAULT 'pending', -- pending, sent, failed, bounced
  scheduled_for TIMESTAMP, -- When to send (respects timezone + quiet hours)
  sent_at TIMESTAMP,
  failed_at TIMESTAMP,

  retry_count INTEGER DEFAULT 0,
  next_retry_at TIMESTAMP,

  external_id VARCHAR, -- SendGrid message ID, Twilio SID, etc.

  created_at TIMESTAMP DEFAULT NOW(),

  INDEX (tenant_id, status, scheduled_for),
  INDEX (tenant_id, user_id, created_at)
);

-- Audit trail (immutable delivery log)
CREATE TABLE notification_audit (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  channel VARCHAR NOT NULL,

  message_content TEXT,
  status VARCHAR, -- 'sent', 'failed', 'bounced'
  failure_reason VARCHAR,

  external_id VARCHAR, -- For correlation with email service logs
  external_status VARCHAR, -- SendGrid bounce type, Twilio error code

  sent_at TIMESTAMP DEFAULT NOW(),

  INDEX (tenant_id, sent_at),
  INDEX (tenant_id, user_id, sent_at)
);
```

### Event Trigger Example

```typescript
// When a booking is confirmed, emit a notification event
async function confirmBooking(booking: Booking) {
  // Save booking
  await db.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [
    booking.id,
  ]);

  // Emit notification event (with tenant context)
  await emitNotificationEvent({
    tenantId: booking.tenant_id, // ← CRITICAL: Tenant context
    eventType: 'booking_confirmed',
    userId: booking.customer_id,
    eventData: {
      bookingId: booking.id,
      staffName: booking.staff_name,
      serviceType: booking.service_name,
      appointmentTime: booking.start_time,
      appointmentDate: booking.start_date,
    },
  });
}
```

---

## Delivery Channels

### Email Channel

```typescript
async function sendViaEmail(
  recipient: string,
  subject: string,
  body: string,
  context: { tenantId: string; senderEmail: string; senderName: string }
) {
  const tenant = await db.query(`SELECT * FROM organizations WHERE id = $1`, [
    context.tenantId,
  ]);

  // Use tenant's custom sender email (prevents spoofing)
  const response = await sendGridClient.send({
    to: recipient,
    from: context.senderEmail, // Tenant-specific sender
    subject: subject,
    html: body,

    // Track in SendGrid
    categories: [`tenant_${context.tenantId}`],
    custom_args: {
      tenant_id: context.tenantId,
      message_id: Date.now().toString(),
    },
  });

  return response.id;
}
```

### SMS Channel

```typescript
async function sendViaSMS(
  recipient: string,
  message: string,
  context: { tenantId: string }
) {
  // Respect tenant's SMS configuration
  const tenant = await db.query(
    `SELECT sms_provider_account FROM organizations WHERE id = $1`,
    [context.tenantId]
  );

  const response = await twilioClient.messages.create({
    body: message,
    from: tenant.sms_number, // Tenant-specific phone number
    to: recipient,

    // Metadata for tracking
    clientRef: `${context.tenantId}_${Date.now()}`,
  });

  return response.sid;
}
```

### Push Notification Channel

```typescript
async function sendViaPush(
  userId: string,
  title: string,
  body: string,
  context: { tenantId: string }
) {
  // Get user's device tokens (scoped to tenant)
  const devices = await db.query(
    `SELECT device_token FROM push_subscriptions
     WHERE tenant_id = $1 AND user_id = $2 AND is_active = true`,
    [context.tenantId, userId]
  );

  const tokens = devices.map((d) => d.device_token);

  if (tokens.length === 0) {
    console.log(`No active push devices for user ${userId}`);
    return;
  }

  const response = await firebaseAdmin.messaging().sendMulticast({
    notification: { title, body },
    tokens: tokens,
    data: {
      tenantId: context.tenantId,
      timestamp: Date.now().toString(),
    },
  });

  return response;
}
```

---

## Retry & Deduplication

### Retry Strategy with Exponential Backoff

```typescript
async function handleRetry(notification: Notification) {
  const maxRetries = 5;
  const baseDelayMs = 300000; // 5 minutes

  if (notification.retry_count >= maxRetries) {
    // Final failure
    await db.query(
      `UPDATE notification_queue
       SET status = 'failed', failed_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [notification.id, notification.tenant_id]
    );

    // Alert operator
    await logToAudit({
      tenantId: notification.tenant_id,
      eventType: 'notification_failed_permanent',
      maxRetriesReached: true,
      notificationId: notification.id,
    });

    return;
  }

  // Calculate next retry time with exponential backoff
  const exponentialDelay = baseDelayMs * Math.pow(2, notification.retry_count);
  const nextRetryAt = new Date(Date.now() + exponentialDelay);

  // Respect tenant timezone (don't retry at 3am)
  const tenant = await db.query(
    `SELECT timezone FROM organizations WHERE id = $1`,
    [notification.tenant_id]
  );

  const adjustedRetryTime = adjustForQuietHours(nextRetryAt, tenant.timezone);

  await db.query(
    `UPDATE notification_queue
     SET status = 'pending',
         retry_count = retry_count + 1,
         next_retry_at = $1
     WHERE id = $2 AND tenant_id = $3`,
    [adjustedRetryTime, notification.id, notification.tenant_id]
  );
}
```

### Deduplication

**Problem:** Network timeout might cause duplicate sends.

```typescript
async function sendNotificationIdempotent(
  context: NotificationContext,
  idempotencyKey: string // Unique per logical notification
) {
  // Check if already sent
  const existing = await db.query(
    `SELECT * FROM notification_queue
     WHERE tenant_id = $1
     AND idempotency_key = $2
     AND status = 'sent'`,
    [context.tenantId, idempotencyKey]
  );

  if (existing) {
    console.log(`Notification already sent (${idempotencyKey})`);
    return existing;
  }

  // Save idempotency key
  const notification = await db.query(
    `INSERT INTO notification_queue
     (tenant_id, user_id, channel, idempotency_key)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [context.tenantId, context.userId, context.channel, idempotencyKey]
  );

  // Send
  const result = await sendViaChannel(context);

  // Mark as sent atomically
  await db.query(
    `UPDATE notification_queue
     SET status = 'sent', external_id = $1
     WHERE id = $2 AND tenant_id = $3`,
    [result.externalId, notification.id, context.tenantId]
  );

  return notification;
}
```

---

## Audit & Compliance

### Audit Trail (Immutable Log)

```typescript
async function recordDelivery(
  tenantId: string,
  notification: Notification,
  status: 'sent' | 'failed' | 'bounced',
  details: { externalId?: string; failureReason?: string }
) {
  // Append-only audit log
  await db.query(
    `INSERT INTO notification_audit
     (tenant_id, user_id, channel, status, external_id, external_status, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      tenantId,
      notification.user_id,
      notification.channel,
      status,
      details.externalId,
      details.failureReason,
    ]
  );

  // Retention policy (6 months)
  await db.query(
    `DELETE FROM notification_audit
     WHERE tenant_id = $1
     AND sent_at < NOW() - INTERVAL '6 months'`,
    [tenantId]
  );
}
```

### Compliance Queries

```sql
-- GDPR: Find all notifications sent to a user
SELECT * FROM notification_audit
WHERE tenant_id = $1 AND user_id = $2
ORDER BY sent_at DESC;

-- Audit: How many notifications failed this month?
SELECT
  channel,
  status,
  COUNT(*) as count
FROM notification_audit
WHERE tenant_id = $1
  AND sent_at >= DATE_TRUNC('month', CURRENT_DATE)
GROUP BY channel, status;

-- Bounce rate tracking (for sender reputation)
SELECT
  EXTRACT(DAY FROM sent_at) as day,
  COUNT(*) as total_sent,
  COUNT(CASE WHEN external_status = 'bounce' THEN 1 END) as bounces,
  ROUND(COUNT(CASE WHEN external_status = 'bounce' THEN 1 END)::NUMERIC
    / COUNT(*) * 100, 2) as bounce_rate
FROM notification_audit
WHERE tenant_id = $1
  AND sent_at >= CURRENT_DATE - 30
GROUP BY 1;
```

---

## Rate Limiting

### Per-Tenant Limits

```typescript
async function checkRateLimit(tenantId: string): Promise<boolean> {
  // Get tenant limits
  const tenant = await db.query(
    `SELECT notification_quota_daily FROM organizations WHERE id = $1`,
    [tenantId]
  );

  // Count today's notifications (scoped to tenant)
  const sentToday = await db.query(
    `SELECT COUNT(*) as count FROM notification_queue
     WHERE tenant_id = $1
     AND status = 'sent'
     AND sent_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')`,
    [tenantId]
  );

  if (sentToday[0].count >= tenant.notification_quota_daily) {
    // Rate limit exceeded
    await logRateLimitExceeded(tenantId);
    return false;
  }

  return true;
}
```

### Per-User Opt-Out

```typescript
async function shouldSendNotification(
  tenantId: string,
  userId: string,
  channel: string
): Promise<boolean> {
  const prefs = await db.query(
    `SELECT * FROM notification_preferences
     WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId]
  );

  // Check opt-out
  if (prefs.opt_out_all) return false;
  if (channel === 'email' && prefs.opt_out_email) return false;
  if (channel === 'sms' && prefs.opt_out_sms) return false;

  // Check quiet hours
  const now = new Date();
  const userTime = convertToTz(now, prefs.timezone);

  if (
    isWithinQuietHours(userTime, prefs.quiet_hours_start, prefs.quiet_hours_end)
  ) {
    return false;
  }

  return true;
}
```

---

## Summary

**Multi-Tenant Notification Checklist:**

- [x] Tenant context propagated through every step
- [x] Sender identity per tenant (email/phone)
- [x] Notification preferences scoped to tenant
- [x] Timezone-aware scheduling
- [x] Quiet hours (don't send at 3am)
- [x] Exponential backoff retry logic
- [x] Idempotency keys for deduplication
- [x] Immutable audit trail (6-month retention)
- [x] Per-tenant rate limiting
- [x] Opt-out mechanism

**Interview Points:**

1. "How do you ensure tenant_id flows through the pipeline?" → Every query, every function
2. "What's your retry strategy?" → Exponential backoff, respect timezone, max retries
3. "How do you prevent duplicate sends?" → Idempotency keys + atomic status updates
4. "Compliance & audit?" → Immutable log, retention policy, searchable by tenant/user
5. "Rate limiting?" → Per-tenant quotas + user opt-outs

---

## Related Reading

- See [04-database-design/TENANT_SCOPED_QUERIES.md](../04-database-design/TENANT_SCOPED_QUERIES.md) for query patterns
- See [02-tenant-management/MULTI_TENANT_ACCESS_FLOW.md](../02-tenant-management/MULTI_TENANT_ACCESS_FLOW.md) for context propagation
