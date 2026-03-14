# FAQ: Feature Flags & Permission-Based Feature Gating

**Last Updated**: 2025-10-10
**Status**: Active

---

## What are Feature Flags?

Feature flags are runtime toggles that control feature visibility and behavior without requiring code deployment.

**The Keycard Analogy:**

Think of your phone as a hotel. Each person has a keycard:

- **Platinum Member**: Keycard opens Room 1 (Luxury Suite), Room 2 (Gym), Room 3 (Restaurant)
- **Silver Member**: Keycard opens Room 2 (Gym) and Room 3 (Restaurant) only
- **Bronze Member**: Keycard opens Room 3 (Restaurant) only

Your keycard (subscription tier) determines which doors (features) open. The hotel doesn't remove doors for Bronze members — they just stay locked until you upgrade.

**In the platform:**

- Feature flag = "Is this keycard holder allowed in this room?"
- Subscription tier = "What keycard does this user have?"
- Feature gate = "Check the keycard before opening the door"

---

## Feature Flag Types

### 1. Release Flags (Deployment Control)

Gate a feature during rollout without deploying code.

```typescript
// Before launch: flag is OFF
if (isFeatureEnabled('new_booking_calendar')) {
  return <NewCalendarComponent />;
} else {
  return <LegacyCalendarComponent />;
}

// Week 1: Enable for internal staff
// Week 2: Enable for 10% of users
// Week 3: Enable for 50% of users
// Week 4: Enable for 100%, then remove flag
```

**Use case:** Gradual rollout to catch bugs early before all users are affected.

### 2. Operations Flags (Real-Time Control)

Enable/disable functionality without deployment.

```typescript
// If payment service is down, disable payments
if (isFeatureEnabled('payments.enabled')) {
  return <PaymentCheckout />;
} else {
  return <PaymentDownNotice />;
}

// At 3 AM: Incident detected
// → Toggle flag OFF → Users see "maintenance mode"
// → Issue fixed → Toggle flag ON → Users resume checkout
// No deploy needed
```

**Use case:** Emergency killswitches for broken services.

### 3. Permission Flags (Feature Entitlement)

Gate features by subscription tier or user role.

```typescript
// "booking_capacity_management" is only for Professional+ tiers
if (isFeatureEnabled('booking_capacity_management', user)) {
  return <CapacityManagementDashboard />;
} else {
  return <UpgradePrompt tier="Professional" />;
}
```

---

## Permission Flag Architecture

### Service Layer

```typescript
@Injectable()
export class FeatureFlagService {
  constructor(
    private db: Database,
    private redis: Redis // Cache layer
  ) {}

  async isEnabledForUser(userId: string, flagKey: string): Promise<boolean> {
    // 1. Check cache (10-minute TTL)
    const cached = await this.redis.get(`feature:${userId}:${flagKey}`);
    if (cached !== undefined) return cached === 'true';

    // 2. Load user subscription tier
    const user = await this.db.query('SELECT tier FROM users WHERE id = $1', [
      userId,
    ]);

    // 3. Check if flag is enabled for this tier
    const isEnabled = await this.db.query(
      `SELECT enabled FROM feature_flag_tiers
       WHERE flag_key = $1 AND tier = $2`,
      [flagKey, user.tier]
    );

    // 4. Cache result
    await this.redis.setex(
      `feature:${userId}:${flagKey}`,
      600, // 10 minutes
      isEnabled ? 'true' : 'false'
    );

    return isEnabled;
  }

  // Invalidate cache when tier changes
  async invalidateUserCache(userId: string): Promise<void> {
    const pattern = `feature:${userId}:*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
```

### Frontend Component

```tsx
import { useFeatureFlag } from '@/hooks/useFeatureFlag';

export function DashboardPage() {
  const { isEnabled: hasCapacityManagement } = useFeatureFlag(
    'booking_capacity_management'
  );
  const { isEnabled: hasAnalytics } = useFeatureFlag('advanced_analytics');

  return (
    <Dashboard>
      {hasCapacityManagement && <CapacitySection />}
      {hasAnalytics && <AnalyticsSection />}
      <StandardBookingSection />
    </Dashboard>
  );
}
```

### Hook Implementation

```typescript
export function useFeatureFlag(flagKey: string) {
  const { user } = useAuth();
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    api
      .get(`/feature-flags/${flagKey}`)
      .then((res) => setIsEnabled(res.enabled))
      .catch((err) => setIsEnabled(false))
      .finally(() => setIsLoading(false));
  }, [user, flagKey]);

  return { isEnabled, isLoading };
}
```

---

## Subscription Tier Feature Matrix

| Feature             | Free | Starter | Professional | Enterprise |
| ------------------- | ---- | ------- | ------------ | ---------- |
| Basic booking       | ✅   | ✅      | ✅           | ✅         |
| SMS notifications   | ❌   | ✅      | ✅           | ✅         |
| Advanced reports    | ❌   | ❌      | ✅           | ✅         |
| Capacity management | ❌   | ❌      | ✅           | ✅         |
| Custom branding     | ❌   | ❌      | ❌           | ✅         |
| API access          | ❌   | ❌      | ✅           | ✅         |
| Dedicated support   | ❌   | ❌      | ❌           | ✅         |

---

## Caching Strategy

Feature flags are checked on every page load. Caching is critical for performance.

### Cache Layers

1. **Browser** (1 min)

   - Reduces API calls during same session
   - `localStorage` stores feature state
   - Clear on logout

2. **CDN Edge** (5 min)

   - Reduces backend load
   - Geographic distribution

3. **Redis** (10 min)

   - Backend cache for user feature checks
   - Quick lookups without DB query

4. **Database** (source of truth)
   - Authoritative feature flag rules
   - Updated when tier changes

### Cache Invalidation

When user tier changes:

```typescript
// User upgrades from Free → Professional
await this.userService.upgradeTier(userId, 'professional');

