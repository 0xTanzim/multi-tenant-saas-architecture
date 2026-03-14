# Portfolio Note

> Extracted from production system, sanitized for portfolio use.

---

# 🎯 **Complete Guide: Freelancers vs organizations/businesses & Embedded Booking System**

## **📋 Part 1: Understanding Freelancers vs organizations/businesses**

### **🤔 What is a Freelancer in Our Context?**

A **freelancer** in Denmark (and our platform) is:

- **Individual service provider** working from home or traveling to customers
- **Examples**: Mobile hairdresser, home nail technician, freelance massage therapist
- **NOT an employee** - they are their own business
- **Same platform, different setup** - they create their own "tenant" account

### **🏢 Freelancer vs organization/business Comparison**

```mermaid
graph TB
    subgraph "🏠 FREELANCER (Individual)"
        F1[👤 Sarah - Mobile Hairdresser]
        F2[🏠 Works from home OR travels to customers]
        F3[📱 Manages own calendar]
        F4[💰 Sets own prices]
        F5[🚗 Service radius: 15km from home]
    end

    subgraph "🏢 organization/business (Business)"
        S1[🏢 Downtown Beauty organization/business]
        S2[👥 Multiple staff members]
        S3[📅 Complex scheduling]
        S4[🏢 Fixed location only]
        S5[👔 Manager oversees all staff]
    end

    F1 --> Database[🗄️ Same Database - Different tenant_type]
    S1 --> Database
```

### **🔄 How Both Types Use Our Platform**

| Feature                | 🏠 Freelancer              | 🏢 organization/business                     |
| ---------------------- | -------------------------- | ---------------------------- |
| **Account Creation**   | Creates own tenant account | Creates organization/business tenant account |
| **Staff Management**   | Only themselves            | Multiple staff members       |
| **Location**           | Home + Mobile service      | Fixed organization/business location         |
| **Pricing**            | Simple, personal pricing   | Complex, multi-staff pricing |
| **Booking Management** | Personal calendar          | Multi-staff coordination     |
| **Customer Base**      | Personal clients           | organization/business customers              |

---

## **📋 Part 2: Embedded Booking System Explained**

### **🤔 What is "Embedded Booking"?**

**YES, exactly like YouTube iframe!** 🎯

When John (service provider/operator) wants customers to book directly on **his website** without leaving to go to **our website**.

### **📺 YouTube Iframe Example**

```html
<!-- John embeds YouTube video on his website -->
<iframe src="https://youtube.com/embed/VIDEO_ID" width="560" height="315">
</iframe>
```

### **📅 Our Booking Widget Example**

```html
<!-- John embeds our booking form on his website -->
<iframe
  src="https://the platform.dk/widget/john-organization/business/booking"
  width="400"
  height="600"
>
</iframe>
```

### **🔄 Customer Journey Comparison**

```mermaid
sequenceDiagram
    participant C as 👤 Customer
    participant JS as 🌐 John's organization/business Website
    participant DB as 🎯 the Platform Platform

    Note over C,DB: CURRENT WAY (Customer leaves John's site)
    C->>JS: Visits john-organization/business.dk
    C->>JS: Clicks "Book Appointment"
    JS->>DB: Redirects to the platform.dk/john-organization/business
    C->>DB: Books on our platform
    DB->>C: Booking confirmation

    Note over C,DB: NEW WAY (Embedded - Customer stays on John's site)
    C->>JS: Visits john-organization/business.dk
    C->>JS: Sees booking form (our widget)
    JS->>DB: Widget loads from our platform
    C->>JS: Books without leaving John's site
    DB->>C: Booking confirmation
```

### **💰 Business Model**

```mermaid
graph TD
    subgraph "💰 Revenue Streams"
        R1[📱 Basic SaaS: €29/month]
        R2[🎨 Widget License: €15/month extra]
        R3[🔌 API Access: €49/month extra]
    end

    subgraph "🎯 Customer Types"
        C1[🏠 Freelancer: Basic plan only]
        C2[🏢 Small organization/business: Basic + Widget]
        C3[🏢 Large organization/business: All features + API]
    end

    C1 --> R1
    C2 --> R1
    C2 --> R2
    C3 --> R1
    C3 --> R2
    C3 --> R3
```

