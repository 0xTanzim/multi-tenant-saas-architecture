# Portfolio Note

> Extracted from production system, sanitized for portfolio use.

---

# PostGIS & Maps Setup Guide

**Version:** 1.0
**Last Updated:** November 26, 2025
**Status:** Production Ready
**Author:** the Platform Platform Team

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Docker Setup](#docker-setup)
4. [PostGIS Configuration](#postgis-configuration)
5. [Google Maps API Setup](#google-maps-api-setup)
6. [Environment Variables](#environment-variables)
7. [Database Setup Scripts](#database-setup-scripts)
8. [Verification & Testing](#verification--testing)
9. [Troubleshooting](#troubleshooting)

---

## Overview

This guide covers the complete setup for geolocation features in the Platform:

| Component                  | Purpose                                              | Cost              |
| -------------------------- | ---------------------------------------------------- | ----------------- |
| **PostGIS**                | Spatial queries, distance calculation, nearby search | FREE              |
| **Google Geocoding API**   | Address to Coordinates                               | $5/1000 requests  |
| **Google Distance Matrix** | Driving distance & time                              | $5/1000 elements  |
| **Google Places API**      | Address autocomplete (future)                        | $17/1000 requests |

**Strategy:** Use PostGIS for everything possible (FREE), only call Google APIs when necessary.

---

## Prerequisites

### Required Software

```bash
# Check Docker is installed
docker --version  # Docker version 24.0.0 or higher

# Check Docker Compose
docker compose version  # v2.20.0 or higher

# Check pnpm
pnpm --version  # 8.0.0 or higher
```

### Required API Keys

- [ ] Google Cloud Platform account
- [ ] Google Maps API key with Geocoding & Distance Matrix enabled
- [ ] Billing enabled on GCP (required even for free tier)

---

## Docker Setup

### PostGIS is Already Enabled

Your `docker-compose.yml` already uses the PostGIS image:

```yaml
services:
  postgres:
    image: postgis/postgis:latest
    container_name: the platform_postgres
    environment:
      POSTGRES_DB: the platform_booking
      POSTGRES_USER: the platform_user
      POSTGRES_PASSWORD: the platform_pass_2025
    ports:
      - '5432:5432'
```

### Start the Database

```bash
# Start all services
docker compose up -d

# Verify PostgreSQL is running
docker compose ps

# Check PostGIS is available
docker exec the platform_postgres psql -U the platform_user -d the platform_booking -c "SELECT PostGIS_Version();"
```

**Expected Output:**

```
            postgis_version
---------------------------------------
 3.4 USE_GEOS=1 USE_PROJ=1 USE_STATS=1
(1 row)
```

### If You Need to Rebuild

```bash
# Stop and remove containers
docker compose down

# Remove volumes (WARNING: deletes data!)
docker compose down -v

# Rebuild with fresh PostGIS
docker compose up -d --build
```

---

## PostGIS Configuration

### Step 1: Enable Extensions

Run this SQL to enable required extensions:

```sql
-- Enable PostGIS (spatial functions)
CREATE EXTENSION IF NOT EXISTS postgis;

-- Enable PostGIS Topology (advanced spatial)
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- Enable pg_trgm (fuzzy text search for autocomplete)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Verify extensions
SELECT extname, extversion FROM pg_extension;
```

### Step 2: Run via Terminal

```bash
# Run extensions setup
docker exec -i the platform_postgres psql -U the platform_user -d the platform_booking << 'EOF'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SELECT extname, extversion FROM pg_extension WHERE extname LIKE 'postgis%' OR extname = 'pg_trgm';
EOF
```

### Step 3: Verify PostGIS Functions

```bash
docker exec the platform_postgres psql -U the platform_user -d the platform_booking -c "
SELECT
  PostGIS_Full_Version() as postgis_full,
  ST_AsText(ST_MakePoint(-73.9857, 40.7484)) as sample_point;
"
```

---

## Google Maps API Setup

### Step 1: Create GCP Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new project: `the platform-maps`
3. Enable billing (required for API access)

### Step 2: Enable APIs

Enable these APIs in your GCP project:

| API                 | URL                                                                                            | Purpose                |
| ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| Geocoding API       | [Enable](https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com)       | Address to Coordinates |
| Distance Matrix API | [Enable](https://console.cloud.google.com/apis/library/distance-matrix-backend.googleapis.com) | Driving distance/time  |
| Places API          | [Enable](https://console.cloud.google.com/apis/library/places-backend.googleapis.com)          | Autocomplete (future)  |
| Maps JavaScript API | [Enable](https://console.cloud.google.com/apis/library/maps-backend.googleapis.com)            | Frontend maps          |

### Step 3: Create API Key

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **API Key**
3. Restrict the key:
   - **Application restrictions:** HTTP referrers (for frontend)
   - **API restrictions:** Select only the APIs above

### Step 4: Set Up Key Restrictions

```
# For Backend (Server Key)
Application restrictions: IP addresses
Add your server IPs:
  - 127.0.0.1 (development)
  - Your production server IP

# For Frontend (Browser Key)
Application restrictions: HTTP referrers
Add your domains:
  - localhost:3000/*
  - localhost:5173/*
  - yourdomain.com/*
```

### Step 5: Set Budget Alerts

1. Go to **Billing** > **Budgets & alerts**
2. Create budget: $50/month (recommended for development)
3. Set alerts at 50%, 80%, 100%

---

## Environment Variables

### Backend Environment (apps/api/.env)

```bash
# ==============================================
# GOOGLE MAPS CONFIGURATION
# ==============================================

# API Key (Server-side - restricted by IP)
GOOGLE_MAPS_API_KEY=AIzaSy...your-api-key...

# API Endpoints (don't change unless using proxy)
GOOGLE_MAPS_GEOCODING_URL=https://maps.googleapis.com/maps/api/geocode/json
GOOGLE_MAPS_DISTANCE_MATRIX_URL=https://maps.googleapis.com/maps/api/distancematrix/json
GOOGLE_MAPS_PLACES_URL=https://maps.googleapis.com/maps/api/place

# Rate Limiting (requests per tenant per hour)
GOOGLE_MAPS_RATE_LIMIT_GEOCODE=100
GOOGLE_MAPS_RATE_LIMIT_DISTANCE=200

# Cache TTL (in seconds)
GOOGLE_MAPS_CACHE_TTL_GEOCODE=0          # Forever (addresses don't change)
GOOGLE_MAPS_CACHE_TTL_DISTANCE=2592000   # 30 days

# Default Search Settings
MAPS_DEFAULT_SEARCH_RADIUS_KM=10
MAPS_MAX_SEARCH_RADIUS_KM=50
MAPS_DEFAULT_SEARCH_LIMIT=20

# ==============================================
# POSTGIS CONFIGURATION
# ==============================================

# SRID for coordinates (don't change)
POSTGIS_SRID=4326

# Distance calculation precision
POSTGIS_DISTANCE_PRECISION=2  # decimal places
```

### Frontend Environment (apps/web/.env)

```bash
# Google Maps for frontend (Browser key - restricted by domain)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSy...your-browser-api-key...

# Map defaults
NEXT_PUBLIC_DEFAULT_MAP_CENTER_LAT=55.6761
NEXT_PUBLIC_DEFAULT_MAP_CENTER_LNG=12.5683
NEXT_PUBLIC_DEFAULT_MAP_ZOOM=12
```

### Validation Schema (Zod)

```typescript
// packages/core/src/config/maps.config.ts

import { z } from 'zod';

export const mapsConfigSchema = z.object({
  GOOGLE_MAPS_API_KEY: z.string().min(1, 'Google Maps API key is required'),
  GOOGLE_MAPS_RATE_LIMIT_GEOCODE: z.coerce.number().default(100),
  GOOGLE_MAPS_RATE_LIMIT_DISTANCE: z.coerce.number().default(200),
  GOOGLE_MAPS_CACHE_TTL_GEOCODE: z.coerce.number().default(0),
  GOOGLE_MAPS_CACHE_TTL_DISTANCE: z.coerce.number().default(2592000),
  MAPS_DEFAULT_SEARCH_RADIUS_KM: z.coerce.number().default(10),
  MAPS_MAX_SEARCH_RADIUS_KM: z.coerce.number().default(50),
});

export type MapsConfig = z.infer<typeof mapsConfigSchema>;
```

---

## Database Setup Scripts

### Master Setup Script

```typescript
// packages/db/src/scripts/setup-maps.ts

import { sql } from 'drizzle-orm';
import { db } from '../index';

/**
 * Maps infrastructure setup
 *
 * Run with: pnpm --filter @the platform/db run setup:maps
 */
export async function setupMapsInfrastructure() {
  console.log('\nSetting up Maps infrastructure...\n');

  try {
    // Step 1: Enable Extensions
    console.log('Step 1: Enabling PostgreSQL extensions...');

    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS postgis`);
    console.log('   PostGIS enabled');

    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS postgis_topology`);
    console.log('   PostGIS Topology enabled');

    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    console.log('   pg_trgm (trigram) enabled');

    // Step 2: Add Geography Column to Tenants
    console.log('\nStep 2: Adding geography column to tenants...');

    await db.execute(sql`
      ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS location geography(POINT, 4326)
    `);
    console.log('   Geography column added');

    // Step 3: Create Spatial Index
    console.log('\nStep 3: Creating spatial index...');

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_tenants_location_gist
      ON tenants USING GIST (location)
    `);
    console.log('   Spatial index created');

    // Step 4: Create Trigger Function
    console.log('\nStep 4: Creating trigger function...');

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION update_tenant_location()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
          NEW.location := ST_SetSRID(
            ST_MakePoint(NEW.longitude, NEW.latitude),
            4326
          )::geography;
        ELSE
          NEW.location := NULL;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    console.log('   Trigger function created');

    // Step 5: Create Trigger
    console.log('\nStep 5: Creating auto-update trigger...');

    await db.execute(sql`
      DROP TRIGGER IF EXISTS trigger_update_tenant_location ON tenants;

      CREATE TRIGGER trigger_update_tenant_location
        BEFORE INSERT OR UPDATE OF latitude, longitude ON tenants
        FOR EACH ROW
        EXECUTE FUNCTION update_tenant_location();
    `);
    console.log('   Trigger created');

    // Step 6: Create Geocoding Cache Table
    console.log('\nStep 6: Creating geocoding cache table...');

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS geocoded_addresses (
        id SERIAL PRIMARY KEY,

        -- Address Details
        address_text TEXT NOT NULL,
        normalized_address TEXT,

        -- Coordinates
        latitude DECIMAL(10, 8) NOT NULL,
        longitude DECIMAL(11, 8) NOT NULL,
        location GEOGRAPHY(POINT, 4326),

        -- Google Place Data
        place_id VARCHAR(255),
        place_type VARCHAR(50),
        location_type VARCHAR(50),

        -- Usage Tracking
        hit_count INTEGER DEFAULT 0,
        last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

        -- Unique constraint
        CONSTRAINT uq_geocoded_address UNIQUE (normalized_address)
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_geocoded_addresses_text
        ON geocoded_addresses USING gin(to_tsvector('english', address_text));
      CREATE INDEX IF NOT EXISTS idx_geocoded_addresses_location
        ON geocoded_addresses USING GIST(location);
      CREATE INDEX IF NOT EXISTS idx_geocoded_place_id
        ON geocoded_addresses(place_id);
    `);
    console.log('   Geocoding cache table created');

    // Step 7: Create Distance Cache Table
    console.log('\nStep 7: Creating distance cache table...');

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS distance_cache (
        id SERIAL PRIMARY KEY,

        -- Origin & Destination
        origin_latitude DECIMAL(10, 8) NOT NULL,
        origin_longitude DECIMAL(11, 8) NOT NULL,
        destination_latitude DECIMAL(10, 8) NOT NULL,
        destination_longitude DECIMAL(11, 8) NOT NULL,

        -- Optional tenant links
        origin_tenant_id INTEGER REFERENCES tenants(id),
        destination_tenant_id INTEGER REFERENCES tenants(id),

        -- Distance Data
        distance_meters INTEGER NOT NULL,
        distance_km DECIMAL(10, 2) NOT NULL,
        duration_seconds INTEGER NOT NULL,
        duration_minutes INTEGER NOT NULL,

        -- Traffic Data
        duration_in_traffic_seconds INTEGER,
        traffic_condition VARCHAR(50),

        -- Route Data
        polyline TEXT,
        travel_mode VARCHAR(20) DEFAULT 'driving',

        -- Cache Expiry
        expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '30 days',

        -- Usage Tracking
        hit_count INTEGER DEFAULT 0,
        last_accessed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

        -- Unique constraint
        CONSTRAINT uq_distance_cache UNIQUE (
          origin_latitude, origin_longitude,
          destination_latitude, destination_longitude,
          travel_mode
        )
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_distance_cache_origin
        ON distance_cache(origin_latitude, origin_longitude);
      CREATE INDEX IF NOT EXISTS idx_distance_cache_destination
        ON distance_cache(destination_latitude, destination_longitude);
      CREATE INDEX IF NOT EXISTS idx_distance_cache_expires
        ON distance_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_distance_cache_tenants
        ON distance_cache(origin_tenant_id, destination_tenant_id);
    `);
    console.log('   Distance cache table created');

    // Step 8: Create Full-Text Search Index
    console.log('\nStep 8: Creating full-text search index...');

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_tenants_fulltext_search
      ON tenants USING GIN (
        to_tsvector('english',
          COALESCE(name, '') || ' ' ||
          COALESCE(description, '') || ' ' ||
          COALESCE(address_line1, '') || ' ' ||
          COALESCE(city, '')
        )
      )
    `);
    console.log('   Full-text search index created');

    // Step 9: Create Trigram Index for Autocomplete
    console.log('\nStep 9: Creating trigram index for autocomplete...');

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_tenants_name_trgm
      ON tenants USING GIN (name gin_trgm_ops)
    `);
    console.log('   Trigram index created');

    // Step 10: Backfill Existing Data
    console.log('\nStep 10: Backfilling existing tenant locations...');

    const result = await db.execute(sql`
      UPDATE tenants
      SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND location IS NULL
    `);
    console.log(`   Backfilled ${result.rowCount || 0} tenants`);

    // Verification
    console.log('\nVerifying setup...');

    const postgisVersion = await db.execute(
      sql`SELECT PostGIS_Version() as version`,
    );
    console.log(`   PostGIS Version: ${postgisVersion.rows[0].version}`);

    const extensions = await db.execute(sql`
      SELECT extname FROM pg_extension
      WHERE extname IN ('postgis', 'postgis_topology', 'pg_trgm')
    `);
    console.log(
      `   Extensions: ${extensions.rows.map((r) => r.extname).join(', ')}`,
    );

    console.log('\nMaps infrastructure setup complete!\n');
    console.log('Summary:');
    console.log('   - PostGIS extensions enabled');
    console.log('   - Geography column added to tenants');
    console.log('   - Spatial index created');
    console.log('   - Auto-update trigger installed');
    console.log('   - Geocoding cache table ready');
    console.log('   - Distance cache table ready');
    console.log('   - Full-text search enabled');
    console.log('   - Trigram autocomplete ready');

    return { success: true };
  } catch (error) {
    console.error('\nMaps setup failed:', error);
    return { success: false, error };
  }
}

// Run if called directly
if (require.main === module) {
  setupMapsInfrastructure()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
```

### Add to package.json

```json
// packages/db/package.json
{
  "scripts": {
    "setup:maps": "tsx src/scripts/setup-maps.ts"
  }
}
```

### Run the Setup

```bash
# From project root
pnpm --filter @the platform/db run setup:maps
```

---

## Verification & Testing

### Test PostGIS Functions

```bash
# Connect to database
docker exec -it the platform_postgres psql -U the platform_user -d the platform_booking

# Test point creation
SELECT ST_AsText(ST_MakePoint(-73.9857, 40.7484));
-- POINT(-73.9857 40.7484)

# Test distance calculation (NYC to LA in km)
SELECT ST_Distance(
  ST_SetSRID(ST_MakePoint(-73.9857, 40.7484), 4326)::geography,
  ST_SetSRID(ST_MakePoint(-118.2437, 34.0522), 4326)::geography
) / 1000 AS distance_km;
-- ~3940 km

# Test nearby search (find tenants within 5km)
SELECT id, name,
  ST_Distance(
    location::geography,
    ST_SetSRID(ST_MakePoint(-73.9857, 40.7484), 4326)::geography
  ) / 1000 AS distance_km
FROM tenants
WHERE ST_DWithin(
  location::geography,
  ST_SetSRID(ST_MakePoint(-73.9857, 40.7484), 4326)::geography,
  5000  -- 5km in meters
)
ORDER BY distance_km
LIMIT 10;
```

### Test Google Maps API

```bash
# Test Geocoding API
curl "https://maps.googleapis.com/maps/api/geocode/json?address=Empire+State+Building,+New+York&key=YOUR_API_KEY"

# Test Distance Matrix API
curl "https://maps.googleapis.com/maps/api/distancematrix/json?origins=40.7484,-73.9857&destinations=40.7589,-73.9851&key=YOUR_API_KEY"
```

---

## Troubleshooting

### PostGIS Not Found

```bash
# Check if extension exists
docker exec the platform_postgres psql -U the platform_user -d the platform_booking -c "SELECT * FROM pg_available_extensions WHERE name = 'postgis';"

# If not available, you're using wrong image
# Make sure docker-compose.yml uses: postgis/postgis:latest
```

### Permission Denied on CREATE EXTENSION

```bash
# Connect as superuser
docker exec -it the platform_postgres psql -U postgres -d the platform_booking

# Grant permissions
GRANT ALL ON DATABASE the platform_booking TO the platform_user;
ALTER USER the platform_user WITH SUPERUSER;

# Then run extension creation
CREATE EXTENSION postgis;

# Remove superuser (security)
ALTER USER the platform_user WITH NOSUPERUSER;
```

### Google API Key Issues

```
Error: REQUEST_DENIED

Causes:
1. API not enabled in GCP Console
2. Billing not enabled
3. Key restrictions blocking request
4. Quota exceeded

Solutions:
1. Enable the specific API in GCP Console
2. Add billing to your GCP project
3. Check key restrictions match your server/domain
4. Increase quota or wait for reset
```

### Slow Spatial Queries

```sql
-- Check if spatial index exists
SELECT indexname FROM pg_indexes WHERE tablename = 'tenants' AND indexdef LIKE '%gist%';

-- If not, create it
CREATE INDEX idx_tenants_location_gist ON tenants USING GIST (location);

-- Analyze table for query planner
ANALYZE tenants;
```

---

## Quick Reference

### Common PostGIS Functions

| Function                 | Purpose               | Example                       |
| ------------------------ | --------------------- | ----------------------------- |
| `ST_MakePoint(lng, lat)` | Create point          | `ST_MakePoint(-73.98, 40.74)` |
| `ST_SetSRID(geom, 4326)` | Set coordinate system | `ST_SetSRID(point, 4326)`     |
| `ST_Distance(a, b)`      | Distance in meters    | `ST_Distance(loc1, loc2)`     |
| `ST_DWithin(a, b, dist)` | Within distance?      | `ST_DWithin(a, b, 5000)`      |
| `ST_X(geom)`             | Get longitude         | `ST_X(location::geometry)`    |
| `ST_Y(geom)`             | Get latitude          | `ST_Y(location::geometry)`    |

### Command Cheat Sheet

```bash
# Start database
docker compose up -d postgres

# Run maps setup
pnpm --filter @the platform/db run setup:maps

# Check PostGIS version
docker exec the platform_postgres psql -U the platform_user -d the platform_booking -c "SELECT PostGIS_Version();"

# Test nearby query
docker exec the platform_postgres psql -U the platform_user -d the platform_booking -c "
SELECT id, name FROM tenants
WHERE ST_DWithin(location, ST_MakePoint(12.5683, 55.6761)::geography, 5000);"
```

---

**Related:** See [MAPS_ARCHITECTURE.md](./MAPS_ARCHITECTURE.md) for full architecture and implementation details.
