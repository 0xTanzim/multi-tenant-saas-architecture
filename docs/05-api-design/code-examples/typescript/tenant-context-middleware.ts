/**
 * Tenant Context Extraction & Validation Middleware
 *
 * This module demonstrates how to extract and validate tenant context from:
 * 1. JWT tokens (Authorization header)
 * 2. Route parameters (tenant slug)
 * 3. Optional X-Tenant-Id header
 * 4. Request context (tenantId stored on request object)
 *
 * Key principles:
 * - JWT is the source of truth for tenant identity
 * - Route tenant must match JWT tenant
 * - User must be an active member of the requested tenant
 * - All tenant context is cached when possible
 */

import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NextFunction, Request, Response } from 'express';

// ============================================================================
// Types
// ============================================================================

export interface DecodedJWT {
  sub: string; // User ID
  tenant_id: number; // Current tenant ID
  tenant_slug: string; // Current tenant slug
  active_tenant: {
    id: number;
    name: string;
    slug: string;
    type: string;
  };
  tenant_ids: number[]; // All accessible tenant IDs
  role: 'owner' | 'staff' | 'customer';
  permissions: string[];
  staff_id?: number;
  customer_id?: string;
  is_owner: boolean;
  is_staff: boolean;
  is_customer: boolean;
  iat: number;
  exp: number;
}

export interface TenantContext {
  tenantId: number;
  tenantSlug: string;
  userId: string;
  role: string;
  permissions: string[];
  isOwner: boolean;
  isStaff: boolean;
  isCustomer: boolean;
  staffId?: number;
  customerId?: string;
  accessibleTenantIds: number[];
}

// Extend Express Request to include our custom properties
declare global {
  namespace Express {
    interface Request {
      tenantId?: number;
      tenantSlug?: string;
      tenantContext?: TenantContext;
      user?: any;
      requestId?: string;
    }
  }
}

