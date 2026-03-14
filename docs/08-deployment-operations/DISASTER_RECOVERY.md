# Disaster Recovery & Business Continuity for Multi-Tenant SaaS

This document outlines backup strategies, disaster recovery procedures, business continuity planning, tenant data isolation during recovery, and testing protocols.

## Table of Contents

1. [Backup Strategy](#backup-strategy)
2. [Recovery Objectives (RTO/RPO)](#recovery-objectives-rtorpo)
3. [Restore Procedures](#restore-procedures)
4. [Business Continuity Planning](#business-continuity-planning)
5. [Tenant Data Isolation in Backups](#tenant-data-isolation-in-backups)
6. [Testing Recovery Procedures](#testing-recovery-procedures)
7. [Incident Response & Failover](#incident-response--failover)

---

## Backup Strategy

### Multi-Layered Backup Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Production Environment                      │
│                                                              │
│  ┌──────────────┐     ┌──────────────┐    ┌─────────────┐  │
│  │  PostgreSQL  │────▶│ Binary WAL    │───▶│ S3 Bucket   │  │
│  │  (Primary)   │     │ Archive       │    │ (Backup)    │  │
│  └──────────────┘     └──────────────┘    └─────────────┘  │
│        │                                            △        │
│        │ Streaming replication                      │        │
│        ▼                                            │        │
│  ┌──────────────┐                                   │        │
│  │  PostgreSQL  │                                   │        │
│  │  (Replica)   │                                   │        │
│  │  Standby     │───────────────────────────────────┘        │
│  └──────────────┘ Point-in-time recovery                    │
│        │                                                     │
│        │ Snapshots every 6 hours                            │
│        ▼                                                     │
│  ┌──────────────┐                                           │
│  │ EBS Snapshots│                                           │
│  │ to S3        │                                           │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

### Backup Types

#### 1. Full Database Backup (Daily)

```bash
# Schedule: 02:00 UTC (low-traffic period)
# Frequency: Daily
# Retention: 30 days

#!/bin/bash
DATE=$(date +%Y%m%d)
BACKUP_FILE="backup_${DATE}.sql.gz"

# Create full backup
docker exec donebyme_postgres pg_dump \
  -U donebyme_user \
  -d donebyme_booking \
  --no-password \
  | gzip > /backups/${BACKUP_FILE}

# Upload to S3
aws s3 cp /backups/${BACKUP_FILE} \
  s3://donebyme-backups/daily/${BACKUP_FILE}

# Verify backup integrity
echo "Backup: ${BACKUP_FILE}"
ls -lh /backups/${BACKUP_FILE}
```

#### 2. Binary WAL Archive (Continuous)

```sql
-- PostgreSQL configuration for WAL archiving
-- postgresql.conf

wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://donebyme-backups/wal/%f'
archive_timeout = 300  # Archive every 5 minutes if no activity

-- Check WAL archive status
SELECT
  name as wal_filename,
  setting,
  pg_ls_dir('pg_wal') as current_wal_files
FROM pg_settings
WHERE name LIKE '%archive%' OR name LIKE '%wal%';
```

#### 3. Snapshots (6-Hourly)

```bash
#!/bin/bash
# EBS snapshot every 6 hours

for VOLUME_ID in vol-xxxxx vol-yyyyy vol-zzzzz; do
  aws ec2 create-snapshot \
    --volume-id ${VOLUME_ID} \
    --description "Backup-$(date +%Y%m%d-%H%M%S)" \
    --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Backup,Value=donebyme},{Key=RetentionDays,Value=7}]'
done

# Tag old snapshots for deletion (retention 7 days)
CUTOFF_DATE=$(date -d '7 days ago' +%Y-%m-%d)

aws ec2 describe-snapshots \
  --owner-ids self \
  --filters "Name=start-time,Values=${CUTOFF_DATE}" \
  --query 'Snapshots[].SnapshotId' \
  --output text | xargs -I {} aws ec2 delete-snapshot --snapshot-id {}
```

#### 4. Application State Exports (Weekly)

```typescript
// Export critical tenant metadata for recovery
async function exportTenantMetadata() {
  const tenants = await db.query(`
    SELECT id, name, subscription_plan, created_at,
           stripe_customer_id, google_oauth_id
    FROM tenants
    WHERE deleted_at IS NULL
  `);

  const filename = `tenant-metadata-${
    new Date().toISOString().split('T')[0]
  }.json.gz`;
  const zipped = gzip(JSON.stringify(tenants));

  await s3.putObject({
    Bucket: 'donebyme-backups',
    Key: `metadata/${filename}`,
    Body: zipped,
  });

  console.log(`Exported metadata for ${tenants.length} tenants`);
}
```

### Backup Verification

```bash
# Weekly backup integrity test
#!/bin/bash

LATEST_BACKUP=$(aws s3 ls s3://donebyme-backups/daily/ --recursive \
  --sort=date --reverse | head -1 | awk '{print $4}')

# Download backup
aws s3 cp s3://donebyme-backups/${LATEST_BACKUP} /tmp/backup.sql.gz

# Extract and test restore (in temporary container)
gunzip /tmp/backup.sql.gz

docker run --rm \
  -v /tmp:/tmp \
  postgres:15 \
  psql -h localhost -U test_user -d test_db -f /tmp/backup.sql

# If successful
echo "✓ Backup verified successfully"
```

---

## Recovery Objectives (RTO/RPO)

### Service Level Targets

```
┌─────────────────────────┬──────────────┬──────────────┐
│ Scenario                │ RTO (Recovery Time) │ RPO (Recovery Point) │
├─────────────────────────┼──────────────┼──────────────┤
│ Single row corruption   │ < 1 hour     │ < 5 minutes  │
│ Tenant data loss        │ < 4 hours    │ < 30 min     │
│ Regional outage         │ < 2 hours    │ < 15 min     │
│ Complete site failure   │ < 6 hours    │ < 1 hour     │
│ Ransomware/sabotage     │ < 8 hours    │ < 2 hours    │
└─────────────────────────┴──────────────┴──────────────┘

RTO = Recovery Time Objective (how quickly can we restore)
RPO = Recovery Point Objective (how much data can we lose)
```

### Infrastructure to Support RTO/RPO

| Target               | Infrastructure                                 |
| -------------------- | ---------------------------------------------- |
| **RTO < 1 hour**     | Hot standby ready (replica synced)             |
| **RPO < 5 minutes**  | WAL archive + continuous streaming replication |
| **RTO < 2 hours**    | Multi-region failover with DNS auto-switch     |
| **RPO < 15 minutes** | Real-time replication to secondary region      |

---

## Restore Procedures

### Scenario 1: Restore Single Tenant Data

**Problem**: Tenant accidentally deleted all their bookings

**Recovery Steps**:

```bash
#!/bin/bash
TENANT_ID="acme-corp"
RESTORE_DATE="2025-02-14 10:00:00"

# 1. Create recovery database
createdb -U postgres recovery_donebyme_booking_${TENANT_ID}

# 2. Restore from backup using point-in-time recovery
pg_restore \
  --dbname=recovery_donebyme_booking_${TENANT_ID} \
  --data-only \
  --restore-before-timestamp="${RESTORE_DATE}" \
  backup_latest.sql.gz

# 3. Extract only this tenant's data
pg_dump \
  --dbname=recovery_donebyme_booking_${TENANT_ID} \
  --data-only \
  --where "tenant_id = '${TENANT_ID}'" \
  > tenant_recovery.sql

# 4. Restore into production (in transaction)
psql -d donebyme_booking -v "ON_ERROR_STOP=1" << EOF
BEGIN TRANSACTION;

-- Verify tenant exists
SELECT id FROM tenants WHERE id = '${TENANT_ID}' FOR UPDATE;

-- Restore bookings
\i tenant_recovery.sql

-- Verify restoration
SELECT COUNT(*) FROM bookings WHERE tenant_id = '${TENANT_ID}';

-- If successful, commit. Otherwise rollback.
COMMIT;
EOF

# 5. Notify tenant
echo "Tenant ${TENANT_ID} data restored from ${RESTORE_DATE}"
```

### Scenario 2: Regional Failover

**Problem**: Primary region (us-east-1) experiences catastrophic failure

**Recovery Steps**:

```bash
#!/bin/bash

echo "=== STARTING REGIONAL FAILOVER ==="

# 1. Promote read replica to primary (eu-west-1)
aws rds promote-read-replica \
  --db-instance-identifier donebyme-eu-replica \
  --backup-retention-period 30

echo "✓ Promoted EU replica to primary"

# 2. Update DNS to point to new region
aws route53 change-resource-record-sets \
  --hosted-zone-id Z123EXAMPLE \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.donebyme.com",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{"Value": "EU-API-IP"}]
      }
    }]
  }'

echo "✓ DNS updated to EU region"

# 3. Deploy API to EU region
aws ecs update-service \
  --cluster donebyme-eu \
  --service donebyme-api \
  --desired-count 10

echo "✓ Scaling EU API instances"

# 4. Verify health
sleep 30
curl https://api.donebyme.com/health

echo "=== FAILOVER COMPLETE ==="
```

### Scenario 3: Complete Database Restore

**Problem**: Data corruption detected across entire database

**Recovery Steps** (PRODUCTION CRITICAL):

```bash
#!/bin/bash

# Pre-restore checklist
echo "Validating restore environment..."
[ -f backup_latest.sql.gz ] || { echo "Backup not found"; exit 1; }

# 1. Stop all applications
docker compose -f docker-compose.prod.yml down
echo "✓ All services stopped"

# 2. Rename current database (preserve for forensics)
psql -U postgres -c "ALTER DATABASE donebyme_booking RENAME TO donebyme_booking_corrupted;"
echo "✓ Current database preserved"

# 3. Create fresh database
createdb -U postgres -O donebyme_user donebyme_booking
echo "✓ New database created"

# 4. Restore from backup
gunzip -c backup_latest.sql.gz | psql -U donebyme_user -d donebyme_booking
echo "✓ Database restored"

# 5. Verify restoration
psql -U donebyme_user -d donebyme_booking -c "
  SELECT
    'tenants' as table_name,
    COUNT(*) as row_count
  FROM tenants
  WHERE deleted_at IS NULL
  UNION ALL
  SELECT 'bookings', COUNT(*) FROM bookings WHERE deleted_at IS NULL
  UNION ALL
  SELECT 'users', COUNT(*) FROM users WHERE deleted_at IS NULL;
"

# 6. Run integrity checks
./scripts/verify-database-integrity.sh

# 7. Restart services
docker compose -f docker-compose.prod.yml up -d
echo "✓ Services restarted"

# 8. Health check
sleep 30
curl https://api.donebyme.com/health || { echo "Health check failed"; exit 1; }

echo "=== RESTORE COMPLETE ==="
```

---

## Business Continuity Planning

### Failover Decision Tree

```
┌─────────────────────────────────────┐
│   Service Degradation Detected      │
└────────────┬────────────────────────┘
             │
    ┌────────▼──────────┐
    │ Severity Level?   │
    └┬───────────────┬──┴────────────┐
     │               │               │
   LOW            MEDIUM           HIGH
   (~1%)          (~5%)            (>10%)
     │               │               │
     │           ┌────▼────┐        │
     │           │ Try fix │        │
     │           │in place │        │
     │           └────┬────┘        │
     │                │             │
     │         ┌──────▼──────┐      │
     │         │ Fixed?      │      │
     │         └┬────────┬───┘      │
     │          YES     NO          │
     │           │       │          │
     │           │   ┌───▼──────┐   │
     │           │   │ Failover │   │
     │           │   └──────────┘   │
     │           │                  │
     └───────────┼──────┬───────────┘
                 │      │
            ┌────▼──────▼────┐
            │  Monitor/Log   │
            │   Recovery     │
            └────────────────┘
```

### RTO Roadmap

```
T+0:00    Alert fired → Page on-call engineer
T+0:05    Engineer ACKs → Begins investigation
T+0:15    Issue identified:
          ├─ Service failure      → Restart service
          ├─ Single tenant issue  → Isolate & recover
          ├─ Regional failure     → Activate failover
          └─ Data corruption      → Run restore procedure
T+0:30    Remediation complete
T+1:00    All systems nominal, incident declared over
T+24h     RCA (root cause analysis) published
T+72h     Preventive measures implemented
```

---

## Tenant Data Isolation in Backups

### Secure Backup Handling

**Requirement**: Backup files must NOT expose data across tenants.

```sql
-- Verify no cross-tenant data leakage in restore testing
-- Run after restore to ensure data integrity

-- 1. Verify tenant isolation (no leaked records)
SELECT tenant_id, COUNT(*) as record_count
FROM bookings
GROUP BY tenant_id
ORDER BY record_count DESC;

-- 2. Check for orphaned records (booking without tenant)
SELECT COUNT(*) as orphaned_records
FROM bookings
WHERE tenant_id IS NULL OR tenant_id = '';

-- 3. Verify deleted_at flags respected
SELECT COUNT(*) as soft_deleted_records
FROM bookings
WHERE deleted_at IS NOT NULL;

-- 4. Validate referential integrity
SELECT COUNT(*) as dangling_bookings
FROM bookings b
WHERE NOT EXISTS (
  SELECT 1 FROM tenants t WHERE t.id = b.tenant_id
);
```

### Backup Encryption

```bash
# Always encrypt backups at rest
aws s3api put-bucket-encryption \
  --bucket donebyme-backups \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Encrypt backups in transit
export AWS_S3_TRANSFER_CONFIG='{"max_bandwidth": null, "max_in_memory_upload_chunks": 10, "max_io_queue_size": 1000}'

# For regulatory compliance (HIPAA, GDPR), use KMS encryption
aws s3api put-bucket-encryption \
  --bucket donebyme-backups \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "arn:aws:kms:us-east-1:ACCOUNT:key/KEY-ID"
      }
    }]
  }'
```

### Backup Access Controls

```bash
# Restrict backup access to minimal set of people
aws iam create-policy \
  --policy-name RestrictBackupAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::donebyme-backups/*",
      "Condition": {
        "StringNotLike": {
          "aws:SourceArn": [
            "arn:aws:iam::ACCOUNT:role/DRAdministrator",
            "arn:aws:iam::ACCOUNT:role/BackupService"
          ]
        }
      }
    }]
  }'

# Audit backup access
aws s3api get-bucket-logging \
  --bucket donebyme-backups
```

---

## Testing Recovery Procedures

### Monthly DR Drill

```bash
#!/bin/bash
# Run monthly to ensure recovery procedures are effective

set -e  # Exit on error

echo "=== MONTHLY DISASTER RECOVERY DRILL ==="

# 1. Restore to test environment (isolated)
echo "Test Phase 1: Create recovery database..."
createdb -U postgres test_recovery_$(date +%s)

# 2. Restore latest backup
echo "Test Phase 2: Restore from backup..."
LATEST_BACKUP=$(aws s3 ls s3://donebyme-backups/daily/ --recursive \
  --sort=date --reverse | head -1 | awk '{print $4}')

aws s3 cp s3://donebyme-backups/${LATEST_BACKUP} /tmp/backup.sql.gz

gunzip -c /tmp/backup.sql.gz | \
  psql -U donebyme_user -d test_recovery -v "ON_ERROR_STOP=1"

# 3. Validate data integrity
echo "Test Phase 3: Validate data integrity..."

psql -U donebyme_user -d test_recovery -c "
  BEGIN;

  -- Check row counts
  SELECT COUNT(*) as tenants FROM tenants;
  SELECT COUNT(*) as bookings FROM bookings;
  SELECT COUNT(*) as users FROM users;

  -- Check for corruption
  SELECT COUNT(*) as issues
  FROM bookings b
  WHERE tenant_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM tenants t WHERE t.id = b.tenant_id
  );

  -- Check data freshness (backup age)
  SELECT MAX(updated_at) as latest_update FROM bookings;

  COMMIT;
"

# 4. Simulate user queries
echo "Test Phase 4: Run sample queries..."
psql -U donebyme_user -d test_recovery -f ./scripts/validation-queries.sql

# 5. Clean up test database
echo "Test Phase 5: Cleanup..."
dropdb -U postgres test_recovery_$(date +%s)

echo "=== DRILL COMPLETE ==="

# Report
echo "DR Drill: PASSED at $(date)"
echo "Backup Age: ${LATEST_BACKUP}"
echo "Estimated Recovery Time: 45 minutes"
```

### Quarterly Full Failover Test

```bash
#!/bin/bash

# Test complete failover to secondary region (don't cut off primary)

echo "=== QUARTERLY FAILOVER TEST ==="

# 1. Temporarily promote EU replica (read-only)
aws rds modify-db-instance \
  --db-instance-identifier donebyme-eu-replica \
  --enable-iam-database-authentication \
  --multi-az

# 2. Redirect 5% of traffic to EU (canary)
aws route53 change-resource-record-sets \
  --hosted-zone-id Z123EXAMPLE \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.donebyme.com",
        "Type": "A",
        "SetIdentifier": "Primary-US",
        "TrafficPolicy": {"Percent": 95},
        "ResourceRecords": [{"Value": "US-API-IP"}]
      }
    }, {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.donebyme.com",
        "Type": "A",
        "SetIdentifier": "Secondary-EU",
        "TrafficPolicy": {"Percent": 5},
        "ResourceRecords": [{"Value": "EU-API-IP"}]
      }
    }]
  }'

# 3. Monitor for 30 minutes
sleep 1800

# 4. Check error rates
ERROR_RATE=$(curl -s https://prometheus.donebyme.com/api/v1/query \
  --data-urlencode 'query=rate(http_requests_total{status=~"5.."}[5m])' \
  | jq '.data.result[0].value[1]')

if [ $(echo "$ERROR_RATE > 0.01" | bc -l) -eq 1 ]; then
  echo "ERROR: Error rate elevated during failover test"
  # Roll back
fi

# 5. Revert to primary-only
aws route53 change-resource-record-sets \
  --hosted-zone-id Z123EXAMPLE \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.donebyme.com",
        "Type": "A",
        "ResourceRecords": [{"Value": "US-API-IP"}]
      }
    }]
  }'

echo "=== FAILOVER TEST COMPLETE ==="
```

---

## Incident Response & Failover

### Failover Runbook

```markdown
# RUNBOOK: REGIONAL FAILOVER

## Trigger Criteria

- Primary region (us-east-1) experiencing 10+ min downtime
- 50%+ API error rate
- Database connectivity lost to 3+ instances

## STEP 1: Assessment (5 min)

- [ ] Verify primary region genuinely down (not DNS cache)
- [ ] Check AWS Health Dashboard for service events
- [ ] Confirm replica is synced and healthy
- [ ] Assess data loss (check replication lag)

## STEP 2: Preparation (10 min)

- [ ] Notify stakeholders
- [ ] Verify secondary region capacity
- [ ] Pre-stage replacement DNS records
- [ ] Alert monitoring to secondary region

## STEP 3: Execution (15 min)

- [ ] Promote read replica to primary
- [ ] Update Route53 DNS (5 min propagation)
- [ ] Deploy API to secondary region
- [ ] Update CI/CD to deploy to secondary
- [ ] Verify health checks

## STEP 4: Verification (10 min)

- [ ] Test API endpoints
- [ ] Check application logs for errors
- [ ] Verify customer traffic flowing
- [ ] Monitor error rates for 10 minutes

## STEP 5: Stabilization (ongoing)

- [ ] Scale secondary region if needed
- [ ] Monitor replication (if recovering primary)
- [ ] Adjust TTLs for faster recovery
- [ ] Maintain incident channel

## STEP 6: Recovery (post-incident)

- [ ] Restore primary region (rebuild from scratch if needed)
- [ ] Re-sync replica
- [ ] Test failback (don't execute yet)
- [ ] Conduct RCA meeting
```

---

## Summary

| Aspect               | Pattern                                            |
| -------------------- | -------------------------------------------------- |
| **Backup Frequency** | Full daily + hourly WAL + 6-hourly snapshots       |
| **Retention**        | Daily (30 days), WAL (7 days), Snapshots (7 days)  |
| **RTO**              | < 2 hours for most scenarios                       |
| **RPO**              | < 15 minutes (WAL streaming)                       |
| **Testing**          | Monthly drill + quarterly failover test            |
| **Encryption**       | AES256 at rest, TLS in transit                     |
| **Isolation**        | Tenant data verified in backups, access restricted |

---

## References

- [PostgreSQL Backup & Restore](https://www.postgresql.org/docs/current/backup.html)
- [AWS RDS Backup & Restore](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/BackupRestoreOverview.html)
- [Disaster Recovery Planning](https://en.wikipedia.org/wiki/Disaster_recovery)
- [Business Continuity Best Practices](https://www.bcp.gov/)