// 1. Invalidate Redis cache
await this.featureFlagService.invalidateUserCache(userId);

// 2. Notify frontend via WebSocket
this.websocket.emit('userTierChanged', {
  userId,
  newTier: 'professional',
  enabledFlags: ['booking_capacity_management', 'advanced_reports'],
});

// 3. Frontend clears localStorage and refetches flags
```

---

## Best Practices

### ✅ DO

- **Use meaningful flag names**: `booking_capacity_management` vs `feature_123`
- **Document the intent**: Why does this feature exist? When to remove it?
- **Set a removal date**: "Remove this flag after Q4 2025"
- **Test both code paths**: Test with flag ON and OFF
- **Monitor flag usage**: Track which flags are actually used

### ❌ DON'T

- **Hardcode feature logic**: Never `if (tier === 'professional') { ... }` in components
- **Leave flags forever**: Clean up old flags (cruft)
- **Gate critical UX**: Don't hide core flows behind feature flags
- **Use flags for A/B testing**: Use proper experimentation platform instead
- **Cache indefinitely**: Always set TTL on cached flags

---

## Database Schema

```sql
CREATE TABLE feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(200),
  description TEXT,

  flag_type VARCHAR(20),  -- "release", "operations", "permission"
  is_active BOOLEAN DEFAULT true,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES users(id),

  removal_target_date DATE,  -- "Schedule for cleanup"
  INDEX idx_feature_flags_active (is_active)
);

CREATE TABLE feature_flag_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id UUID NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,

  tier VARCHAR(50),  -- "free", "starter", "professional", "enterprise"
  is_enabled BOOLEAN DEFAULT false,

  UNIQUE(flag_id, tier)
);

-- Release flags can enable for percentage of users (canary rollout)
CREATE TABLE feature_flag_rollout (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id UUID NOT NULL REFERENCES feature_flags(id),

  rollout_percentage INT DEFAULT 0,  -- 0-100
  enabled_user_ids UUID[] DEFAULT ARRAY[]::UUID[],  -- Explicit users

  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## API Endpoints (Admin)

### Get Feature Flags

```
GET /admin/feature-flags
```

```json
{
  "data": [
    {
      "id": "flag-123",
      "key": "booking_capacity_management",
      "displayName": "Booking Capacity Management",
      "isActive": true,
      "type": "permission",
      "tiers": {
        "free": false,
        "starter": false,
        "professional": true,
        "enterprise": true
      }
    }
  ]
}
```

### Create/Update Flag

```
POST /admin/feature-flags
PATCH /admin/feature-flags/:id
```

### Toggle Release Rollout

```
PATCH /admin/feature-flags/:id/rollout
Body: { rolloutPercentage: 50 }
```

---

## Common Questions

**Q: How do I know if my tier has access to a feature?**

A: Use the `useFeatureFlag` hook in React, or call `GET /feature-flags/:key` in your API.

**Q: What if the feature flag service is down?**

A: Fails open (features enabled) or fails closed (features disabled) depending on configuration. Configure your app to be resilient.

**Q: Can I test a feature before upgrading?**

A: Contact support and ask for a trial period. The system can add your account to an explicit override list.

**Q: How long does it take for a tier change to take effect?**

A: Usually 1-2 minutes. Cache TTL is 10 minutes, so worst case ~10 minutes. Refresh browser if needed.

---

## Summary

Feature flags provide:

- **Subscription tier enforcement** (permission flags)
- **Safe rollouts** (release flags, gradual enablement)
- **Emergency response** (operations flags, instant disable)
- **Cache optimization** (multi-layer caching with smart invalidation)
- **Platform control** (real-time behavior changes without deploy)

Think of it as the "keycard system" of the platform: users have keycards (tiers), and doors (features) are controlled by checking their tier before opening.
