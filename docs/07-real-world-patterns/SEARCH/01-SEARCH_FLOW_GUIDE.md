# Portfolio Note

> Extracted from production system, sanitized for portfolio use.

---

# Search Flow Diagrams & Implementation Guide

## Document Overview

**Purpose:** Visual flow diagrams and implementation reference for the Discovery module
**Companion To:** `SEARCH_ARCHITECTURE.md`
**Status:** Implemented
**Last Updated:** February 17, 2026

---

## User Journey Flows

### Flow 1: Customer Discovery Journey (Happy Path)

```
[Customer] Opens App
    |
    +---> Grants Location Permission
    |         |
    |         v
    |    [GPS Coordinates] lat: 55.6761, lng: 12.5683
    |         |
    |         v
    |    GET /api/public/search/nearby?lat=55.6761&lng=12.5683&radius=10
    |         |
    |         +---> [Search Service]
    |         |         |
    |         |         +---> Check Redis Cache (Key: "search:nearby:55.6761:12.5683:10")
    |         |         |         |
    |         |         |         +---> Cache HIT -> Return cached results (5ms)
    |         |         |         |
    |         |         |         +---> Cache MISS -> Query Database
    |         |         |                   |
    |         |         |                   v
    |         |         |              [PostgreSQL + PostGIS]
    |         |         |                   |
    |         |         |                   +---> Calculate distances (ST_Distance)
    |         |         |                   +---> Filter active tenants
    |         |         |                   +---> Join tenant_stats
    |         |         |                   +---> Order by distance
    |         |         |                   +---> Return 20 results (45ms)
    |         |         |                             |
    |         |         +-----------------------------+
    |         |                             |
    |         |                             v
    |         |                   Cache results in Redis (TTL: 5min)
    |         |                             |
    |         +-----------------------------+
    |                                       |
    |                                       v
    |    Response: {
    |      results: [
    |        { name: "Beauty Studio", distance_km: 2.3, rating: 4.8, ... },
    |        { name: "Hair organization/business", distance_km: 3.1, rating: 4.6, ... },
    |        ...
    |      ],
    |      pagination: { total: 45, page: 1, ... }
    |    }
    |                   |
    v                   v
[Customer] Sees Results -> [Map View + List View]
    |
    +---> Customer Taps "Beauty Studio"
    |         |
    |         v
    |    GET /api/public/providers/beauty-studio-copenhagen
    |         |
    |         +---> [Provider Service]
    |         |         |
    |         |         +---> Check Cache (Key: "provider:beauty-studio-copenhagen")
    |         |         |         |
    |         |         |         +---> Cache HIT -> Return profile (3ms)
    |         |         |         |
    |         |         |         +---> Cache MISS -> Query Database
    |         |         |                   |
    |         |         |                   v
    |         |         |              [Aggregate Queries]
    |         |         |                   |
    |         |         |                   +---> Get tenant details
    |         |         |                   +---> Get services by category
    |         |         |                   +---> Get staff profiles
    |         |         |                   +---> Get recent reviews (limit 5)
    |         |         |                   +---> Get availability preview
    |         |         |                   +---> Return complete profile (80ms)
    |         |         |                             |
    |         |         +-----------------------------+
    |         |                             |
    |         +-----------------------------+
    |                                       |
    v                                       v
[Customer] Views Profile -> See Services, Staff, Reviews, Hours
    |
    +---> Customer Taps "Book Haircut with Emma"
    |         |
    |         v
    |    [Booking Flow] (Existing booking system takes over)
    |         |
    |         +---> POST /api/:tenant/bookings
    |                   |
    |                   v
    |         [Booking Created]
    |
    +---> [End of Discovery Journey]
```

---

### Flow 2: Text Search Journey

