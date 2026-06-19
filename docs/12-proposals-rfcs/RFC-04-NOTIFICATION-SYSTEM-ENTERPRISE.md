# RFC: Enterprise Notification System — Comprehensive Design

> **Status: Draft — Not Yet Implemented**
> This document describes a **proposed future architecture** that extends the current MVP notification system. BullMQ job queues, delivery logging, and real-time SSE are aspirational targets. The current system uses in-process event dispatch via `@nestjs/event-emitter` and client-side polling.

**Status**: Architecture Reference (Proposed)
**Author**: Product & Engineering
**Created**: 2025-09-20
**Scope**: Full-scale multi-channel notification infrastructure for 50+ notification types

---

## Executive Summary

This RFC defines a comprehensive, enterprise-grade notification system supporting:

- **50+ notification types** across 8 domains (bookings, payments, reviews, staff, loyalty, accounts, admin, marketing)
- **Multi-channel delivery** (in-app, web push, email, SMS, mobile push)
- **Feature flag integration** for granular notification gating
- **Tenant-aware preferences** (global defaults + per-tenant overrides)
- **Redis pub/sub** for real-time in-app updates
- **Scalable job queue** (BullMQ) for async dispatch
- **Comprehensive analytics** (delivery rates, engagement metrics)

---

## Notification Taxonomy

### 1. Booking Domain (12 types)

```
booking.created              Customer + Staff notified of new booking
booking.upcoming_24h         Customer + Staff 24-hour reminder
booking.upcoming_1h          Customer + Staff 1-hour reminder
booking.rescheduled          All parties notified of reschedule
booking.cancelled            All parties notified of cancellation
booking.provider_declined    Customer notified when staff unavailable
booking.provider_no_show     Customer notified of staff no-show
booking.customer_no_show     Staff notified of customer no-show
booking.completed            Automatic completion notification
booking.reschedule_window    Prompt to reschedule soon-expiring booking
booking.availability_updated Service provider announces new availability
booking.bulk_operation       Notification of bulk bookings affected
```

### 2. Payment Domain (8 types)

```
payment.received             Customer receipt after successful payment
payment.failed               Customer & staff alerted to payment failure
payment.refunded             Customer notified of refund
payment.retry                Notification of automatic retry (payment failed)
payment.invoice              Invoice issued to customer
payment.reminder             Reminder to pay outstanding balance
payout.sent                  Staff receives payout notification
payout.failed                Staff alerted to payout failure
```

### 3. Review Domain (5 types)

```
review.requested             Customer prompted to leave review
review.posted                Staff notified when reviewed
review.response              Customer notified of staff response
review.alert_low             Business alerted to low-rating review
review.alert_high            Business sees high-rating celebration
```

### 4. Staff Domain (8 types)

```
staff.shift_scheduled        Staff notified of new shift assignment
staff.shift_reminder         Staff 24-hour shift reminder
staff.schedule_changed       Notification of schedule modification
staff.absence_approved       Staff notified of time-off approval
staff.absence_denied         Staff notified of time-off denial
staff.schedule_published     Business publishes finalized schedule
staff.performance_feedback   Staff receives performance review
staff.incentive_earned       Staff notified of bonus/incentive
```

### 5. Loyalty Domain (5 types)

```
loyalty.points_earned        Customer earns loyalty points
loyalty.tier_upgraded        Customer reaches higher tier
loyalty.reward_available      Redemption opportunity
loyalty.reward_expiring       Points about to expire
loyalty.special_offer         Tier-specific promotion
```

### 6. Account Domain (6 types)

```
account.login_new_device     Account security notification
account.password_changed     Password change confirmation
account.email_changed        Email address change confirmation
account.subscription_expiring Subscription renews soon
account.subscription_changed  Subscription tier changed
account.kyc_required          Verification needed (compliance)
```

### 7. Admin Domain (4 types)

```
admin.high_value_booking     Admin alerted to significant transaction
admin.fraud_alert            Suspicious activity detected
admin.balance_threshold      Account balance below threshold
admin.report_ready           Analytics report generated
```

### 8. Marketing Domain (2 types)

```
marketing.campaign           Promotional campaign message
marketing.announcement       Platform announcement
```

---

## Database Schema (Extended)