---

## **📋 Part 3: Technical Implementation**

### **🔧 How Embedded Widgets Work**

```mermaid
graph TB
    subgraph "🌐 John's Website (john-organization/business.dk)"
        W1[🏠 Home Page]
        W2[📅 Booking Page with Widget]
        W3[💇 Services Page]
    end

    subgraph "🎯 Our Platform (the platform.dk)"
        A1[🖥️ Widget Server]
        A2[🗄️ Database]
        A3[📱 Main App]
    end

    W2 -->|Loads widget iframe| A1
    A1 -->|Saves booking data| A2
    A2 -->|Shows in organization/business dashboard| A3

    style W2 fill:#e1f5fe,color:#000
    style A1 fill:#f3e5f5,color:#000

```

### **🛠️ Widget Creation Process**

```mermaid
flowchart TD
    S1[🏢 John signs up for organization/business account]
    --> S2[⚙️ Goes to Settings > Widget]
    --> S3[🎨 Customizes colors, theme]
    --> S4[🔗 Gets embed code]
    --> S5[💻 Adds code to his website]
    --> S6[🎉 Customers can book on his site]

    style S1 fill:#e8f5e8,color:#000
    style S6 fill:#fff3e0,color:#000
```

### **📋 Database Schema Logic**

```mermaid
erDiagram
    TENANTS {
        int id PK
        string type "freelancer OR organization/business"
        boolean is_mobile_service "Only for freelancers"
        int service_radius_km "Only for freelancers"
        jsonb widget_settings "Only for organizations/businesses who pay"
        jsonb api_settings "Only for enterprise"
    }

    USERS {
        int id PK
        string email
        string name
    }

    BOOKINGS {
        int id PK
        int tenant_id FK
        int customer_id FK
        string booking_source "online, widget, mobile"
    }

    TENANTS ||--o{ BOOKINGS : "has many"
    USERS ||--|| TENANTS : "owns"
    USERS ||--o{ BOOKINGS : "books"
```

---

## **📋 Part 4: User Flows**

### **🏠 Freelancer Registration Flow**

```mermaid
flowchart TD
    A[👤 Sarah wants to offer mobile hairdressing]
    --> B[📱 Signs up on the Platform]
    --> C{Choose account type}
    --> D[🏠 Selects Freelancer]
    --> E[📍 Sets home address]
    --> F[🚗 Sets service radius: 15km]
    --> G[💇 Adds her services & prices]
    --> H[📅 Sets availability]
    --> I[🎉 Starts accepting bookings]

    style D fill:#e1f5fe
    style I fill:#e8f5e8

```

### **🏢 organization/business with Widget Flow**

```mermaid
flowchart TD
    A[🏢 John owns Downtown organization/business]
    --> B[📱 Signs up on the Platform]
    --> C{Choose account type}
    --> D[🏢 Selects organization/business]
    --> E[👥 Adds staff members]
    --> F[💇 Sets up services]
    --> G[💰 Upgrades to Widget plan]
    --> H[🎨 Customizes widget appearance]
    --> I[💻 Embeds widget on his website]
    --> J[🎉 Customers book without leaving his site]

    style D fill:#f3e5f5
    style J fill:#e8f5e8
```

### **👤 Customer Booking Flow**

```mermaid
flowchart TD
    subgraph "🏠 Booking Freelancer"
        A1[👤 Customer searches for mobile hairdresser]
        --> A2[📍 Finds Sarah within 10km]
        --> A3[📅 Books appointment]
        --> A4[🚗 Sarah comes to customer's home]
    end

    subgraph "🏢 Booking via organization/business Widget"
        B1[👤 Customer visits john-organization/business.dk]
        --> B2[📅 Sees booking form on his website]
        --> B3[💇 Books without leaving the site]
        --> B4[🏢 Goes to organization/business for appointment]
    end

    style A1 fill:#e1f5fe
    style B1 fill:#f3e5f5
```