```
[Customer] Types in Search Bar
    |
    +---> Types: "h" -> Autocomplete triggers
    |         |
    |         v
    |    GET /api/public/search/autocomplete?q=h&limit=10
    |         |
    |         +---> Returns: ["Hair", "Hair Coloring", "Hair Studio", ...]
    |                   |
    |                   +---> [Too generic, keep typing]
    |
    +---> Types: "ha" -> Autocomplete updates
    |         |
    |         +---> Returns: ["Hair", "Haircut", "Hair organization/business Copenhagen", ...]
    |
    +---> Types: "haircu" -> Autocomplete refines
    |         |
    |         +---> Returns: ["Haircut", "Haircut & Color", "Hair Cuts Studio", ...]
    |
    +---> Types: "haircut" -> Presses Search
    |         |
    |         v
    |    GET /api/public/search?q=haircut&lat=55.6761&lng=12.5683&sort=relevance
    |         |
    |         +---> [Search Service]
    |         |         |
    |         |         +---> Parse query: "haircut"
    |         |         |         |
    |         |         |         +---> Tokenize: ["haircut"]
    |         |         |         +---> Build tsquery: plainto_tsquery('english', 'haircut')
    |         |         |
    |         |         +---> Query tenant_search_index (materialized view)
    |         |         |         |
    |         |         |         +---> Full-text search on search_vector
    |         |         |         +---> Calculate relevance score (ts_rank)
    |         |         |         +---> Calculate distance (if lat/lng provided)
    |         |         |         +---> Join tenant_stats for ratings
    |         |         |
    |         |         +---> Apply ranking algorithm:
    |         |                   |
    |         |                   +---> relevance_score (40%)
    |         |                   +---> rating_score (30%)
    |         |                   +---> distance_score (20%)
    |         |                   +---> popularity_score (10%)
    |         |                             |
    |         +-----------------------------+
    |                                       |
    v                                       v
[Customer] Sees Results -> Sorted by Best Match
    |
    +---> 67 organizations/businesses found offering "Haircut"
    |
    +---> Customer Applies Filter: "Rating 4.5+"
    |         |
    |         v
    |    GET /api/public/search?q=haircut&lat=55.6761&lng=12.5683&min_rating=4.5
    |         |
    |         +---> Returns: 45 organizations/businesses (filtered)
    |
    +---> Customer Applies Filter: "Within 5km"
    |         |
    |         v
    |    GET /api/public/search?q=haircut&lat=55.6761&lng=12.5683&min_rating=4.5&radius=5
    |         |
    |         +---> Returns: 23 organizations/businesses (further filtered)
    |
    +---> Customer Selects organization/business
    |         |
    |         +---> [Proceeds to Provider Profile]
    |
    +---> [Continue to Booking]
```

---

### Flow 3: Category Browse Journey

```
[Customer] Opens App -> Sees Homepage
    |
    +---> Views Category Cards:
    |         |
    |         +---> Hair (67 organizations/businesses)
    |         +---> Nails (45 organizations/businesses)
    |         +---> Beauty (52 organizations/businesses)
    |         +---> Spa & Wellness (28 organizations/businesses)
    |
    +---> Taps on "Hair" Category
    |         |
    |         v
    |    GET /api/public/search/category/hair?lat=55.6761&lng=12.5683&sort=rating
    |         |
    |         +---> [Search Service]
    |         |         |
    |         |         +---> Filter tenant_stats WHERE 'hair' = ANY(service_categories)
    |         |         +---> Join tenants for details
    |         |         +---> Calculate distances
    |         |         +---> Sort by rating (DESC)
    |         |         +---> Build category context:
    |         |                   |
    |         |                   +---> Total providers: 67
    |         |                   +---> Popular services: [Haircut, Color, Treatment]
    |         |                   +---> Price range: 50-350 DKK
    |         |                   +---> Average rating: 4.6
    |         |
    |         +---> Response includes category_context + results
    |
    v
[Customer] Views "Hair organizations/businesses Near Me"
    |
    +---> Sees Popular Services:
    |         |
    |         +---> Haircut (65 providers, avg 85 DKK)
    |         +---> Hair Coloring (54 providers, avg 150 DKK)
    |         +---> Hair Treatment (42 providers, avg 120 DKK)
    |
    +---> Customer Taps "Hair Coloring"
    |         |
    |         v
    |    GET /api/public/search?q=hair+coloring&category=hair&lat=55.6761&lng=12.5683
    |         |
    |         +---> Returns 54 organizations/businesses with hair coloring service
    |
    +---> [Continue to Provider Selection]
```

