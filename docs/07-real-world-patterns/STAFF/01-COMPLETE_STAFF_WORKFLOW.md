# Portfolio Note

> Extracted from production system, sanitized for portfolio use.

---

# Complete Staff Workflow - All Scenarios Explained

## The Complete Picture: Invitation to Dashboard

This document explains the **ENTIRE** staff workflow from invitation to dashboard access, covering all user scenarios, frontend behavior, and backend processing.

---

## The 3 User Scenarios

### Who Gets Invited?

| Scenario   | User Type            | Has Account? | Is Staff? | Example                               |
| ---------- | -------------------- | ------------ | --------- | ------------------------------------- |
| **Flow 1** | New User          | No        | No     | Jake - never used platform            |
| **Flow 2** | Existing Customer | Yes       | No     | Alex - books appointments as customer |
| **Flow 3** | Multi-organization/business Staff | Yes       | Yes    | Sarah - works at Uptown Glamour       |

---

## Complete Workflow Breakdown

### Phase 1: Invitation Sent

```mermaid
graph TD
    A[👑 Maria creates invitation] --> B{Check invitee status}
    B --> C[🆕 New User<br/>Jake]
    B --> D[👤 Existing Customer<br/>Alex]
    B --> E[💼 Multi-organization/business Staff<br/>Sarah]

    C --> F[📧 Email: Please register & join us]
    D --> G[📧 Email: Join our staff team]
    E --> H[📧 Email: Work with us too]

    F --> I[🔗 Link: /staff/onboarding/abc123]
    G --> I
    H --> I

    classDef newUser fill:#FFE6E6
    classDef existingCustomer fill:#E6F3FF
    classDef multiSalon fill:#E6FFE6

    class C,F newUser
    class D,G existingCustomer
    class E,H multiSalon
```

**Key Point:** All scenarios get the same invitation email with the same onboarding link.

---

### Phase 2: Frontend Onboarding Form

```mermaid
sequenceDiagram
    participant U as 🧑 User
    participant F as 🖥️ Frontend
    participant API as 🚀 Backend API

    U->>F: Clicks invitation link
    F->>API: GET /staff/onboarding/validate/abc123

    API->>API: Check invitation & user status
    API->>F: Return invitation details + user scenario

    Note over F: Form pre-fills based on scenario

    alt 🆕 New User (Jake)
        F->>U: Empty form - fill everything
    else 👤 Existing Customer (Alex)
        F->>U: Pre-filled form with existing data
    else 💼 Multi-organization/business Staff (Sarah)
        F->>U: Pre-filled with global profile data
    end

    U->>F: Fills/confirms form data
    U->>F: Submits onboarding form
    F->>API: POST /staff/onboarding/submit
```

#### Frontend Form Behavior

| Scenario                 | Form Fields                   | Pre-filled Data    | User Action             |
| ------------------------ | ----------------------------- | ------------------ | ----------------------- |
| **New User**          | All empty                     | None               | Fill everything         |
| **Existing Customer** | Name, email, phone pre-filled | From user account  | Confirm/update details  |
| **Multi-organization/business Staff** | Profile data pre-filled       | From staff profile | Add organization/business-specific info |

---

### Phase 3: Backend Onboarding Processing

```mermaid
graph TD
    A[📝 Form submitted] --> B[🔍 Analyze user scenario]

    B --> C{User Type?}

    C -->|🆕 New User| D[Create: User + Staff Profile + Employment]
    C -->|👤 Customer| E[Create: Staff Profile + Employment<br/>Reuse: User Account]
    C -->|💼 Multi-Staff| F[Create: Employment<br/>Reuse: User + Staff Profile]

    D --> G[🎯 Result: New team member created]
    E --> H[🎯 Result: Customer promoted to staff]
    F --> I[🎯 Result: Multi-organization/business employment added]

    G --> J{Account setup needed?}
    H --> J
    I --> J

    J -->|🆕 New User| K[🔐 Redirect to account setup]
    J -->|👤 Has password| L[✅ Redirect to dashboard]
    J -->|💼 Multi-organization/business| L

    classDef atomic fill:#FFE6CC
    class D,E,F atomic
```

#### Backend Processing Details

```typescript
// staff-onboarding.service.ts - executeAtomicOnboarding()

if (!scenario.existing_account) {
  // 🆕 NEW USER (Jake)
  userId = await createNewUser(data);
  staffProfileId = await createNewStaffProfile(userId, data);
  employmentId = await createEmployment(staffProfileId, data);
} else if (!scenario.existing_staff_profile) {
  // 👤 EXISTING CUSTOMER (Alex)
  userId = scenario.user_id;
  staffProfileId = await createNewStaffProfile(userId, data);
  employmentId = await createEmployment(staffProfileId, data);
} else {
  // 💼 MULTI-organization/business STAFF (Sarah)
  userId = scenario.user_id;
  staffProfileId = scenario.staff_profile_id; // REUSE existing
  employmentId = await createEmployment(staffProfileId, data);
}
```

---

### Phase 4: Post-Onboarding Routing

