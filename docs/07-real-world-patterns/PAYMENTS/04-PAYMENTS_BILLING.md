# Case Study: Multi-Tenant Payments & Billing

**Context:** SaaS payment processing where a platform collects payments and settles with individual tenants

**Complexity:** Per-tenant billing, payment isolation, settlement accounting, PCI compliance, subscription lifecycle

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Billing Model](#billing-model)
3. [Data Model](#data-model)
4. [Payment Processing](#payment-processing)
5. [Subscription Lifecycle](#subscription-lifecycle)
6. [Settlement & Reporting](#settlement--reporting)
7. [Refunds & Disputes](#refunds--disputes)
8. [Security & Compliance](#security--compliance)

---

## Problem Statement

A multi-tenant SaaS platform collects payments in two scenarios:

1. **B2B (Platform → Tenant):** Platform charges tenants for subscription (monthly SaaS fee)
2. **B2C (Customer → Platform):** Platform collects customer payments for services, settles with tenant

**Multi-Tenant Constraints:**

- Each tenant has independent billing cycle, payment method, subscription status
- Platform must track which payments belong to which tenant
- Refunds must be isolated per tenant
- Failed payments don't affect other tenants
- Each tenant sees only their own invoices and transactions
- PCI compliance requires payment data segregation

### Interview Problem

> "Design a payment system for 10k SaaS tenants where:
>
> - Platform collects customer payments for services
> - Platform also bills tenants monthly for platform fees
> - Failed payment from Tenant A doesn't affect Tenant B
> - Each tenant can see their own invoices/transactions only
> - Settlement accounting is accurate to the cent
> - Complies with PCI DSS (never store raw card data)"

---

## Billing Model

### Two-Tier Payment Structure

```
┌─────────────────────────────────────────────────────┐
│            TIER 1: Platform Billing                  │
│        (Monthly SaaS subscription per tenant)        │
├─────────────────────────────────────────────────────┤
│  Tenant charges Platform                             │
│    → $99/month (basic plan)                          │
│    → $299/month (professional plan)                  │
│    → $999/month (enterprise plan)                    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│        TIER 2: Customer Transaction Fees             │
│    (Per-transaction platform fee on customer payments)│
├─────────────────────────────────────────────────────┤
│  Customer pays Tenant for service                    │
│    → Customer sends $100 to platform                 │
│    → Platform takes 2.9% fee ($2.90)                 │
│    → Tenant receives $97.10                          │
│    → Transaction recorded in Tenant's statement      │
└─────────────────────────────────────────────────────┘
```

### Subscription Tiers

| Tier         | Price   | Features                               | Cancellation                       |
| ------------ | ------- | -------------------------------------- | ---------------------------------- |
| Free         | $0      | Unlimited bookings, basic features     | Anytime                            |
| Professional | $99/mo  | Advanced analytics, priority support   | 14-day trial, then charged monthly |
| Enterprise   | $999/mo | Custom integrations, dedicated support | Annual commitment, pro-rata refund |

---

## Data Model

### Subscription & Billing Tables

```sql
-- Subscription plans
CREATE TABLE subscription_plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR NOT NULL, -- 'Free', 'Professional', 'Enterprise'
  price_cents BIGINT NOT NULL,
  billing_interval VARCHAR, -- 'monthly', 'annual'
  feature_limits JSONB, -- {max_staff: 10, max_bookings: 1000}
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tenant subscription state
CREATE TABLE tenant_subscriptions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id),
  plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),

  status VARCHAR DEFAULT 'trial', -- 'trial', 'active', 'past_due', 'suspended', 'cancelled'

  -- Billing cycle
  billing_start_date DATE NOT NULL,
  next_billing_date DATE NOT NULL,
  cancellation_date DATE, -- When cancelled (if applicable)

  -- Payment method
  stripe_customer_id VARCHAR NOT NULL, -- Stripe customer ID
  stripe_payment_method_id VARCHAR, -- Stripe payment method ID

  -- Trial
  trial_end_date DATE,
  trial_converted BOOLEAN DEFAULT false,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  INDEX (tenant_id),
  INDEX (status),
  INDEX (next_billing_date) -- For batch billing
);

-- Invoice (issued to tenant)
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  subscription_id INTEGER REFERENCES tenant_subscriptions(id),

  invoice_number VARCHAR UNIQUE NOT NULL, -- "INV-2025-001-123"

  -- Amounts
  subtotal_cents BIGINT NOT NULL,
  tax_cents BIGINT DEFAULT 0,
  total_cents BIGINT NOT NULL,

  -- Status
  status VARCHAR DEFAULT 'draft', -- 'draft', 'issued', 'paid', 'overdue', 'cancelled'
  issued_date DATE NOT NULL,
  due_date DATE NOT NULL,
  paid_date DATE,

  -- PDF storage
  pdf_url VARCHAR,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (tenant_id, invoice_number),
  INDEX (tenant_id, issued_date DESC),
  INDEX (status, due_date) -- For "past due" queries
);

-- Payment transactions (customer payments processed by platform)
CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),

  amount_cents BIGINT NOT NULL,
  platform_fee_cents BIGINT, -- 2.9% of amount

  status VARCHAR DEFAULT 'pending', -- 'pending', 'completed', 'failed', 'refunded'

  -- Stripe
  stripe_charge_id VARCHAR,
  stripe_payment_intent_id VARCHAR,

  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  failed_at TIMESTAMP,
  refunded_at TIMESTAMP,

  INDEX (tenant_id, created_at DESC),
  INDEX (tenant_id, status),
  INDEX (stripe_charge_id) -- For webhook lookups
);

-- Refunds
CREATE TABLE refunds (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),

  amount_cents BIGINT NOT NULL,
  reason VARCHAR NOT NULL, -- 'customer_request', 'merchant_error', 'duplicate'

  status VARCHAR DEFAULT 'pending', -- 'pending', 'completed', 'failed'

  stripe_refund_id VARCHAR,

  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,

  INDEX (tenant_id, created_at DESC),
  INDEX (status)
);

-- Settlement records (for accounting)
CREATE TABLE settlements (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),

  settlement_date DATE NOT NULL,

  -- Amounts
  total_collected_cents BIGINT,
  platform_fees_cents BIGINT,
  net_to_tenant_cents BIGINT,

  -- Status
  status VARCHAR DEFAULT 'calculated', -- 'calculated', 'paid', 'failed'
  payment_date DATE,
  bank_account_last4 VARCHAR,

  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (tenant_id, settlement_date),
  INDEX (status, payment_date)
);
```

---

## Payment Processing

### Subscription Billing (Tier 1)

```typescript
// Run nightly to bill due subscriptions
async function processBillingCycle() {
  const dueBillings = await db.query(`
    SELECT ts.* FROM tenant_subscriptions ts
    JOIN subscription_plans sp ON ts.plan_id = sp.id
    WHERE ts.status IN ('active', 'past_due')
      AND ts.next_billing_date <= CURRENT_DATE
  `);

  for (const billing of dueBillings) {
    await processSubscriptionPayment(billing);
  }
}

async function processSubscriptionPayment(subscription: TenantSubscription) {
  try {
    // Load tenant
    const tenant = await db.query(`SELECT * FROM organizations WHERE id = $1`, [
      subscription.tenant_id,
    ]);

    // Load plan
    const plan = await db.query(
      `SELECT * FROM subscription_plans WHERE id = $1`,
      [subscription.plan_id]
    );

    // Create Stripe invoice
    const stripeInvoice = await stripe.invoices.create({
      customer: subscription.stripe_customer_id,
      collection_method: 'charge_automatically', // Auto-charge
      auto_advance: true, // Finalize and send to customer

      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: plan.name,
              metadata: { tenant_id: subscription.tenant_id },
            },
            unit_amount: plan.price_cents,
          },
          quantity: 1,
        },
      ],

      metadata: {
        tenant_id: subscription.tenant_id,
        subscription_id: subscription.id,
      },
    });

    // Create local invoice record
    const invoice = await db.query(
      `
      INSERT INTO invoices
      (tenant_id, subscription_id, invoice_number, subtotal_cents, total_cents,
       issued_date, due_date, status)
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
      [
        subscription.tenant_id,
        subscription.id,
        `INV-${new Date().getFullYear()}-${tenant.id}`,
        plan.price_cents,
        plan.price_cents,
        new Date(),
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        'issued',
      ]
    );

    // Update next billing date
    await db.query(
      `
      UPDATE tenant_subscriptions
      SET next_billing_date = $1, updated_at = NOW()
      WHERE id = $2
    `,
      [new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), subscription.id]
    );
  } catch (error) {
    // Payment failed
    await db.query(
      `
      UPDATE tenant_subscriptions
      SET status = 'past_due', updated_at = NOW()
      WHERE id = $1
    `,
      [subscription.id]
    );

    // Notify tenant
    await sendNotification({
      tenantId: subscription.tenant_id,
      eventType: 'payment_failed',
      eventData: { error: error.message },
    });
  }
}
```

### Customer Payment Processing (Tier 2)

```typescript
async function processCustomerPayment(
  tenantId: string,
  customerId: string,
  amountCents: number
): Promise<{ chargeId: string; platformFee: number }> {
  // Load tenant
  const tenant = await db.query(
    `SELECT stripe_account_id FROM organizations WHERE id = $1`,
    [tenantId]
  );

  // Calculate platform fee (2.9% + $0.30)
  const platformFeeCents = Math.round(amountCents * 0.029 + 30);
  const tenantReceivesCents = amountCents - platformFeeCents;

  try {
    // Create charge in Stripe
    const charge = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',

        // Application fee (platform's cut)
        application_fee_amount: platformFeeCents,

        // Destination (Stripe Connect)
        transfer_data: {
          destination: tenant.stripe_account_id,
          amount: tenantReceivesCents,
        },

        metadata: {
          tenant_id: tenantId,
          customer_id: customerId,
        },
      },
      {
        stripeAccount: tenant.stripe_account_id, // Route via Stripe Connect
      }
    );

    // Record transaction
    await db.query(
      `
      INSERT INTO transactions
      (tenant_id, customer_id, amount_cents, platform_fee_cents, status, stripe_payment_intent_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
      [
        tenantId,
        customerId,
        amountCents,
        platformFeeCents,
        'pending',
        charge.id,
      ]
    );

    return { chargeId: charge.id, platformFee: platformFeeCents };
  } catch (error) {
    // Log failure
    await db.query(
      `
      INSERT INTO transactions
      (tenant_id, customer_id, amount_cents, platform_fee_cents, status)
      VALUES ($1, $2, $3, $4, $5)
    `,
      [tenantId, customerId, amountCents, 0, 'failed']
    );

    throw error;
  }
}
```

---

## Subscription Lifecycle

### Trial → Active → Cancellation

```typescript
// Tenant starts trial
async function startTrial(tenantId: string, planId: string) {
  const trialEndDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

  const subscription = await db.query(
    `
    INSERT INTO tenant_subscriptions
    (tenant_id, plan_id, status, trial_end_date, billing_start_date, next_billing_date)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `,
    [tenantId, planId, 'trial', trialEndDate, new Date(), trialEndDate]
  );

  return subscription;
}

// Trial ends → automatic conversion to paid
async function convertTrialToPaid(subscriptionId: string) {
  const subscription = await db.query(
    `SELECT * FROM tenant_subscriptions WHERE id = $1`,
    [subscriptionId]
  );

  if (subscription.status !== 'trial') {
    throw new Error('Subscription not in trial');
  }

  // Attempt first payment
  try {
    await processSubscriptionPayment(subscription);

    await db.query(
      `
      UPDATE tenant_subscriptions
      SET status = 'active', trial_converted = true, updated_at = NOW()
      WHERE id = $1
    `,
      [subscriptionId]
    );
  } catch (error) {
    // Trial conversion failed → suspend
    await db.query(
      `
      UPDATE tenant_subscriptions
      SET status = 'suspended', updated_at = NOW()
      WHERE id = $1
    `,
      [subscriptionId]
    );
  }
}

// Tenant cancels subscription
async function cancelSubscription(tenantId: string) {
  const subscription = await db.query(
    `SELECT * FROM tenant_subscriptions WHERE tenant_id = $1`,
    [tenantId]
  );

  if (subscription.status === 'cancelled') {
    throw new Error('Already cancelled');
  }

  await db.query(
    `
    UPDATE tenant_subscriptions
    SET status = 'cancelled', cancellation_date = CURRENT_DATE, updated_at = NOW()
    WHERE tenant_id = $1
  `,
    [tenantId]
  );

  // Process pro-rata refund if within billing period
  const daysBilled = daysInCurrentBillingPeriod(subscription);
  const daysUsed = daysSinceStart(subscription);
  const refundAmount = Math.round(
    ((daysBilled - daysUsed) / daysBilled) * subscription.plan.price_cents
  );

  if (refundAmount > 0) {
    await createRefund(subscription.id, refundAmount, 'pro_rata_cancellation');
  }
}
```

---

## Settlement & Reporting

### Daily Settlement Calculation

```typescript
async function calculateDailySettlement(
  tenantId: string,
  settlementDate: Date
) {
  // Get all transactions for the day
  const transactions = await db.query(
    `
    SELECT
      amount_cents,
      platform_fee_cents
    FROM transactions
    WHERE tenant_id = $1
      AND status = 'completed'
      AND DATE(created_at) = $2
  `,
    [tenantId, settlementDate]
  );

  const totalCollected = transactions.reduce(
    (sum, t) => sum + t.amount_cents,
    0
  );
  const platformFees = transactions.reduce(
    (sum, t) => sum + t.platform_fee_cents,
    0
  );
  const netToTenant = totalCollected - platformFees;

  // Create settlement record
  const settlement = await db.query(
    `
    INSERT INTO settlements
    (tenant_id, settlement_date, total_collected_cents, platform_fees_cents, net_to_tenant_cents)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `,
    [tenantId, settlementDate, totalCollected, platformFees, netToTenant]
  );

  return settlement;
}

// Tenant can query their settlement history (scoped)
async function getTenantSettlements(tenantId: string, monthsBack: number = 12) {
  return db.query(
    `
    SELECT
      settlement_date,
      total_collected_cents / 100.0 as total_collected,
      platform_fees_cents / 100.0 as platform_fees,
      net_to_tenant_cents / 100.0 as net_to_tenant,
      status
    FROM settlements
    WHERE tenant_id = $1
      AND settlement_date >= CURRENT_DATE - $2 * INTERVAL '1 month'
    ORDER BY settlement_date DESC
  `,
    [tenantId, monthsBack]
  );
}
```

### Monthly Revenue Report (Anonymous Aggregation)

```sql
-- Platform finance team queries (no tenant names, just aggregates)
SELECT
  DATE_TRUNC('month', settlement_date)::DATE as month,
  COUNT(DISTINCT tenant_id) as active_tenants,
  SUM(total_collected_cents) as total_revenue,
  SUM(platform_fees_cents) as platform_fees,
  AVG(net_to_tenant_cents) as avg_tenant_settlement
FROM settlements
WHERE settlement_date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY 1
ORDER BY 1 DESC;
```

---

## Refunds & Disputes

### Refund Processing

```typescript
async function processRefund(
  tenantId: string,
  transactionId: string,
  amountCents: number,
  reason: string
) {
  const transaction = await db.query(
    `SELECT * FROM transactions WHERE id = $1 AND tenant_id = $2`,
    [transactionId, tenantId]
  );

  if (!transaction) {
    throw new ForbiddenError('Transaction not found');
  }

  if (transaction.status !== 'completed') {
    throw new Error('Can only refund completed transactions');
  }

  // Create refund in Stripe
  const refund = await stripe.refunds.create({
    charge: transaction.stripe_charge_id,
    amount: amountCents,
    reason: reason,

    metadata: {
      tenant_id: tenantId,
      reason: reason,
    },
  });

  // Record refund locally
  await db.query(
    `
    INSERT INTO refunds
    (tenant_id, transaction_id, amount_cents, reason, status, stripe_refund_id)
    VALUES ($1, $2, $3, $4, $5, $6)
  `,
    [tenantId, transactionId, amountCents, reason, 'pending', refund.id]
  );

  // Update transaction status
  await db.query(
    `
    UPDATE transactions
    SET status = 'refunded', refunded_at = NOW()
    WHERE id = $1
  `,
    [transactionId]
  );
}
```

### Dispute Handling

```typescript
// Webhook from Stripe about a chargeback dispute
async function handleChargebackWebhook(event: Stripe.Event) {
  const dispute = event.data.object as Stripe.Dispute;

  const transaction = await db.query(
    `SELECT * FROM transactions WHERE stripe_charge_id = $1`,
    [dispute.charge]
  );

  if (!transaction) {
    console.warn(`Chargeback for unknown transaction: ${dispute.charge}`);
    return;
  }

  // Record dispute (scoped to tenant)
  await db.query(
    `
    UPDATE transactions
    SET status = 'dispute'
    WHERE id = $1
  `,
    [transaction.id]
  );

  // Notify tenant
  await sendNotification({
    tenantId: transaction.tenant_id,
    eventType: 'payment_dispute',
    eventData: {
      amount: dispute.amount / 100,
      reason: dispute.reason,
    },
  });
}
```

---

## Security & Compliance

### PCI Compliance

**Rule: Never store raw card data locally.**

```typescript
// ✗ WRONG: Storing card data
async function savePaymentMethod(tenantId: string, cardNumber: string) {
  await db.query(
    `INSERT INTO payment_methods (tenant_id, card_number) VALUES ($1, $2)`,
    [tenantId, cardNumber] // ← VIOLATION!
  );
}

// ✓ CORRECT: Use Stripe tokenization
async function savePaymentMethod(tenantId: string, token: string) {
  // Token comes from Stripe.js, never raw card
  const paymentMethod = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: token },
  });

  // Store only Stripe reference
  await db.query(
    `INSERT INTO payment_methods (tenant_id, stripe_payment_method_id)
     VALUES ($1, $2)`,
    [tenantId, paymentMethod.id]
  );
}
```

### Tenant Data Isolation in Payment Queries

```typescript
// ✓ CORRECT: All payment queries scoped to authenticated tenant
async function getTenantInvoices(authenticatedTenantId: string) {
  return db.query(
    `
    SELECT * FROM invoices
    WHERE tenant_id = $1  -- ← MANDATORY filter
      AND status != 'cancelled'
    ORDER BY issued_date DESC
  `,
    [authenticatedTenantId]
  );
}

// ✗ WRONG: Tenant ID comes from request parameter
async function getTenantInvoices(tenantIdFromRequest: string) {
  // An attacker could modify the URL parameter
  return db.query(
    `SELECT * FROM invoices WHERE tenant_id = ${tenantIdFromRequest}` // ← SQL injection + multi-tenant violation!
  );
}
```

---

## Summary

**Multi-Tenant Payment Checklist:**

- [x] Two-tier billing (platform + transaction fees)
- [x] Subscription lifecycle (trial → active → cancelled)
- [x] Per-tenant invoice generation
- [x] Transaction isolation (each tenant sees only their transactions)
- [x] Settlement accounting (daily records for each tenant)
- [x] Refund handling with audit trail
- [x] Dispute tracking
- [x] PCI compliance (no raw card storage)
- [x] Tenant context in all payment queries

**Interview Points:**

1. "Why store payments in two places (Stripe + local DB)?" → Local DB for reporting/history, Stripe for security
2. "How do you prevent Tenant A from accessing Tenant B's transactions?" → Mandatory tenant_id filter in queries
3. "Settlement accounting?" → Daily records per tenant, verified against Stripe
4. "Refund pro-rata logic?" → Calculate based on days used vs. billing period
5. "PCI compliance?" → Never store raw cards, use Stripe tokenization only

---

## Related Reading

- See [04-database-design/SCHEMA_DESIGN_PATTERNS.md](../04-database-design/SCHEMA_DESIGN_PATTERNS.md) for multi-tenant schema patterns
- See [03-authorization-security/MULTI_TENANT_ISOLATION.md](../03-authorization-security/MULTI_TENANT_ISOLATION.md) for isolation rules