---

## Backend Implementation Reference

### Module Structure (Actual)

```
apps/api/src/discovery/
+-- discovery.module.ts              # Module registration
+-- controllers/
|   +-- index.ts                     # Barrel export
|   +-- search.controller.ts         # Main search endpoints (nearby, text, autocomplete, category)
|   +-- provider.controller.ts       # Public provider profile
|   +-- stats.controller.ts          # Search statistics endpoints
+-- services/
|   +-- index.ts                     # Barrel export
|   +-- search.service.ts            # Core search logic
|   +-- geolocation.service.ts       # Distance calculations (Haversine)
|   +-- ranking.service.ts           # Result ranking algorithm
|   +-- search-cache.service.ts      # Redis caching for search results
|   +-- stats.service.ts             # Tenant stats aggregation
|   +-- stats-refresh.service.ts     # Auto-refresh of materialized view (enterprise)
|   +-- __tests__/
|       +-- search.service.spec.ts   # Unit tests for search service
+-- repositories/
|   +-- search.repository.ts         # Spatial + full-text search queries
|   +-- stats.repository.ts          # Stats/materialized view queries
+-- dto/
|   +-- search-query.dto.ts          # Search request validation
|   +-- search-response.dto.ts       # Response formatting
+-- swagger/
|   +-- search.swagger.ts            # Swagger/OpenAPI decorators
+-- utils/
    +-- search-cache-keys.util.ts    # Cache key generation utilities
```

### Discovery Module Registration (Actual)

```typescript
// apps/api/src/discovery/discovery.module.ts

@Module({
  controllers: [
    SearchController,      // Main search endpoints
    ProviderController,    // Public provider profile
    SearchStatsController, // Search statistics
  ],
  providers: [
    // Repositories
    SearchRepository,
    StatsRepository,

    // Services
    SearchService,
    RankingService,
    SearchCacheService,
    GeolocationService,
    StatsService,

    // Auto-refresh service (materialized view)
    StatsRefreshService,
  ],
  exports: [SearchService, RankingService, StatsRefreshService],
})
export class DiscoveryModule {}
```

### Key Implementation Notes

**Controllers (3):**

| Controller              | File                    | Responsibility                                    |
| ----------------------- | ----------------------- | ------------------------------------------------- |
| `SearchController`      | `search.controller.ts`  | Nearby search, text search, autocomplete, category |
| `ProviderController`    | `provider.controller.ts`| Public provider profile lookup                     |
| `SearchStatsController` | `stats.controller.ts`   | Search statistics and analytics                    |

**Services (6):**

| Service               | File                       | Responsibility                                    |
| --------------------- | -------------------------- | ------------------------------------------------- |
| `SearchService`       | `search.service.ts`        | Core search orchestration                         |
| `GeolocationService`  | `geolocation.service.ts`   | Distance calculations, coordinate validation      |
| `RankingService`      | `ranking.service.ts`       | Composite ranking score calculation               |
| `SearchCacheService`  | `search-cache.service.ts`  | Redis cache for search results (TTL-based)        |
| `StatsService`        | `stats.service.ts`         | Tenant statistics aggregation                     |
| `StatsRefreshService` | `stats-refresh.service.ts` | Auto-refresh of materialized view (enterprise)    |

**Repositories (2):**