```sql
-- Notification types with routing rules
CREATE TABLE notification_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  domain VARCHAR(20),  -- "booking", "payment", "review", etc.

  is_critical BOOLEAN DEFAULT false,
  requires_interaction BOOLEAN DEFAULT false,
  groupable BOOLEAN DEFAULT true,  -- Can multiple be grouped?

  default_channels JSON,  -- {"in_app": true, "push": true, "email": false, "sms": false}
  feature_flag_key VARCHAR(100),  -- Gate behind feature flag

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notification template library
CREATE TABLE notification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type_id UUID NOT NULL REFERENCES notification_types(id),
  language VARCHAR(5) DEFAULT 'en',  -- "en", "es", "fr"

  title_template VARCHAR(200),  -- "Booking confirmed for {{serviceName}}"
  body_template TEXT,             -- "Your {{serviceName}} is confirmed for {{date}} at {{time}}."
  push_title_template VARCHAR(80),
  push_body_template VARCHAR(240),
  email_subject_template VARCHAR(100),
  email_body_template TEXT,
  sms_template VARCHAR(160),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(notification_type_id, language)
);

-- Per-tenant notification configuration overrides
CREATE TABLE tenant_notification_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notification_type_id UUID NOT NULL REFERENCES notification_types(id),

  is_enabled BOOLEAN DEFAULT true,
  override_channels JSON,  -- Can override default channels per tenant
  custom_title VARCHAR(200),  -- Customize title for this tenant
  custom_body TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, notification_type_id)
);

-- User engagement analytics
CREATE TABLE notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id),
  user_id UUID NOT NULL REFERENCES users(id),

  event_type VARCHAR(20),  -- "created", "sent", "delivered", "read", "clicked", "dismissed"
  channel VARCHAR(20),     -- "in_app", "push", "email", "sms"
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  metadata JSONB,  -- e.g., {"device": "iPhone", "region": "US"}

  INDEX idx_notification_events (notification_id, event_type)
);

-- Campaign tracking (for marketing notifications)
CREATE TABLE notification_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  notification_type_id UUID REFERENCES notification_types(id),

  target_audience JSONB,  -- {"roles": ["customer"], "tiers": ["premium"], "regions": ["US"]}
  schedule JSON,  -- {"type": "immediate|scheduled|recurring", "startDate": "2025-10-01"}

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  sent_count INT DEFAULT 0,
  open_count INT DEFAULT 0,
  click_count INT DEFAULT 0
);
```

---

## Multi-Channel Delivery Architecture

### In-App (SSE + Redis Pub/Sub)

Real-time browser updates via Server-Sent Events:

```typescript
@Sse('notifications/stream')
async streamNotifications(@Req() req: Request) {
  const userId = req.user.id;

  return Observable.create((observer) => {
    // Subscribe to Redis channel
    const channel = `user:${userId}:notifications`;
    this.redis.subscribe(channel);

    this.redis.on('message', (chan, message) => {
      if (chan === channel) {
        observer.next({ data: JSON.parse(message) });
      }
    });

    return () => this.redis.unsubscribe(channel);
  });
}
```

### Web Push (VAPID Protocol)

Production-ready Web Push via service workers:

```typescript
async sendWebPush(subscription: PushSubscription, notification: Notification) {
  const payload = {
    title: notification.title,
    body: notification.body,
    badge: '/icons/badge-192.png',
    icon: '/icons/icon-192.png',
    tag: notification.notificationTypeId,
    requireInteraction: notification.isCritical,
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return 'sent';
  } catch (error) {
    if (error.statusCode === 410) {
      // Subscription no longer valid
      await this.pushSubscriptionRepository.remove(subscription.endpoint);
    }
    throw error;
  }
}
```

### Email (SendGrid / SES)

Template-based email delivery:

```typescript
async sendEmail(userId: string, notification: Notification) {
  const user = await this.userRepository.findById(userId);
  const template = await this.templateRepository.findForType(
    notification.notificationTypeId,
    'email'
  );

  const subject = this.renderTemplate(template.subjectTemplate, notification.metadata);
  const html = this.renderTemplate(template.bodyTemplate, notification.metadata);

  await this.emailProvider.send({
    to: user.email,
    subject,
    html,
    from: 'noreply@platform.com',
    replyTo: 'support@platform.com',
  });
}
```

### SMS (Twilio / Nexmo)

Short-form SMS for urgent notifications:

```typescript
async sendSms(userId: string, notification: Notification) {
  const user = await this.userRepository.findById(userId);
  const template = await this.templateRepository.findForType(
    notification.notificationTypeId,
    'sms'
  );

  const message = this.renderTemplate(template.smsTemplate, notification.metadata);

  await this.smsProvider.send({
    to: user.phoneNumber,
    body: message,
  });
}
```

### Mobile Push (FCM)

Firebase Cloud Messaging for Android/iOS:

```typescript
async sendMobilePush(userId: string, notification: Notification) {
  const deviceTokens = await this.deviceRepository.findTokensForUser(userId);

  const message = {
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: {
      notificationId: notification.id,
      actionUrl: notification.actionUrl,
    },
    android: {
      priority: notification.isCritical ? 'high' : 'normal',
      ttl: 86400,  // 24 hours
    },
    apns: {
      headers: {
        'apns-priority': notification.isCritical ? '10' : '10',
      },
    },
  };

  for (const token of deviceTokens) {
    await admin.messaging().send({ ...message, token });
  }
}
```

