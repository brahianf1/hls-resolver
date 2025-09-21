import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ResolveRequestZod,  
  ResolveResponseZod,
  ErrorResponseZod
} from '../../types/dto.js';
import { ResolverService } from '../../core/resolver/resolver.service.js';
import { getLogger } from '../../core/observability/logger.js';
import { incrementHttpRequest } from '../../core/observability/metrics.js';

export async function resolveRoutes(
  fastify: FastifyInstance,
  resolverService: ResolverService
): Promise<void> {

  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post('/api/v1/resolve', {
    schema: {
      description: 'Resuelve una URL para detectar streams HLS',
      tags: ['resolver'],
      body: ResolveRequestZod,
      response: {
        200: ResolveResponseZod,
        400: ErrorResponseZod,
        401: ErrorResponseZod,
        403: ErrorResponseZod,
        500: ErrorResponseZod,
      },
    },
    handler: async (request, reply) => {
      const startTime = Date.now();
      const requestId = request.id;
      
      try {
        getLogger().info({
          requestId,
          method: request.method,
          url: request.url,
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        }, 'Resolve request started');

        const result = await resolverService.resolve(request.body);
        
        const duration = Date.now() - startTime;
        incrementHttpRequest(request.method, '/api/v1/resolve', 200, duration);
        
        getLogger().info({
          requestId,
          sessionId: result.sessionId,
          streamsFound: result.streams.length,
          duration,
        }, 'Resolve request completed successfully');

        return reply.status(200).send(result);

      } catch (error) {
        const duration = Date.now() - startTime;
        
        let errorMessage = 'Internal Server Error';
        let statusCode: 200 | 400 | 401 | 403 | 500 = 500;
        if (error instanceof Error) {
          errorMessage = error.message;
          if ('statusCode' in error && typeof (error as any).statusCode === 'number') {
            const validStatusCodes: (200 | 400 | 401 | 403 | 500)[] = [200, 400, 401, 403, 500];
            if (validStatusCodes.includes((error as any).statusCode)) {
              statusCode = (error as any).statusCode;
            }
          }
        }

        incrementHttpRequest(request.method, '/api/v1/resolve', statusCode, duration);

        getLogger().error({
          requestId,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
          duration,
          statusCode,
        }, 'Resolve request failed');

        return reply.status(statusCode).send({
          error: 'error'  ,
          message: errorMessage,
          statusCode: statusCode,
          timestamp: new Date().toISOString(),
          requestId: requestId,
        });
      }
    },
  });
}