| Repository        | File                    | Responsibility                                |
| ----------------- | ----------------------- | --------------------------------------------- |
| `SearchRepository`| `search.repository.ts`  | PostGIS spatial queries, full-text search      |
| `StatsRepository` | `stats.repository.ts`   | Materialized view queries, stats aggregation   |

---

### Geolocation Service

```typescript
// apps/api/src/discovery/services/geolocation.service.ts

@Injectable()
export class GeolocationService {
  // Haversine formula for distance between two coordinate pairs
  calculateDistance(point1: Coordinates, point2: Coordinates): number;

  // Validate lat/lng within valid ranges
  validateCoordinates(lat: number, lng: number): boolean;

  // Convert km to miles
  kmToMiles(km: number): number;
}
```

---

### Search Repository

```typescript
// apps/api/src/discovery/repositories/search.repository.ts

@Injectable()
export class SearchRepository {
  // PostGIS distance filter + joins with tenant_stats
  async searchNearby(params: NearbySearchParams);

  // Pagination count for nearby search
  async countNearby(params): Promise<number>;
}
```

Key query features:
- `ST_DWithin` for radius-based spatial filtering
- `ST_Distance` for distance calculation in kilometers
- LEFT JOIN with `tenant_stats` materialized view
- Dynamic WHERE conditions (category, rating, price filters)
- Pagination via LIMIT/OFFSET

---

### Ranking Service

```typescript
// apps/api/src/discovery/services/ranking.service.ts

@Injectable()
export class RankingService {
  // Composite score: distance (25%) + rating (30%) + popularity (45%)
  calculateRanking(factors: RankingFactors): RankedResult;
}
```

Scoring breakdown:
- **Distance score:** Closer = higher (0km = 100, 20km+ = 0)
- **Rating score:** Linear scale (5.0 = 100, 4.0 = 80)
- **Popularity score:** Reviews (max 50pts) + bookings (max 30pts) + views (max 20pts)

---

### Search Cache Service

```typescript
// apps/api/src/discovery/services/search-cache.service.ts

@Injectable()
export class SearchCacheService {
  // Generate deterministic cache keys with rounded coordinates
  generateSearchKey(params): string;

  // Get/set cached search results (TTL: 5 minutes)
  async getSearchResults<T>(key: string): Promise<T | null>;
  async cacheSearchResults(key: string, data: any): Promise<void>;

  // Invalidate cache per tenant or globally
  async invalidateTenantCache(tenantSlug: string): Promise<void>;
  async invalidateAllSearchCaches(): Promise<void>;
}
```

Cache key format: `search:nearby:{lat}:{lng}:r{radius}[:c{category}][:r{rating}][:s{sort}]:p{page}`

---

### Stats Refresh Service

```typescript
// apps/api/src/discovery/services/stats-refresh.service.ts

@Injectable()
export class StatsRefreshService {
  // Enterprise-grade auto-refresh for the tenant_stats materialized view.
  // Ensures search results reflect up-to-date ratings, booking counts,
  // and service categories without manual intervention.
}
```

---

## Data Flow Diagrams

### Diagram 1: Database Query Flow

```
[API Request]
    |
    v
[SearchController] -> Validates DTO
    |
    v
[SearchService] -> Checks Cache (via SearchCacheService)
    |                    |
    |                    +---> Cache HIT -> Return immediately
    |                    |
    |                    +---> Cache MISS -> Continue to DB
    |
    v
[SearchRepository]
    |
    +---> Build SQL Query
    |         |
    |         +---> SELECT from tenants
    |         +---> LEFT JOIN tenant_stats (materialized view)
    |         +---> WHERE conditions:
    |         |         +---> status = 'active'
    |         |         +---> ST_DWithin (PostGIS distance)
    |         |         +---> category filter (if provided)
    |         |         +---> rating filter (if provided)
    |         +---> ORDER BY distance_km ASC
    |         +---> LIMIT/OFFSET for pagination
    |
    v
[PostgreSQL + PostGIS]
    |
    +---> Query Execution Plan:
    |         |
    |         +---> Index Scan: idx_tenants_location_gist (FAST)
    |         +---> Filter: status = 'active'
    |         +---> Hash Join: tenants <-> tenant_stats
    |         +---> Sort: By distance
    |
    v
[Raw Results] (20 rows)
    |
    v
[RankingService] -> Calculate scores
    |
    v
[GeolocationService] -> Add distance conversions
    |
    v
[Formatted Response]
    |
    +---> Cache in Redis (TTL: 5min) via SearchCacheService
    |
    +---> Return to client
```