---

## Feature Flag Integration

Gate notifications behind subscription tiers or feature flags:

```typescript
async dispatchNotification(event: NotificationEvent) {
  const notificationType = await this.notificationTypeRepository.findByCode(
    event.notificationTypeCode
  );

  // Check feature flag
  if (notificationType.featureFlagKey) {
    const isEnabled = await this.featureFlagService.isEnabledForUser(
      event.userId,
      notificationType.featureFlagKey
    );

    if (!isEnabled) {
      this.logger.debug(
        `Notification ${event.notificationTypeCode} gated by feature flag`
      );
      return;  // Skip dispatch
    }
  }

  // Proceed with dispatch...
}
```

---

## Tenant-Aware Preferences

Tenants can override notification defaults:

```sql
-- Global: "booking.created" sends in-app + push by default
-- But Tenant A wants: in-app only (no push)

INSERT INTO tenant_notification_config (tenant_id, notification_type_id, override_channels)
VALUES ('tenant-a-uuid', 'booking-created-type-id', '{"in_app": true, "push": false, "email": false, "sms": false}');
```

### Resolution Logic

```typescript
async resolveChannelsForUser(userId: string, notificationTypeId: string) {
  // 1. Get user preferences
  const userPref = await this.preferencesRepository.findByUserAndType(
    userId,
    notificationTypeId
  );

  // 2. Get tenant override (if applicable)
  const tenantOverride = await this.tenantConfigRepository.findByTenantAndType(
    user.tenantId,
    notificationTypeId
  );

  // 3. Get notification type defaults
  const typeDefaults = await this.notificationTypeRepository.findById(
    notificationTypeId
  );

  // Resolution order (most specific wins)
  return {
    inApp: userPref?.inAppEnabled ?? tenantOverride?.channels.inApp ?? typeDefaults.defaultChannels.inApp,
    push: userPref?.pushEnabled ?? tenantOverride?.channels.push ?? typeDefaults.defaultChannels.push,
    email: userPref?.emailEnabled ?? tenantOverride?.channels.email ?? typeDefaults.defaultChannels.email,
    sms: userPref?.smsEnabled ?? tenantOverride?.channels.sms ?? typeDefaults.defaultChannels.sms,
  };
}
```

---

## Analytics & Monitoring

### Key Metrics Dashboard

```
Delivery Rate (per channel)
├── In-app: 99.2% (15,234 / 15,350)
├── Push: 94.8% (8,942 / 9,423)
├── Email: 96.5% (7,234 / 7,492)
└── SMS: 97.1% (3,421 / 3,523)

Engagement Rate (per type)
├── booking.created: 72% open rate, 38% click rate
├── review.posted: 45% open rate, 22% click rate
└── marketing.campaign: 18% open rate, 8% click rate

Queue Health
├── Pending jobs: 1,247
├── Failed jobs (retry): 23
├── Avg processing time: 342ms

Top Notification Types (24h)
├── booking.created: 12,345 sent
├── payment.received: 8,923 sent
└── review.requested: 5,421 sent
```

---

## Alerting & Error Handling

### Critical Alerts

- Delivery rate < 90% for 10 minutes
- Queue depth > 50,000 jobs
- Error rate > 5%
- Email provider quota exceeded
- SMS provider rate limit hit

### Retry Strategy

```
Attempt 1:  Immediate
Attempt 2:  30 seconds
Attempt 3:  5 minutes
Attempt 4:  30 minutes
Attempt 5:  2 hours
Max attempts: 5 (then manual review)
```

---

## Privacy & Compliance

- **GDPR**: Users can request deletion of notification history
- **CAN-SPAM**: Unsubscribe link in all marketing emails
- **TCPA (SMS)**: Opt-in consent required for SMS notifications
- **Data Retention**: Notifications deleted after 90 days (configurable)

---

## Implementation Phases

| Phase   | Timeline | Scope                            |
| ------- | -------- | -------------------------------- |
| Phase 1 | Q3 2025  | In-app + Web push MVP            |
| Phase 2 | Q4 2025  | Email dispatch + Templates       |
| Phase 3 | Q1 2026  | SMS + Mobile push (FCM)          |
| Phase 4 | Q2 2026  | Advanced analytics + A/B testing |
| Phase 5 | Q3 2026  | AI-driven send time optimization |

---

## Conclusion

This enterprise-grade notification system provides:

- **50+ notification types** covering all business domains
- **5-channel delivery** (in-app, push, email, SMS, mobile)
- **Multi-level preferences** (user, tenant, global)
- **Real-time updates** via SSE + Redis
- **Scalable job queue** for async dispatch
- **Comprehensive analytics** for engagement tracking
- **Extensible architecture** for future enhancements

It enables the platform to maintain user engagement, support customer needs, and provide data-driven business operations at scale.
