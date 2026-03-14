# RFC: Notification System — MVP Phase 1

**Status**: Implemented
**Author**: Product & Engineering
**Created**: 2025-08-10
**Target Release**: Q3 2025 (Web) / Q4 2025 (Mobile)

---

## Purpose

Introduce a scalable, multi-channel notification system for the service booking platform. Phase 1 (MVP) focuses on **in-app notification feed** and **web push notifications**, with architecture designed for future expansion to email and SMS.

---

## Problem

Currently, users have no real-time visibility into important events:

- Booking confirmations / reminders / cancellations
- Service provider availability updates
- Price changes or new service offerings
- Payment status and receipts
- Reviews and ratings
- Support messages

Users resort to refreshing pages or checking email, leading to missed communications and poor engagement.

---

## Solution Overview

**Phase 1 Scope:**

- In-app notification feed (database-backed)
- Web push notifications (service worker + VAPID)
- Notification preferences (per-user, per-type)
- Backend dispatch service (event-driven)
- Frontend UI (Bell icon + dropdown + page)

**Future Phases (Design Only):**

- Email notifications (SendGrid)
- SMS notifications (Twilio)
- Mobile push (FCM for Android)
- Desktop native notifications

---

## Database Schema

```sql
-- Notification types (immutable registry)
CREATE TABLE notification_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,  -- e.g., "booking.created", "payment.failed"
  display_name VARCHAR(200) NOT NULL,
  description TEXT,
  icon_name VARCHAR(50),  -- e.g., "calendar", "alert-circle"
  is_critical BOOLEAN DEFAULT false,  -- High priority notifications
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notification preferences (per user, per type)
CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type_id UUID NOT NULL REFERENCES notification_types(id),
  push_enabled BOOLEAN DEFAULT true,
  email_enabled BOOLEAN DEFAULT true,
  in_app_enabled BOOLEAN DEFAULT true,
  mute_until TIMESTAMP,  -- Snooze preference
  tenant_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, notification_type_id)
);

-- Notification feed (transactional log)
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type_id UUID NOT NULL REFERENCES notification_types(id),
  tenant_id UUID NOT NULL,

  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  action_url VARCHAR(500),  -- Deep link (e.g., "/my/bookings/123")
  metadata JSONB,  -- Extra data (booking_id, service_name, etc.)

  is_read BOOLEAN DEFAULT false,
  is_dismissed BOOLEAN DEFAULT false,
  read_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Indexes for common queries
  INDEX idx_notifications_user_created (user_id, created_at DESC),
  INDEX idx_notifications_unread (user_id, is_read, created_at DESC),
  INDEX idx_notifications_tenant (tenant_id, created_at DESC)
);

-- Web push subscriptions
CREATE TABLE web_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint VARCHAR(500) NOT NULL,  -- Push service endpoint
  auth_key VARCHAR(200) NOT NULL,   -- Encryption key
  p256dh_key VARCHAR(200) NOT NULL, -- Diffie-Hellman key
  user_agent VARCHAR(500),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  UNIQUE(user_id, endpoint)  -- Prevent duplicates
);

-- Notification dispatch log (for troubleshooting)
CREATE TABLE notification_dispatch_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id),
  channel VARCHAR(20),  -- "in_app", "push", "email", "sms"
  status VARCHAR(20),   -- "queued", "sent", "failed"
  error_message TEXT,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Backend Architecture

### NotificationDispatchService

Central service responsible for routing notifications to appropriate channels:

```typescript
@Injectable()
export class NotificationDispatchService {
  constructor(
    private notificationRepository: NotificationRepository,
    private preferencesRepository: PreferencesRepository,
    private pushService: WebPushService,
    private jobQueue: BullQueue
  ) {}