---

### Diagram 2: Cache Strategy Flow

```
[Search Request] lat=55.6761, lng=12.5683, radius=10
    |
    v
Generate Cache Key: "search:nearby:55.676:12.568:r10:p1"
    |
    v
[Redis] Check if key exists
    |
    +---> EXISTS -> Get value -> Parse JSON -> Return (5ms)
    |
    +---> NOT EXISTS -> Query database
              |
              v
         [Database Query] (50ms)
              |
              v
         Format response
              |
              v
         Store in Redis (TTL: 300s)
              |
              Key: "search:nearby:55.676:12.568:r10:p1"
              Value: JSON stringified results
              Expiry: 5 minutes
              |
              +---> Return to client
```

### Cache Invalidation Triggers

```
[Trigger Events]
    |
    +---> Tenant Updated (name, description, images)
    |         +---> Invalidate: provider:{slug}
    |
    +---> Service Added/Updated/Deleted
    |         +---> Invalidate: search:* (all search caches)
    |
    +---> Review Submitted
    |         +---> Update tenant_stats (via StatsRefreshService)
    |         +---> Invalidate: provider:{slug}
    |
    +---> Booking Completed
              +---> Update tenant_stats (via StatsRefreshService)
              +---> Invalidate: provider:{slug}
```

---

## Performance Benchmarks

### Target Metrics

| Operation                   | Target  | Optimized | Notes              |
| --------------------------- | ------- | --------- | ------------------ |
| Nearby Search (cached)      | < 10ms  | 5ms       | Redis hit          |
| Nearby Search (uncached)    | < 200ms | 45ms      | PostGIS optimized  |
| Text Search (cached)        | < 10ms  | 5ms       | Redis hit          |
| Text Search (uncached)      | < 300ms | 80ms      | Full-text search   |
| Autocomplete                | < 50ms  | 12ms      | Trigram similarity |
| Provider Profile (cached)   | < 10ms  | 3ms       | Redis hit          |
| Provider Profile (uncached) | < 150ms | 80ms      | Multiple joins     |

### Optimization Checklist

- [x] PostGIS spatial index created
- [x] pg_trgm extension enabled for autocomplete
- [x] Materialized view for search index (auto-refreshed via StatsRefreshService)
- [x] Redis caching implemented (5min TTL) via SearchCacheService
- [x] Connection pooling configured (max 20 connections)
- [x] Query result pagination (max 50 per page)
- [x] Rate limiting (100 req/min per IP)
- [x] Monitoring & logging (response times tracked)

---

## Testing

### Unit Tests

Located at `apps/api/src/discovery/services/__tests__/search.service.spec.ts`

```typescript
describe('GeolocationService', () => {
  describe('calculateDistance', () => {
    it('should calculate distance between Copenhagen and Aarhus');
    it('should return 0 for same coordinates');
  });

  describe('validateCoordinates', () => {
    it('should accept valid coordinates');
    it('should reject invalid latitude');
    it('should reject invalid longitude');
  });
});
```

### Integration Tests

```typescript
describe('SearchController (e2e)', () => {
  describe('GET /api/public/search/nearby', () => {
    it('should return organizations/businesses near Copenhagen');
    it('should require lat and lng parameters');
    it('should filter by category');
  });
});
```

---

**Last Updated:** February 17, 2026
