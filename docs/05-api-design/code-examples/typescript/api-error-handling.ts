/**
 * Tenant-Safe Error Response Handling
 *
 * This module demonstrates how to handle errors without leaking tenant data.
 * Key principles:
 * 1. Never expose internal tenant IDs in error messages
 * 2. Never reveal database structure or SQL errors
 * 3. Always include request ID for audit trails
 * 4. Distinguish between client errors (4xx) and server errors (5xx)
 * 5. Provide actionable error messages
 */

import { HttpException, HttpStatus, Logger } from '@nestjs/common';

// ============================================================================
// Error Type Definitions
// ============================================================================

export interface ErrorResponse {
  error: {
    code: string; // Machine-readable error code
    message: string; // Human-readable message
    status: number; // HTTP status code
    details?: Record<string, any>; // Additional context (safe data only)
    requestId?: string; // Audit trail
    timestamp?: string; // When error occurred
  };
}

export interface ErrorContext {
  tenantId?: number; // For logging only
  userId?: string; // For logging only
  requestId: string; // Always include
  path: string; // Request path
  method: string; // HTTP method
  originalError?: Error; // For logging only
}

// ============================================================================
// Tenant-Safe Error Classes
// ============================================================================

/**
 * Tenant Mismatch Error
 *
 * When a user tries to access a resource from a different tenant
 */
export class TenantMismatchError extends HttpException {
  constructor(context: ErrorContext) {
    const response: ErrorResponse = {
      error: {
        code: 'TENANT_MISMATCH',
        message: 'You do not have access to this resource',
        status: 403,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
        // IMPORTANT: Don't include actual tenant IDs or user IDs in response
      },
    };

    super(response, HttpStatus.FORBIDDEN);

    // Log the actual mismatch for debugging (tenant_id in logs, NOT response)
    Logger.warn(
      `Tenant mismatch detected: user ${context.userId} attempted to access resource from tenant ${context.tenantId}`,
      'TenantMismatchError',
      { requestId: context.requestId }
    );
  }
}

/**
 * Cross-Tenant Access Error
 *
 * When a user attempts to perform operations across multiple tenants
 */