  async dispatchNotification(event: NotificationEvent): Promise<void> {
    // 1. Create notification record
    const notification = await this.notificationRepository.create({
      userId: event.userId,
      tenantId: event.tenantId,
      notificationTypeId: event.notificationTypeId,
      title: event.title,
      body: event.body,
      actionUrl: event.actionUrl,
      metadata: event.metadata,
    });

    // 2. Check user preferences
    const prefs = await this.preferencesRepository.findByUserAndType(
      event.userId,
      event.notificationTypeId
    );

    // 3. Queue appropriate channels
    if (prefs.in_app_enabled) {
      // In-app is instant (database insert already done)
      this.logger.log(`In-app notification created: ${notification.id}`);
    }

    if (prefs.push_enabled) {
      // Queue web push for async dispatch
      await this.jobQueue.add('send-push', {
        notificationId: notification.id,
        userId: event.userId,
      });
    }

    if (prefs.email_enabled && event.notificationTypeId.isCritical) {
      // Queue email for critical notifications only
      await this.jobQueue.add('send-email', {
        notificationId: notification.id,
        userId: event.userId,
      });
    }

    return notification;
  }
}
```

### Event Emitters

Throughout the platform, domain events trigger notifications:

```typescript
// booking.service.ts
async createBooking(createDto: CreateBookingDto): Promise<Booking> {
  const booking = await this.bookingRepository.create(createDto);

  // Emit event → triggers notification dispatch
  this.eventEmitter.emit('booking.created', {
    bookingId: booking.id,
    customerId: booking.customerId,
    providerId: booking.providerId,
    tenantId: booking.tenantId,
    serviceNames: booking.services.map(s => s.name),
    bookingDate: booking.bookingDate,
  });

  return booking;
}
```

### Job Queue: BullMQ

Async notification dispatch via Redis-backed job queue:

```typescript
// notification.queue.ts
@Processor('notifications')
export class NotificationQueue {
  constructor(
    private pushService: WebPushService,
    private emailService: EmailService,
    private notificationRepository: NotificationRepository
  ) {}

  @Process('send-push')
  async sendPush(job: Job) {
    const { notificationId, userId } = job.data;

    try {
      const notification = await this.notificationRepository.findById(
        notificationId
      );
      const subscriptions = await this.pushService.getSubscriptionsForUser(
        userId
      );

      for (const sub of subscriptions) {
        await this.pushService.send(sub, notification);
      }

      await this.notificationRepository.markPushSent(notificationId);
    } catch (error) {
      this.logger.error(`Push dispatch failed: ${error.message}`);
      throw error; // Retry
    }
  }
}
```

### Web Push Service

Handles VAPID protocol and service worker communication:

```typescript
@Injectable()
export class WebPushService {
  private vapidPublicKey: string;
  private vapidPrivateKey: string;