```mermaid
graph TD
    A[📋 Onboarding completed] --> B{User scenario?}

    B -->|🆕 New User| C[🔐 Account Setup Required]
    B -->|👤 Customer with password| D[✅ Direct to dashboard]
    B -->|👤 Customer no password| C
    B -->|💼 Multi-organization/business staff| D

    C --> E[📧 Email verification]
    E --> F[🔑 Password setup]
    F --> G[✅ Complete setup]
    G --> H[🏠 Dashboard access]

    D --> H

    classDef setup fill:#FFE6E6
    classDef dashboard fill:#E6FFE6

    class C,E,F,G setup
    class D,H dashboard
```

---

## Account Setup vs Onboarding

### When Does What Happen?

| Service                       | Purpose                        | When Used              | For Who                                 |
| ----------------------------- | ------------------------------ | ---------------------- | --------------------------------------- |
| **StaffOnboardingService** | Create employment relationship | Always (all scenarios) | Everyone                                |
| **AccountSetupService**    | Set up login credentials       | Only when needed       | New users + customers without passwords |

### The Flow Relationship

```mermaid
sequenceDiagram
    participant U as 🧑 User
    participant OS as 📋 OnboardingService
    participant AS as 🔐 AccountSetupService
    participant DB as 🗄️ Database

    Note over U,DB: Phase 1: Employment Creation (Always)
    U->>OS: Submit onboarding form
    OS->>DB: Create user/profile/employment
    OS->>U: Onboarding success + redirect

    Note over U,DB: Phase 2: Account Setup (Conditional)

    alt 🆕 New User (needs account setup)
        U->>AS: Access account setup
        AS->>U: Send email verification
        U->>AS: Verify email
        AS->>U: Set password
        AS->>U: Complete setup → Dashboard
    else 👤 Customer (has password)
        Note over U: Skip account setup
        U->>U: Direct to dashboard
    else 💼 Multi-organization/business (has everything)
        Note over U: Skip account setup
        U->>U: Direct to dashboard
    end
```

---

## Frontend Implementation Guide

### Onboarding Form Component

```typescript
// OnboardingForm.tsx
const OnboardingForm = ({ invitationToken }) => {
  const [userScenario, setUserScenario] = useState(null);
  const [formData, setFormData] = useState({});

  useEffect(() => {
    // Validate token and get user scenario
    validateInvitation(invitationToken).then((response) => {
      setUserScenario(response.user_scenario);

      // Pre-fill form based on scenario
      if (response.user_scenario === 'existing_customer') {
        setFormData({
          firstName: response.user_data.name.split(' ')[0],
          lastName: response.user_data.name.split(' ')[1],
          email: response.user_data.email,
          phone: response.user_data.phone,
        });
      } else if (response.user_scenario === 'multi_salon_staff') {
        setFormData({
          ...response.staff_profile_data,
          // Only organization/business-specific fields remain empty
        });
      }
    });
  }, [invitationToken]);

  const handleSubmit = async (data) => {
    const result = await submitOnboarding({
      ...data,
      invitation_token: invitationToken,
    });

    // Route based on result
    if (result.requires_account_setup) {
      router.push(`/staff/account-setup?profile=${result.staff_profile_id}`);
    } else {
      router.push('/staff/dashboard');
    }
  };
};
```

### Account Setup Flow

```typescript
// AccountSetupFlow.tsx
const AccountSetupFlow = ({ staffProfileId }) => {
  const [currentStep, setCurrentStep] = useState('email_verification');

  useEffect(() => {
    // Check current setup status
    getAccountSetupStatus(staffProfileId).then(status => {
      setCurrentStep(status.next_step);
    });
  }, []);

  const steps = {
    'email_verification': <EmailVerificationStep />,
    'password_setup': <PasswordSetupStep />,
    'complete_setup': <CompleteSetupStep />
  };

  return (
    <div>
      <ProgressBar currentStep={currentStep} />
      {steps[currentStep]}
    </div>
  );
};
```

---

## Detailed Scenario Examples

### Scenario 1: Jake (New User)

```mermaid
journey
    title Jake's Complete Journey
    section Invitation
      Receives email: 5: Jake
      Clicks link: 4: Jake
    section Onboarding
      Sees empty form: 3: Jake
      Fills all details: 4: Jake
      Submits form: 5: Jake
    section Account Setup
      Sees setup page: 4: Jake
      Verifies email: 5: Jake
      Sets password: 5: Jake
      Completes setup: 5: Jake
    section Dashboard
      Accesses dashboard: 5: Jake
```

**Database Changes:**

```sql
-- New records created
users: INSERT new user
staff_profiles: INSERT new profile
staff_employments: INSERT new employment
user_verifications: INSERT email verification
user_credentials: INSERT password hash
```

### Scenario 2: Alex (Existing Customer)

```mermaid
journey
    title Alex's Complete Journey
    section Invitation
      Receives email: 5: Alex
      Clicks link: 4: Alex
    section Onboarding
      Sees pre-filled form: 5: Alex
      Confirms details: 4: Alex
      Submits form: 5: Alex
    section Dashboard
      Direct access: 5: Alex
```

**Database Changes:**