export class CrossTenantAccessError extends HttpException {
  constructor(context: ErrorContext) {
    const response: ErrorResponse = {
      error: {
        code: 'CROSS_TENANT_ACCESS_DENIED',
        message: 'Cannot perform operations across different organizations',
        status: 403,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };

    super(response, HttpStatus.FORBIDDEN);

    Logger.warn(
      `Cross-tenant access attempt by user ${context.userId}`,
      'CrossTenantAccessError',
      { requestId: context.requestId }
    );
  }
}

/**
 * Quota Exceeded Error
 *
 * When tenant exceeds their API call quota or storage limit
 */
export class QuotaExceededError extends HttpException {
  constructor(
    quotaType: 'api_calls' | 'storage' | 'bulk_operations',
    current: number,
    limit: number,
    resetAt: Date,
    context: ErrorContext
  ) {
    const response: ErrorResponse = {
      error: {
        code: 'QUOTA_EXCEEDED',
        message: `${quotaType.replace('_', ' ')} quota exceeded`,
        status: 402, // Payment Required
        details: {
          quotaType,
          limit,
          current,
          resetAt: resetAt.toISOString(),
          message: `You have reached your ${quotaType} limit. Upgrade your plan or wait until ${resetAt.toLocaleDateString()} for reset.`,
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };

    super(response, HttpStatus.PAYMENT_REQUIRED);

    Logger.warn(
      `Quota exceeded for tenant: ${quotaType} (${current}/${limit})`,
      'QuotaExceededError',
      { requestId: context.requestId, tenantId: context.tenantId }
    );
  }
}

/**
 * Database Error Handler (Safe)
 *
 * Never expose raw database errors to clients
 */
export class DatabaseErrorHandler {
  private readonly logger = new Logger(DatabaseErrorHandler.name);

  handleDatabaseError(error: any, context: ErrorContext): ErrorResponse {
    // Log actual error for debugging
    this.logger.error(`Database error: ${error.message}`, error.stack, {
      requestId: context.requestId,
      tenantId: context.tenantId,
      originalError: error.code, // PostgreSQL error code
    });

    // Check for specific database errors
    if (error.code === '23505') {
      // Unique constraint violation
      return {
        error: {
          code: 'DUPLICATE_ENTRY',
          message: 'This entry already exists. Try another value.',
          status: 409,
          requestId: context.requestId,
          timestamp: new Date().toISOString(),
          // NEVER expose: error.detail or error.table
        },
      };
    }

    if (error.code === '23502') {
      // Not null constraint violation
      return {
        error: {
          code: 'MISSING_REQUIRED_FIELD',
          message: 'One or more required fields are missing',
          status: 400,
          requestId: context.requestId,
          timestamp: new Date().toISOString(),
        },
      };
    }

    if (error.code === '23503') {
      // Foreign key constraint violation
      return {
        error: {
          code: 'INVALID_REFERENCE',
          message: 'One or more referenced items do not exist',
          status: 400,
          requestId: context.requestId,
          timestamp: new Date().toISOString(),
        },
      };
    }

    // Generic database error (never expose raw error)
    return {
      error: {
        code: 'DATABASE_ERROR',
        message: 'An error occurred while processing your request',
        status: 500,
        details: {
          requestId: context.requestId,
          contactSupport: 'If this persists, contact support@api.com',
        },
        timestamp: new Date().toISOString(),
      },
    };
  }
}

/**
 * Authorization Error Handler
 *
 * Handle permission and authentication errors safely
 */
export class AuthorizationErrorHandler {
  private readonly logger = new Logger(AuthorizationErrorHandler.name);

  handleUnauthorized(context: ErrorContext): ErrorResponse {
    this.logger.warn(`Unauthorized access attempt`, {
      requestId: context.requestId,
      path: context.path,
    });

    return {
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required. Please provide valid credentials.',
        status: 401,
        details: {
          hint: 'Include Authorization header with valid JWT token',
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  handleForbidden(resource: string, context: ErrorContext): ErrorResponse {
    this.logger.warn(
      `Forbidden access: user ${context.userId} attempted to access ${resource}`,
      { requestId: context.requestId, tenantId: context.tenantId }
    );

    return {
      error: {
        code: 'FORBIDDEN',
        message: `You do not have permission to access this ${resource}`,
        status: 403,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  handleInsufficientPermissions(
    requiredPermissions: string[],
    context: ErrorContext
  ): ErrorResponse {
    this.logger.warn(`Insufficient permissions for user ${context.userId}`, {
      requestId: context.requestId,
      tenantId: context.tenantId,
      required: requiredPermissions,
    });

    return {
      error: {
        code: 'INSUFFICIENT_PERMISSIONS',
        message: `This action requires elevated permissions`,
        status: 403,
        details: {
          required: requiredPermissions, // Don't leak user's actual permissions
          hint: 'Contact your administrator to request access',
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

/**
 * Validation Error Handler
 *
 * Handle input validation errors with helpful messages
 */
export class ValidationErrorHandler {
  private readonly logger = new Logger(ValidationErrorHandler.name);

  handleValidationError(
    fieldErrors: Record<string, string[]>,
    context: ErrorContext
  ): ErrorResponse {
    this.logger.debug(`Validation error for request ${context.path}`, {
      requestId: context.requestId,
      errors: Object.keys(fieldErrors).length,
    });

    // Flatten errors for easier reading
    const details = Object.entries(fieldErrors).reduce(
      (acc, [field, errors]) => {
        acc[field] = errors.join('; ');
        return acc;
      },
      {} as Record<string, string>
    );

    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        status: 400,
        details: {
          fields: details,
          hint: 'Check the error messages above and retry',
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  handleSemanticValidationError(
    reason: string,
    context: ErrorContext
  ): ErrorResponse {
    this.logger.debug(`Semantic validation error: ${reason}`, {
      requestId: context.requestId,
    });

    return {
      error: {
        code: 'SEMANTIC_VALIDATION_ERROR',
        message: reason,
        status: 422, // Unprocessable Entity
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

/**
 * Not Found Error Handler
 *
 * Handle missing resources safely (don't leak existence)
 */
export class NotFoundErrorHandler {
  private readonly logger = new Logger(NotFoundErrorHandler.name);

  handleResourceNotFound(
    resourceType: string,
    context: ErrorContext
  ): ErrorResponse {
    this.logger.debug(`Resource not found: ${resourceType}`, {
      requestId: context.requestId,
      tenantId: context.tenantId,
    });

    // Generic message (don't confirm if resource exists for other users)
    return {
      error: {
        code: 'NOT_FOUND',
        message: `The requested ${resourceType} was not found`,
        status: 404,
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

/**
 * Rate Limiting Error Handler
 */
export class RateLimitingErrorHandler {
  private readonly logger = new Logger(RateLimitingErrorHandler.name);

  handleRateLimitExceeded(
    limit: number,
    window: number,
    retryAfter: number,
    context: ErrorContext
  ): ErrorResponse {
    this.logger.warn(`Rate limit exceeded for tenant ${context.tenantId}`, {
      requestId: context.requestId,
    });

    return {
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `You have exceeded the rate limit (${limit} requests per ${window} seconds)`,
        status: 429,
        details: {
          limit,
          window,
          retryAfter,
          hint: `Please wait ${retryAfter} seconds before retrying`,
        },
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

/**
 * Generic Internal Server Error Handler
 *
 * Fallback for unexpected errors (never expose details)
 */
export class InternalErrorHandler {
  private readonly logger = new Logger(InternalErrorHandler.name);

  handleUnexpectedError(error: any, context: ErrorContext): ErrorResponse {
    // Log full error for debugging
    this.logger.error(
      `Unexpected error: ${error?.message || 'Unknown'}`,
      error?.stack || '',
      {
        requestId: context.requestId,
        tenantId: context.tenantId,
        path: context.path,
        method: context.method,
      }
    );

    // Send generic message to client
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred while processing your request',
        status: 500,
        details: {
          requestId: context.requestId,
          supportEmail: 'support@api.com',
          contactSupport:
            'Please reference your request ID when contacting support',
        },
        timestamp: new Date().toISOString(),
      },
    };
  }
}

// ============================================================================
// Global Exception Filter (NestJS)
// ============================================================================

import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    const requestId = request.id || 'unknown';
    const errorContext: ErrorContext = {
      tenantId: request.tenantId,
      userId: request.user?.id,
      requestId,
      path: request.path,
      method: request.method,
      originalError: exception,
    };

    let errorResponse: ErrorResponse;

    // Handle known HTTP exceptions
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = exception.getResponse() as any;

      errorResponse = {
        error: {
          code: message.error?.code || 'HTTP_EXCEPTION',
          message:
            message.error?.message || message.message || 'An error occurred',
          status,
          details: message.error?.details,
          requestId,
          timestamp: new Date().toISOString(),
        },
      };
    } else {
      // Unexpected error
      const handler = new InternalErrorHandler();
      errorResponse = handler.handleUnexpectedError(exception, errorContext);
    }

    response.status(errorResponse.error.status).json(errorResponse);
  }
}

// ============================================================================
// Usage Examples
// ============================================================================

/*
EXAMPLE 1: Tenant Mismatch in Controller
--------------------------------------------
@Get(':id')
async getBooking(@Param('id') bookingId: string, @TenantId() tenantId: number, @Req() req: Request) {
  const booking = await bookingService.findOne(bookingId);

  if (booking.tenantId !== tenantId) {
    throw new TenantMismatchError({
      tenantId,
      userId: req.user.id,
      requestId: req.id,
      path: req.path,
      method: req.method
    });
  }

  return booking;
}


EXAMPLE 2: Quota Check in Service
------------------------------------
async createBooking(tenantId: number, input: CreateBookingDto) {
  const usage = await quotaService.getMonthlyUsage(tenantId);
  const limit = await quotaService.getMonthlyLimit(tenantId);

  if (usage >= limit) {
    const resetDate = getNextMonthStart();
    throw new QuotaExceededError(
      'api_calls',
      usage,
      limit,
      resetDate,
      {
        tenantId,
        userId: currentUser.id,
        requestId: requestContext.id,
        path: requestContext.path,
        method: requestContext.method
      }
    );
  }

  return await bookingRepository.create(tenantId, input);
}


EXAMPLE 3: Database Error Handling
--------------------------------------
try {
  await bookingRepository.create(tenantId, bookingData);
} catch (error) {
  const handler = new DatabaseErrorHandler();
  const errorResponse = handler.handleDatabaseError(error, {
    tenantId,
    userId: currentUser.id,
    requestId,
    path,
    method
  });
  throw new HttpException(errorResponse, errorResponse.error.status);
}
*/