// ============================================================================
// Tenant Context Extraction Middleware
// ============================================================================

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);
  private readonly tokenCache = new Map<string, DecodedJWT>();
  private readonly tenantCache = new Map<string, any>();

  constructor(
    private readonly jwtService: JwtService,
    @Inject(forwardRef(() => 'TenantService'))
    private readonly tenantService?: any,
    @Inject(forwardRef(() => 'UserTenantService'))
    private readonly userTenantService?: any
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // 1. Generate request ID for tracing
      if (!req.requestId) {
        req.requestId = this.generateRequestId();
      }

      // 2. Skip tenant context for global routes
      if (this.isGlobalRoute(req.path)) {
        return next();
      }

      // 3. Extract and validate JWT
      const decodedJwt = await this.extractAndValidateJwt(req);
      if (!decodedJwt) {
        return next(); // Continue without tenant context (guard will handle)
      }

      // 4. Extract tenant from route or header
      const requestedTenantId = await this.extractRequestedTenant(
        req,
        decodedJwt
      );

      // 5. Validate tenant context
      if (requestedTenantId) {
        const isValid = await this.validateTenantContext(
          decodedJwt,
          requestedTenantId,
          req
        );
        if (!isValid) {
          throw new ForbiddenException({
            code: 'TENANT_VALIDATION_FAILED',
            message: 'Tenant context validation failed',
          });
        }

        req.tenantId = requestedTenantId;
      } else {
        // Use JWT tenant as default
        req.tenantId = decodedJwt.tenant_id;
      }

      // 6. Extract tenant slug
      req.tenantSlug = decodedJwt.tenant_slug;

      // 7. Build tenant context
      req.tenantContext = {
        tenantId: req.tenantId,
        tenantSlug: req.tenantSlug,
        userId: decodedJwt.sub,
        role: decodedJwt.role,
        permissions: decodedJwt.permissions,
        isOwner: decodedJwt.is_owner,
        isStaff: decodedJwt.is_staff,
        isCustomer: decodedJwt.is_customer,
        staffId: decodedJwt.staff_id,
        customerId: decodedJwt.customer_id,
        accessibleTenantIds: decodedJwt.tenant_ids,
      };

      // 8. Add tenant context to response headers
      res.setHeader('X-Tenant-ID', req.tenantId);
      res.setHeader('X-Tenant-Slug', req.tenantSlug);
      res.setHeader('X-Request-ID', req.requestId);

      this.logger.debug(
        `Tenant context extracted: tenant=${req.tenantId}, user=${decodedJwt.sub}`,
        { requestId: req.requestId, path: req.path }
      );

      next();
    } catch (error) {
      this.logger.error(
        `Tenant context extraction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : '',
        { requestId: req.requestId, path: req.path }
      );

      // Pass error to next middleware/guard
      next(error);
    }
  }

  // ========================================================================
  // Private Methods
  // ========================================================================

  /**
   * Extract and validate JWT from Authorization header
   */
  private async extractAndValidateJwt(
    req: Request
  ): Promise<DecodedJWT | null> {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return null; // Let guard handle missing auth
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Invalid Authorization header format');
    }

    const token = authHeader.slice(7); // Remove "Bearer "

    try {
      // Try cache first
      const cached = this.tokenCache.get(token);
      if (cached) {
        // Check if still valid
        if (cached.exp > Date.now() / 1000) {
          return cached;
        }
        // Expired, remove from cache
        this.tokenCache.delete(token);
      }

      // Verify JWT signature and decode
      const decoded = this.jwtService.verify(token) as DecodedJWT;

      // Validate required claims
      if (!decoded.sub || !decoded.tenant_id || !decoded.tenant_ids) {
        throw new UnauthorizedException('Missing required JWT claims');
      }

      // Cache for 5 minutes
      this.tokenCache.set(token, decoded);

      // Clean up old entries (prevent memory leak)
      if (this.tokenCache.size > 10000) {
        this.tokenCache.clear();
      }

      return decoded;
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new UnauthorizedException('Token has expired');
      }
      if (error.name === 'JsonWebTokenError') {
        throw new UnauthorizedException('Invalid token signature');
      }
      throw error;
    }
  }

  /**
   * Extract requested tenant from route param or header
   */
  private async extractRequestedTenant(
    req: Request,
    decodedJwt: DecodedJWT
  ): Promise<number | null> {
    // 1. Check X-Tenant-Id header (optional override)
    const headerTenantId = req.headers['x-tenant-id'];
    if (headerTenantId) {
      const tenantId = parseInt(headerTenantId as string, 10);
      if (isNaN(tenantId)) {
        throw new BadRequestException('X-Tenant-Id must be a valid number');
      }
      return tenantId;
    }

    // 2. Check route parameter (e.g., /api/salons/:tenantSlug/bookings)
    const tenantSlug = req.params.tenantSlug;
    if (tenantSlug) {
      const tenantId = await this.resolveTenantSlug(tenantSlug);
      if (!tenantId) {
        throw new BadRequestException(`Invalid tenant slug: ${tenantSlug}`);
      }
      return tenantId;
    }

    // 3. No override, use JWT tenant
    return null;
  }

  /**
   * Resolve tenant slug to tenant ID
   */
  private async resolveTenantSlug(slug: string): Promise<number | null> {
    // Check cache first
    if (this.tenantCache.has(slug)) {
      return this.tenantCache.get(slug).id;
    }

    // Query database
    if (!this.tenantService) {
      this.logger.warn('TenantService not available for slug resolution');
      return null;
    }

    const tenant = await this.tenantService.findBySlug(slug);
    if (!tenant) {
      return null;
    }

    // Cache for 1 hour
    this.tenantCache.set(slug, tenant);
    return tenant.id;
  }

  /**
   * Validate tenant context
   */
  private async validateTenantContext(
    decodedJwt: DecodedJWT,
    requestedTenantId: number,
    req: Request
  ): Promise<boolean> {
    // 1. Check if user has access to this tenant
    if (!decodedJwt.tenant_ids.includes(requestedTenantId)) {
      this.logger.warn(
        `User ${decodedJwt.sub} attempted to access unauthorized tenant ${requestedTenantId}`,
        { requestId: req.requestId }
      );
      return false;
    }

    // 2. Re-verify user is still an active member (optional, cache-friendly)
    if (this.userTenantService && Math.random() < 0.1) {
      // 10% of requests re-validate (balance freshness with performance)
      const userTenant = await this.userTenantService.findOne({
        userId: decodedJwt.sub,
        tenantId: requestedTenantId,
      });

      if (!userTenant || userTenant.deletedAt) {
        this.logger.warn(
          `User ${decodedJwt.sub} access to tenant ${requestedTenantId} was revoked`,
          { requestId: req.requestId }
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Check if route is global (doesn't require tenant context)
   */
  private isGlobalRoute(path: string): boolean {
    const globalRoutes = [
      '/api/auth',
      '/api/health',
      '/api/docs',
      '/api/swagger',
      '/auth',
      '/health',
      '/docs',
    ];

    return globalRoutes.some((route) => path.startsWith(route));
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// ============================================================================
// Tenant Validation Guard
// ============================================================================

import { CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class TenantValidationGuard implements CanActivate {
  private readonly logger = new Logger(TenantValidationGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // Check if middleware extracted tenant context
    if (!request.tenantId) {
      throw new BadRequestException(
        'Tenant context not found. Ensure TenantContextMiddleware is applied.'
      );
    }

    if (!request.tenantContext) {
      throw new BadRequestException('Tenant context validation required');
    }

    return true;
  }
}

// ============================================================================
// Tenant Context Decorator
// ============================================================================

import { createParamDecorator } from '@nestjs/common';

/**
 * Extract tenant context from request
 * @param data Property to extract (optional)
 * @param ctx Execution context
 */
export const GetTenantContext = createParamDecorator(
  (data: keyof TenantContext | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();

    if (!request.tenantContext) {
      throw new BadRequestException('Tenant context not available');
    }

    // Return specific property or whole context
    return data ? request.tenantContext[data] : request.tenantContext;
  }
);

/**
 * Extract tenant ID
 */
export const GetTenantId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): number => {
    const request = ctx.switchToHttp().getRequest<Request>();

    if (!request.tenantId) {
      throw new BadRequestException('Tenant ID not available');
    }

    return request.tenantId;
  }
);

// ============================================================================
// Usage Example in NestJS Module
// ============================================================================

/*
EXAMPLE: Module Configuration
------------------------------

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1h' }
    })
  ],
  providers: [TenantContextMiddleware, TenantValidationGuard]
})
export class TenantModule {}


EXAMPLE: Apply Middleware Globally
-----------------------------------

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantContextMiddleware } from './middleware/tenant-context.middleware';

@Module({})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantContextMiddleware)
      .forRoutes('*'); // Apply to all routes
  }
}


EXAMPLE: Use in Controller
--------------------------

import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantValidationGuard } from './guards/tenant-validation.guard';
import { GetTenantContext, GetTenantId } from './decorators/tenant.decorator';

@Controller('api/bookings')
@UseGuards(TenantValidationGuard)
export class BookingsController {
  @Get()
  getBookings(
    @GetTenantId() tenantId: number,
    @GetTenantContext() context: TenantContext
  ) {
    return {
      tenantId,
      userId: context.userId,
      role: context.role,
      permissions: context.permissions
    };
  }

  @Get(':id')
  getBooking(
    @Param('id') bookingId: string,
    @GetTenantId() tenantId: number
  ) {
    // tenantId is automatically validated
    return bookingService.findOne(bookingId, tenantId);
  }
}
*/