```sql
-- Reuse existing, create new
users: REUSE existing
staff_profiles: INSERT new profile
staff_employments: INSERT new employment
-- No account setup needed (has password)
```

### Scenario 3: Sarah (Multi-organization/business Staff)

```mermaid
journey
    title Sarah's Complete Journey
    section Invitation
      Receives email: 5: Sarah
      Clicks link: 4: Sarah
    section Onboarding
      Sees profile data: 5: Sarah
      Adds organization/business info: 4: Sarah
      Submits form: 5: Sarah
    section Dashboard
      Multi-organization/business view: 5: Sarah
```

**Database Changes:**

```sql
-- Reuse everything, add employment
users: REUSE existing
staff_profiles: REUSE existing
staff_employments: INSERT additional employment
-- No account setup needed (has everything)
```

---

## Summary

**The Flow:**

1. **Invitation** - Same for all scenarios
2. **Onboarding Form** - Pre-fills based on user type
3. **Backend Processing** - Creates appropriate records
4. **Routing Decision** - Account setup vs dashboard
5. **Dashboard Access** - Multi-organization/business aware

**The Scenarios:**

- **New User:** Full journey (onboarding -> account setup -> dashboard)
- **Existing Customer:** Medium journey (onboarding -> dashboard)
- **Multi-organization/business Staff:** Short journey (onboarding -> dashboard)

---

## Actual Module Structure (Verified Against Codebase)

The staff module (`apps/api/src/staff/`) contains **10 controllers** and **18 services** organized into 3 service subdirectories.

### Controllers (10)

| Controller | File | Purpose |
|---|---|---|
| `AdminStaffController` | `admin-staff.controller.ts` | Admin-level staff management |
| `OwnerProfileCompletionController` | `owner-profile-completion.controller.ts` | Owner profile completion flow |
| `PublicStaffController` | `public-staff.controller.ts` | Public-facing staff endpoints |
| `StaffAccountSetupController` | `staff-account-setup.controller.ts` | Account setup for new staff |
| `StaffInvitationsPublicController` | `staff-invitations-public.controller.ts` | Public invitation validation |
| `StaffInvitationsController` | `staff-invitations.controller.ts` | Invitation management (authenticated) |
| `StaffOnboardingFormController` | `staff-onboarding-form.controller.ts` | Onboarding form submission |
| `StaffProfileCompletionController` | `staff-profile-completion.controller.ts` | Staff profile completion |
| `StaffProfileController` | `staff-profile.controller.ts` | Staff profile CRUD |
| `StaffScheduleController` | `staff-schedule.controller.ts` | Staff schedule management |

### Services (18, in 3 subdirectories)

**invitations/** (5 services):
- `StaffInvitationCoreService` - Core invitation logic
- `StaffInvitationResponseService` - Invitation response handling
- `StaffInvitationTransformationService` - Data transformation
- `StaffInvitationValidationService` - Invitation validation rules
- `StaffInvitationsService` - Invitation orchestration

**management/** (6 services):
- `AdminStaffService` - Admin staff operations
- `PublicStaffService` - Public staff queries
- `ScheduleProposalService` - Schedule proposals
- `StaffEmploymentsService` - Employment record management
- `StaffProfileCompletionService` - Profile completion tracking
- `StaffProfileService` - Profile CRUD

**onboarding/** (7 services):
- `AccountSetupService` - Credential setup for new users
- `OwnerProfileCompletionService` - Owner profile completion
- `StaffEmploymentLifecycleService` - Employment lifecycle management
- `StaffOnboardingIdentityService` - Identity resolution during onboarding
- `StaffOnboardingService` - Onboarding orchestration
- `StaffProfileProvisioningService` - Profile creation during onboarding
- `StaffUserDetectionService` - User scenario detection (new/existing/multi-organization/business)

### Repositories (10)

- `AccountSetupRepository`
- `ScheduleProposalRepository`
- `StaffAvailabilityRepository`
- `StaffEmploymentRepository`
- `StaffInvitationsRepository`
- `StaffProfileRepository`
- `StaffSalonAssociationsRepository`
- `StaffServicesRepository`
- `StaffSpecializationsRepository`
- `UserRepository` (imported from `users` module)

### Discrepancies Between Doc and Code

1. **Doc says "One service handles employment creation (StaffOnboardingService)"** - In reality, onboarding is decomposed into 7 services with clear SRP: identity detection, profile provisioning, employment lifecycle, etc.
2. **Doc references `executeAtomicOnboarding()` in `staff-onboarding.service.ts`** - The actual service file is `staff-onboarding.service.ts` in `services/onboarding/`. The method name should be verified against the actual source.
3. **Doc does not mention** `OwnerProfileCompletionController`, `StaffProfileCompletionController`, `StaffScheduleController`, or `PublicStaffController` - these are additional controllers beyond what the invitation/onboarding workflow covers.
4. **Doc does not cover** schedule management, profile completion flows, or admin staff operations - the module scope is broader than onboarding alone.
5. **Invitation service is decomposed into 5 services** (core, response, transformation, validation, orchestration) - more granular than the doc implies.