  async send(
    subscription: PushSubscription,
    notification: Notification
  ): Promise<void> {
    const payload = {
      title: notification.title,
      body: notification.body,
      icon: '/notification-icon-192x192.png',
      badge: '/badge-72x72.png',
      tag: notification.notificationTypeId, // Grouping
      requireInteraction: notification.isCritical, // Stay on screen
      actions: [
        {
          action: 'open',
          title: 'Open',
        },
        {
          action: 'close',
          title: 'Dismiss',
        },
      ],
    };

    await webpush.sendNotification(subscription, JSON.stringify(payload));
  }
}
```

---

## Frontend Architecture

### 1. Service Worker Registration

```typescript
// app.tsx
useEffect(() => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((reg) => console.log('SW registered'))
      .catch((err) => console.error('SW registration failed', err));
  }
}, []);
```

### 2. Service Worker: Push Event Handling

```javascript
// service-worker.js
self.addEventListener('push', (event) => {
  const data = event.data.json();

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: data.tag,
      data: { actionUrl: data.actionUrl },
      actions: data.actions,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const actionUrl = event.notification.data.actionUrl;
  if (actionUrl) {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then((clientList) => {
        // Focus existing window or open new tab
        return clientList.length > 0
          ? clientList[0].navigate(actionUrl)
          : clients.openWindow(actionUrl);
      })
    );
  }
});
```

### 3. In-App Notification Feed

```tsx
// NotificationFeed.tsx
function NotificationFeed() {
  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get('/notifications?limit=50'),
    staleTime: 30_000, // 30 seconds
    refetchInterval: 60_000, // Poll every 1 min
  });

  const { mutate: markAsRead } = useMutation({
    mutationFn: (notificationId: string) =>
      api.patch(`/notifications/${notificationId}/read`),
    onSuccess: () => queryClient.invalidateQueries(['notifications']),
  });

  return (
    <div className="notification-feed">
      {notifications.map((n) => (
        <NotificationCard
          key={n.id}
          notification={n}
          onRead={() => markAsRead(n.id)}
        />
      ))}
    </div>
  );
}
```

### 4. Web Push Request Prompt

Shown after user's first booking:

```tsx
function NotificationPrompt() {
  const [isOpen, setIsOpen] = useState(false);

  const handleRequestPermission = async () => {
    const permission = await Notification.requestPermission();

    if (permission === 'granted') {
      const subscription = await navigator.serviceWorker.ready.then((reg) =>
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(
            process.env.REACT_APP_VAPID_KEY
          ),
        })
      );

      await api.post('/push-subscriptions', { subscription });
      setIsOpen(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTitle>Stay Updated</DialogTitle>
      <DialogDescription>
        Receive notifications about your bookings, reviews, and messages.
      </DialogDescription>
      <Button onClick={handleRequestPermission}>Enable Notifications</Button>
    </Dialog>
  );
}
```

---

## API Endpoints

### Get Notifications

```
GET /notifications?limit=50&cursor=uuid&unread_only=false
```

Response:

```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Booking Confirmed",
      "body": "Your appointment on June 15 at 2:00 PM is confirmed.",
      "actionUrl": "/my/bookings/booking-123",
      "isRead": false,
      "createdAt": "2025-06-14T10:30:00Z"
    }
  ],
  "nextCursor": "uuid",
  "unreadCount": 3
}
```

### Mark as Read

```
PATCH /notifications/:id/read
```

### Update Preferences

```
PATCH /notification-preferences/:typeId
Body: { push_enabled: true, email_enabled: false }
```

---

## Notification Types (Initial Taxonomy)

```
booking.created          — Booking confirmed
booking.reminder         — Reminder (24h, 1h before)
booking.rescheduled      — Booking changed
booking.cancelled        — Booking cancelled
booking.review_requested — Review request
review.posted            — Review received
payment.received         — Payment confirmed
payment.failed           — Payment failed
account.login            — New login detected
message.received         — New message
promotion.available      — Special offer
service.updated          — Service changed
```

---

## Monitoring & Observability

### Key Metrics

1. **Delivery Rate**: Push notifications successfully sent / queued
2. **Read Rate**: Notifications opened by users / total delivered
3. **Action Rate**: Users clicking notification action / total read
4. **Error Rate**: Failed push sends / total attempted
5. **Queue Depth**: Pending notifications in BullMQ

### Alerting

- Alert if delivery rate < 95% for 10 minutes
- Alert if queue depth > 10,000
- Alert if error rate > 5%

---

## Testing Strategy

### Unit Tests

- Preference logic (which channels are enabled?)
- Notification creation and DTO mapping
- Event emission and queue job creation

### Integration Tests

- Full flow: Event → Notification created → Push queued → Marked sent
- Preference override (critical notifications always push)
- Duplicate prevention (same notification not sent twice)

### E2E Tests

- User enables push → notification sent → user sees it
- User clicks notification → navigates to correct page
- User dismisses notification → marked as dismissed

---

## Rollout Plan

1. **Week 1-2**: Deploy backend service (queue, preferences, API)
2. **Week 3**: Deploy frontend (service worker, bell icon, feed UI)
3. **Week 4**: Internal testing and monitoring
4. **Week 5**: Beta rollout (10% of users)
5. **Week 6**: Full production rollout

---

## Summary

Phase 1 delivers:

- **In-app notification feed** for immediate visibility
- **Web push notifications** for timely alerts
- **Preference system** for user control
- **Event-driven dispatch** for scalability
- **Architecture extensible** for email/SMS in future phases

This foundation enables future expansions (email, SMS, mobile push) without architectural changes.