---

## **📋 Part 5: Revenue & Pricing Strategy**

### **💰 Subscription Tiers**

```mermaid
graph TB
    subgraph "🆓 FREE (Freelancers)"
        F1[📅 Basic booking calendar]
        F2[👤 Personal profile]
        F3[💰 Simple pricing]
        F4[🚫 No widget/API]
    end

    subgraph "💳 BASIC €29/month (Small organizations/businesses)"
        B1[👥 Up to 5 staff]
        B2[📊 Basic analytics]
        B3[📱 Mobile app access]
        B4[🚫 No widget/API]
    end

    subgraph "⭐ PRO €49/month (Growing organizations/businesses)"
        P1[👥 Unlimited staff]
        P2[🎨 Embedded widget]
        P3[📊 Advanced analytics]
        P4[🎯 Custom branding]
    end

    subgraph "🏢 ENTERPRISE €99/month (Large Chains)"
        E1[🔌 Full API access]
        E2[🔗 POS integration]
        E3[📈 Advanced reporting]
        E4[👨‍💼 Account manager]
    end
```

---

## **📋 Part 6: Technical Questions Answered**

### **❓ "How does the widget actually work?"**

1. **John's website** loads our widget via iframe
2. **Our servers** serve the booking form
3. **Customer** books through the widget
4. **Data** saves to our database
5. **John** sees booking in his dashboard

### **❓ "Is freelancer setup the same as organization/business?"**

**YES, same process, different configuration:**

```typescript
// Same registration form, different defaults
const freelancerDefaults = {
  tenant_type: 'freelancer',
  is_mobile_service: true, // Can travel to customers
  service_radius_km: 10, // How far they travel
  widget_settings: { enabled: false }, // No widget for free plan
};

const salonDefaults = {
  tenant_type: 'organization/business',
  is_mobile_service: false, // Fixed location
  service_radius_km: 0, // Not applicable
  widget_settings: { enabled: true }, // Can have widget if paid
};
```

### **❓ "How do customers find freelancers?"**

```mermaid
flowchart LR
    A[👤 Customer searches]
    --> B[📍 Enter location]
    --> C[🔍 System finds freelancers within radius]
    --> D[📱 Shows available freelancers]
    --> E[📅 Customer books]

    style C fill:#e1f5fe
```

---

## **📋 Part 7: Implementation Priority**

### **🚀 Phase 1: MVP (Must Have Now)**

- ✅ Support both freelancer and organization/business tenant types
- ✅ Basic mobile service configuration
- ⏳ Simple booking flow for both types
- ⏳ Location-based freelancer search

### **📈 Phase 2: Widget System (Next Month)**

- ⏳ Embeddable booking widget
- ⏳ Widget customization (colors, themes)
- ⏳ Domain restrictions for security
- ⏳ Widget analytics

### **🏢 Phase 3: Enterprise Features (Later)**

- ⏳ Full API access
- ⏳ Webhook notifications
- ⏳ POS system integrations
- ⏳ Advanced analytics

---

## **🎯 Summary: Key Differences**

| Aspect               | 🏠 Freelancer               | 🏢 organization/business                     |
| -------------------- | --------------------------- | ---------------------------- |
| **Business Model**   | Individual service provider | Business with employees      |
| **Location**         | Home-based + Mobile         | Fixed organization/business location         |
| **Platform Usage**   | Creates own tenant account  | Creates organization/business tenant account |
| **Staff**            | Just themselves             | Multiple staff members       |
| **Pricing**          | Free/Basic plan             | Basic to Enterprise plans    |
| **Widget**           | Not available (free plan)   | Available (paid plans)       |
| **Target Customers** | Personal client base        | Walk-ins + appointments      |

**Bottom Line**: Same platform, different configurations! Freelancers and organizations/businesses both create "tenant" accounts but with different settings and features. 🎯

**Widget**: Exactly like YouTube embed - customers book on organization/business's website without leaving! 📺➡️📅
