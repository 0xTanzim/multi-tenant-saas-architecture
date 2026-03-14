# Case Study: Multi-Tenant File Upload & Storage Management

**Context:** SaaS system where multiple tenants upload files (images, documents, PDFs) and must not access each other's files

**Complexity:** Storage isolation, access control, quota management, secure serving, cleanup strategy

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Storage Architecture](#storage-architecture)
3. [Tenant Isolation](#tenant-isolation)
4. [File Metadata & Access Control](#file-metadata--access-control)
5. [Upload Workflow](#upload-workflow)
6. [Secure File Serving](#secure-file-serving)
7. [Quota Management](#quota-management)
8. [Cleanup & Retention](#cleanup--retention)

---

## Problem Statement

A multi-tenant platform allows uploads:

- **Tenant A uploads:** Customer profile photos, service images, business documents
- **Tenant B uploads:** Different customer photos, marketing materials

**Multi-Tenant Constraints:**

- Tenant A's files must be inaccessible to Tenant B (storage isolation)
- Tenant A cannot download files shared by Tenant B
- Delete operations only affect Tenant's own files
- Each tenant has a storage quota (e.g., 10GB)
- Serving files must be fast (no permission checks on every request)
- Deleted files must be securely removed (GDPR compliance)

### Interview Problem

> "Design a file upload system for 10k tenants where:
>
> - Storage is isolated between tenants
> - A tenant can't download another tenant's files even if they guess the URL
> - Each tenant has a 10GB quota
> - Serve files with <100ms latency
> - Deleted files are securely erased (GDPR)
> - Performance remains constant as total storage grows to 100TB"

---

## Storage Architecture

### Option 1: S3 with Folder-Based Isolation

```
S3 bucket structure:
s3://platform-storage/
  ├── tenant-123/           ← Isolated folder per tenant
  │   ├── profile-photos/
  │   ├── documents/
  │   └── temp/
  ├── tenant-456/
  │   ├── profile-photos/
  │   └── documents/
  └── ...
```

**Pros:**

- Simple to understand
- Easy backup/restore per tenant
- Bucket policies enforce isolation

**Cons:**

- Thousands of folders (management overhead)
- Bucket operations slower with millions of keys

### Option 2: S3 with IAM Policy Isolation

```
S3 bucket structure:
s3://platform-storage/tenant-123/...
s3://platform-storage/tenant-456/...

IAM Policy (for Tenant 123's API key):
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject"],
    "Resource": "arn:aws:s3:::platform-storage/tenant-123/*"  ← Only their prefix!
  }]
}
```

**Pros:**

- Strong isolation (enforced at AWS level)
- Scalable to millions of files

**Cons:**

- Requires managing IAM policies per tenant
- More complex setup

### Option 3: Presigned URLs (Recommended for Most Cases)

```
S3 bucket structure:
s3://platform-storage/tenant-123/doc-abc.pdf

Backend generates presigned URL:
https://s3.amazonaws.com/platform-storage/tenant-123/doc-abc.pdf?
  X-Amz-Signature=...&
  X-Amz-Expires=3600  ← Valid for 1 hour

Client can:
- GET (download) ✓
- PUT (upload, if policy allows) ✓
- DELETE (if policy allows) ✗ (denied by signature)
```

**Pros:**

- Simple to implement
- Fine-grained control (expiring URLs)
- No per-tenant AWS accounts needed

**Cons:**

- URL expiration (not suitable for permanent links)
- Signature generation adds latency

---

## Tenant Isolation

### Database: File Metadata

```sql
-- File metadata (tracks ownership, not the actual data)
CREATE TABLE files (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES organizations(id),
  uploaded_by_user_id INTEGER NOT NULL,

  file_name VARCHAR NOT NULL,
  s3_key VARCHAR NOT NULL, -- "tenant-123/uploads/abc-123.jpg"
  s3_bucket VARCHAR NOT NULL,

  file_size_bytes BIGINT NOT NULL,
  mime_type VARCHAR NOT NULL,

  -- For access control
  visibility VARCHAR DEFAULT 'private', -- 'private', 'org_only', 'public'

  -- Soft delete
  deleted_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (tenant_id, s3_key),
  INDEX (tenant_id, deleted_at),
  INDEX (tenant_id, created_at DESC)
);
```

### Principle: S3 Key Must Include Tenant ID

```typescript
// ✓ CORRECT: S3 key includes tenant_id
function generateS3Key(tenantId: string, fileName: string): string {
  const uniqueId = generateUUID();
  return `tenant-${tenantId}/uploads/${uniqueId}-${fileName}`;
  // Result: "tenant-123/uploads/abc-xyz-myfile.jpg"
}

// ✗ WRONG: S3 key doesn't include tenant_id
function generateS3Key(fileName: string): string {
  return `uploads/${fileName}`;
  // Result: "uploads/myfile.jpg" ← Vulnerable! Different tenants might use same filename
}
```

### Principle: Always Validate Tenant Ownership

```typescript
async function downloadFile(authenticatedTenantId: string, fileId: string) {
  // ✓ CORRECT: Validate tenant ownership before serving
  const file = await db.query(
    `SELECT * FROM files
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [fileId, authenticatedTenantId]
  );

  if (!file) {
    throw new ForbiddenError('File not found or access denied');
  }

  // Generate presigned URL (valid for 1 hour)
  const presignedUrl = await s3.getSignedUrl('getObject', {
    Bucket: file.s3_bucket,
    Key: file.s3_key,
    Expires: 3600,
  });

  return { url: presignedUrl, fileName: file.file_name };
}

// ✗ WRONG: No tenant validation
async function downloadFile(fileId: string) {
  const file = await db.query(`SELECT * FROM files WHERE id = $1`, [fileId]);

  const presignedUrl = await s3.getSignedUrl('getObject', {
    Bucket: file.s3_bucket,
    Key: file.s3_key,
    Expires: 3600,
  });

  return presignedUrl;
  // An attacker can download any file by guessing fileId!
}
```

---

## File Metadata & Access Control

### Visibility Levels

| Visibility   | Who Can Access                | Use Case                                   |
| ------------ | ----------------------------- | ------------------------------------------ |
| **private**  | Only the uploader             | Personal customer profiles, sensitive docs |
| **org_only** | All staff in the organization | Staff directory, service photos            |
| **public**   | Anyone with the link          | Published service images, portfolio        |

```typescript
async function getFileAccessLevel(
  tenantId: string,
  fileId: string,
  requesterId: string
) {
  const file = await db.query(
    `SELECT * FROM files WHERE id = $1 AND tenant_id = $2`,
    [fileId, tenantId]
  );

  if (!file) throw new ForbiddenError('File not found');

  // Private: only uploader
  if (
    file.visibility === 'private' &&
    file.uploaded_by_user_id !== requesterId
  ) {
    throw new ForbiddenError('Cannot access private file');
  }

  // Org-only: any staff in the organization
  if (file.visibility === 'org_only') {
    const isStaff = await isUserStaff(tenantId, requesterId);
    if (!isStaff) throw new ForbiddenError('Staff only');
  }

  // Public: anyone
  return file;
}
```

### File Versioning

```sql
-- Keep history of file updates
CREATE TABLE file_versions (
  id SERIAL PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  version_number INTEGER NOT NULL,

  s3_key VARCHAR NOT NULL, -- "tenant-123/uploads/abc-v2.jpg"
  file_size_bytes BIGINT NOT NULL,

  created_by_user_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,

  UNIQUE (file_id, version_number),
  INDEX (file_id, version_number DESC)
);
```

---

## Upload Workflow

### Step 1: Create Upload Session

```typescript
async function initiateUpload(
  tenantId: string,
  userId: string,
  fileName: string,
  fileSizeBytes: number
) {
  // Check quota
  const usage = await db.query(
    `SELECT SUM(file_size_bytes) as total_used
     FROM files WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId]
  );

  const quotaLimitBytes = 10 * 1024 * 1024 * 1024; // 10GB
  const available = quotaLimitBytes - (usage[0].total_used || 0);

  if (fileSizeBytes > available) {
    throw new QuotaExceededError(
      `Need ${fileSizeBytes} bytes, have ${available} available`
    );
  }

  // Generate S3 key
  const s3Key = `tenant-${tenantId}/uploads/${Date.now()}-${sanitizeFileName(
    fileName
  )}`;

  // Create upload session in DB (not committed yet)
  const session = await db.query(
    `
    INSERT INTO upload_sessions
    (tenant_id, uploaded_by_user_id, file_name, s3_key, file_size_bytes, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `,
    [tenantId, userId, fileName, s3Key, fileSizeBytes, 'pending']
  );

  // Generate presigned POST (for multipart upload)
  const presignedPost = await s3.createPresignedPost({
    Bucket: 'platform-storage',
    Key: s3Key,
    Fields: {
      'Content-Type': 'application/octet-stream',
      'x-amz-meta-tenant-id': tenantId,
      'x-amz-meta-session-id': session.id,
    },
    Expires: 300, // 5 minutes
    Conditions: [
      ['content-length-range', 0, fileSizeBytes],
      ['eq', '$Content-Type', 'application/octet-stream'],
    ],
  });

  return {
    uploadId: session.id,
    presignedPost: presignedPost,
    expiresIn: 300,
  };
}
```

### Step 2: Upload to S3 (Client-Side)

```typescript
// Client-side code (no sensitive data exposure)
async function uploadToS3(presignedPost: S3PresignedPost, file: File) {
  const formData = new FormData();

  // Add fields from presigned post
  Object.entries(presignedPost.fields).forEach(([key, value]) => {
    formData.append(key, value);
  });

  // Add the file
  formData.append('file', file);

  // Upload directly to S3
  const response = await fetch(presignedPost.url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) throw new Error('Upload failed');

  return response;
}
```

### Step 3: Finalize Upload

```typescript
async function finalizeUpload(tenantId: string, uploadId: string) {
  const session = await db.query(
    `SELECT * FROM upload_sessions WHERE id = $1 AND tenant_id = $2`,
    [uploadId, tenantId]
  );

  if (!session) throw new Error('Upload session not found');

  // Verify file exists in S3 (might have failed during upload)
  try {
    await s3.headObject({
      Bucket: 'platform-storage',
      Key: session.s3_key,
    });
  } catch (error) {
    throw new Error('File not found in S3');
  }

  // Create file record
  const file = await db.query(
    `
    INSERT INTO files
    (tenant_id, uploaded_by_user_id, file_name, s3_key, s3_bucket, file_size_bytes, mime_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `,
    [
      tenantId,
      session.uploaded_by_user_id,
      session.file_name,
      session.s3_key,
      'platform-storage',
      session.file_size_bytes,
      getMimeType(session.file_name),
    ]
  );

  // Mark session complete
  await db.query(
    `UPDATE upload_sessions SET status = 'completed' WHERE id = $1`,
    [uploadId]
  );

  return file;
}
```

---

## Secure File Serving

### Anti-Pattern: Direct S3 URLs

```typescript
// ✗ WRONG: Direct S3 URL exposes file to anyone with the link
const url = 'https://s3.amazonaws.com/platform-storage/tenant-123/doc.pdf';
// An attacker can enumerate tenant IDs and download files!
```

### Pattern: Presigned URLs with Validation

```typescript
async function getDownloadUrl(
  tenantId: string,
  fileId: string,
  requesterId: string
) {
  // Step 1: Validate access
  const file = await db.query(
    `SELECT * FROM files
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [fileId, tenantId]
  );

  if (!file) throw new ForbiddenError('File not found');

  // Step 2: Check visibility
  const hasAccess = await checkFileAccess(
    tenantId,
    fileId,
    requesterId,
    file.visibility
  );
  if (!hasAccess) throw new ForbiddenError('Access denied');

  // Step 3: Generate presigned URL (expires in 1 hour)
  const presignedUrl = await s3.getSignedUrl('getObject', {
    Bucket: 'platform-storage',
    Key: file.s3_key,
    Expires: 3600,
    ResponseContentDisposition: `attachment; filename="${file.file_name}"`,
  });

  // Step 4: Log access for audit
  await db.query(
    `
    INSERT INTO file_access_logs (tenant_id, file_id, accessed_by_user_id)
    VALUES ($1, $2, $3)
  `,
    [tenantId, fileId, requesterId]
  );

  return presignedUrl;
}
```

### Pattern: CDN with Cache Invalidation

```typescript
// For frequently accessed files (service images), use CloudFront

async function publishFileToPublic(tenantId: string, fileId: string) {
  const file = await db.query(
    `SELECT * FROM files WHERE id = $1 AND tenant_id = $2`,
    [fileId, tenantId]
  );

  // Update visibility
  await db.query(`UPDATE files SET visibility = 'public' WHERE id = $1`, [
    fileId,
  ]);

  // Cache on CDN (CloudFront)
  const cdnUrl = `https://cdn.example.com/files/${file.s3_key}`;

  return cdnUrl;
}

// When file is updated or deleted, invalidate CDN cache
async function deleteFile(tenantId: string, fileId: string) {
  const file = await db.query(
    `SELECT * FROM files WHERE id = $1 AND tenant_id = $2`,
    [fileId, tenantId]
  );

  // Soft delete
  await db.query(`UPDATE files SET deleted_at = NOW() WHERE id = $1`, [fileId]);

  // Invalidate CDN cache
  await cloudfront.createInvalidation({
    DistributionId: 'ABCDEF123456',
    InvalidationBatch: {
      Paths: {
        Quantity: 1,
        Items: [`/${file.s3_key}`],
      },
      CallerReference: Date.now().toString(),
    },
  });

  // Schedule hard delete (after cache TTL expires)
  await scheduleHardDelete(file.id, 3600); // 1 hour
}
```

---

## Quota Management

### Tracking Tenant Usage

```typescript
async function updateQuotaUsage(tenantId: string) {
  const usage = await db.query(
    `SELECT SUM(file_size_bytes) as total_used
     FROM files WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId]
  );

  const quotaLimitBytes = 10 * 1024 * 1024 * 1024; // 10GB
  const usedBytes = usage[0].total_used || 0;
  const percentageUsed = (usedBytes / quotaLimitBytes) * 100;

  // Update quota record
  await db.query(
    `
    INSERT INTO tenant_storage_quota (tenant_id, used_bytes, quota_limit_bytes, percentage_used)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id) DO UPDATE SET
      used_bytes = EXCLUDED.used_bytes,
      percentage_used = EXCLUDED.percentage_used,
      updated_at = NOW()
  `,
    [tenantId, usedBytes, quotaLimitBytes, percentageUsed]
  );

  // Alert tenant if 80% full
  if (percentageUsed > 80) {
    await sendNotification({
      tenantId: tenantId,
      eventType: 'storage_quota_warning',
      eventData: {
        percentageUsed,
        availableBytes: quotaLimitBytes - usedBytes,
      },
    });
  }
}
```

### Limiting Upload Size

```typescript
async function validateUploadSize(tenantId: string, fileSizeBytes: number) {
  const maxFileSize = 500 * 1024 * 1024; // 500MB per file

  if (fileSizeBytes > maxFileSize) {
    throw new FileTooLargeError(`Max file size is ${maxFileSize} bytes`);
  }

  // Check tenant quota
  const usage = await db.query(
    `SELECT SUM(file_size_bytes) as total_used
     FROM files WHERE tenant_id = $1 AND deleted_at IS NULL`,
    [tenantId]
  );

  const quotaLimitBytes = 10 * 1024 * 1024 * 1024; // 10GB
  const available = quotaLimitBytes - (usage[0].total_used || 0);

  if (fileSizeBytes > available) {
    throw new QuotaExceededError(
      `Storage quota exceeded. Need ${fileSizeBytes} bytes, have ${available} available`
    );
  }
}
```

---

## Cleanup & Retention

### Soft Delete Strategy

```sql
-- Files are soft-deleted (not immediately removed from S3)
UPDATE files SET deleted_at = NOW() WHERE id = 123;

-- Query still excludes deleted files
SELECT * FROM files WHERE tenant_id = 1 AND deleted_at IS NULL;

-- Retention policy: Hard delete after 30 days
DELETE FROM files WHERE deleted_at < NOW() - INTERVAL '30 days';
```

### Hard Delete & Secure Erasure

```typescript
async function hardDeleteFiles() {
  // Find files marked for deletion 30+ days ago
  const filesToDelete = await db.query(`
    SELECT * FROM files
    WHERE deleted_at < NOW() - INTERVAL '30 days'
  `);

  for (const file of filesToDelete) {
    try {
      // Delete from S3 (permanent)
      await s3.deleteObject({
        Bucket: file.s3_bucket,
        Key: file.s3_key,
      });

      // Delete from database
      await db.query(`DELETE FROM files WHERE id = $1`, [file.id]);

      // Log deletion (for audit/compliance)
      await db.query(
        `
        INSERT INTO file_deletion_audit (file_id, tenant_id, deleted_at)
        VALUES ($1, $2, NOW())
      `,
        [file.id, file.tenant_id]
      );
    } catch (error) {
      console.error(`Failed to delete file ${file.id}:`, error);
      // Continue processing other files
    }
  }
}

// Schedule hard delete job
schedule.every().day.at('02:00').do(hardDeleteFiles); // 2am daily
```

### Orphaned File Cleanup

```typescript
// Find files in DB but not in S3 (shouldn't exist, but check)
async function cleanupOrphanedRecords() {
  const files = await db.query('SELECT * FROM files WHERE deleted_at IS NULL');

  for (const file of files) {
    try {
      await s3.headObject({
        Bucket: file.s3_bucket,
        Key: file.s3_key,
      });
    } catch (error) {
      if (error.code === 'NotFound') {
        console.warn(`Orphaned file record: ${file.id} (not in S3)`);

        // Delete from DB
        await db.query(`DELETE FROM files WHERE id = $1`, [file.id]);
      }
    }
  }
}
```

---

## Summary

**Multi-Tenant File Upload Checklist:**

- [x] S3 keys include tenant_id
- [x] File metadata stored in database with tenant context
- [x] Tenant ownership validated before serving
- [x] Presigned URLs instead of direct S3 URLs
- [x] Visibility levels (private, org_only, public)
- [x] Per-tenant storage quota enforcement
- [x] Soft delete with 30-day grace period
- [x] Hard delete and secure erasure
- [x] Access audit logging
- [x] CDN cache invalidation

**Interview Points:**

1. "How do you prevent Tenant A from downloading Tenant B's files?" → S3 keys include tenant_id, validation on download
2. "Why presigned URLs?" → Expiration, fine-grained control, no direct S3 access
3. "Quota management?" → Calculate from database, enforce on upload, alert at 80%
4. "Secure deletion?" → Soft delete for 30 days, hard delete after grace period, log for compliance
5. "Performance at scale?" → CDN caching for public files, presigned URLs for private files

---

## Related Reading

- See [04-database-design/TENANT_SCOPED_QUERIES.md](../04-database-design/TENANT_SCOPED_QUERIES.md) for query patterns
- See [03-authorization-security/MULTI_TENANT_ISOLATION.md](../03-authorization-security/MULTI_TENANT_ISOLATION.md) for isolation rules
