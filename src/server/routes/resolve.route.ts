import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import crypto from 'crypto';
import { z } from 'zod';
import {
  ResolveRequestZod,  
  ResolveResponseZod,
  ErrorResponseZod,
  BulkResolveRequestZod,
  BulkResolveResponseZod,
  BulkStatusResponseZod
} from '../../types/dto.js';
import { ResolverService } from '../../core/resolver/resolver.service.js';
import { getLogger } from '../../core/observability/logger.js';
import { incrementHttpRequest } from '../../core/observability/metrics.js';
import { QueueService } from '../../core/queue/queue.service.js';

const HLS_RESOLVER_JOB = 'hls-resolve-job';

export async function resolveRoutes(
  fastify: FastifyInstance,
  resolverService: ResolverService
): Promise<void> {

  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const queueService = QueueService.getInstance();

  app.post('/api/v1/resolve/bulk', {
    schema: {
      description: 'Inicia un proceso de resolución por lotes para una lista de URLs.',
      tags: ['resolver'],
      body: BulkResolveRequestZod,
      response: {
        202: BulkResolveResponseZod,
        400: ErrorResponseZod,
        500: ErrorResponseZod,
      },
    },
    handler: async (request, reply) => {
      const { urls } = request.body;
      const batchId = `batch-${crypto.randomUUID()}`;
      
      getLogger().info({ batchId, count: urls.length }, 'Bulk resolve request received');

      const jobs = urls.map(url => ({
        name: HLS_RESOLVER_JOB,
        data: { url },
        opts: { 
          jobId: `${batchId}-${crypto.createHash('sha256').update(url).digest('hex')}`,
          attempts: 2, // Reintentar una vez si falla
          backoff: { type: 'exponential', delay: 1000 },
        },
      }));

      // BullMQ no tiene un "batch" nativo, pero podemos simularlo con un job padre o gestionando por ID.
      // Aquí, simplemente encolamos todos los trabajos.
      await Promise.all(jobs.map(job => queueService.addJob(job)));

      return reply.status(202).send({
        batchId,
        status: 'PENDING',
        totalJobs: urls.length,
        message: 'El lote ha sido aceptado y está siendo procesado.',
      });
    },
  });

  app.get('/api/v1/resolve/bulk/status/:batchId', {
    schema: {
        description: 'Consulta el estado de un proceso de resolución por lotes.',
        tags: ['resolver'],
        params: z.object({ batchId: z.string() }),
        response: {
            200: BulkStatusResponseZod,
            404: ErrorResponseZod,
        },
    },
    handler: async (request, reply) => {
        const { batchId } = request.params as { batchId: string };
        const queue = queueService.getQueue();
        
        const jobs = await queue.getJobs(['completed', 'failed', 'active', 'waiting']);
        const batchJobs = jobs.filter(job => job.id && job.id.startsWith(batchId));

        if (batchJobs.length === 0) {
            return reply.status(404).send({ 
              error: 'Not Found', 
              message: `No se encontró un lote con el ID: ${batchId}`, 
              statusCode: 404, 
              timestamp: new Date().toISOString() 
            });
        }

        let completedCount = 0;
        let failedCount = 0;

        for (const job of batchJobs) {
            if (await job.isCompleted()) {
                completedCount++;
            } else if (await job.isFailed()) {
                failedCount++;
            }
        }

        let status = 'PROCESSING';
        if (completedCount + failedCount === batchJobs.length) {
            status = 'COMPLETED';
        }

        const response: any = {
            batchId,
            status,
            progress: Math.round(((completedCount + failedCount) / batchJobs.length) * 100),
            total: batchJobs.length,
        };

        if (status === 'COMPLETED') {
          const creationTimestamps = batchJobs.map(job => job.timestamp).filter((t): t is number => t !== null && t > 0);
                    const finishedTimestamps = batchJobs.map(job => job.finishedOn).filter((t): t is number => !!t && t > 0);
          
          if (creationTimestamps.length > 0 && finishedTimestamps.length > 0) {
            const minCreationTime = Math.min(...creationTimestamps);
            const maxFinishedTime = Math.max(...finishedTimestamps);
            response.durationMs = maxFinishedTime - minCreationTime;
          }

          response.results = await Promise.all(batchJobs.map(async (job) => {
            const isCompleted = await job.isCompleted();
            const result = isCompleted ? await resolverService.convertToLegacyResponse(job.returnvalue, job.data.url) : undefined;
            
            return {
              url: job.data.url,
              status: isCompleted ? 'completed' : 'failed',
              result: result,
              error: isCompleted ? undefined : job.failedReason,
            };
          }));
        }

        return reply.status(200).send(response);
    },
});


  // Endpoint de prueba específico para sitios con anti-devtool protection
  app.post('/api/v1/resolve/protected', {
    schema: {
      description: 'Resuelve una URL de un sitio con bloqueador anti-devtool (testing endpoint)',
      tags: ['resolver', 'anti-devtool'],
      body: z.object({
        url: z.string().url(),
      }),
      response: {
        200: z.object({
          sessionId: z.string(),
          url: z.string(),
          success: z.boolean(),
          manifests: z.array(z.object({
            url: z.string(),
            status: z.number(),
            contentType: z.string(),
          })),
          timings: z.object({
            total: z.number(),
            navigation: z.number(),
            activation: z.number(),
            detection: z.number(),
          }),
          clicksPerformed: z.number(),
          antiDevtoolEnabled: z.boolean(),
        }),
        400: ErrorResponseZod,
        500: ErrorResponseZod,
      },
    },
    handler: async (request, reply) => {
      const startTime = Date.now();
      const requestId = request.id;
      const { url } = request.body as { url: string };

      try {
        getLogger().info({
          requestId,
          url,
          endpoint: '/api/v1/resolve/protected',
        }, '🛡️ Protected resolve request started (anti-devtool mode)');

        // Forzar uso del resolver anti-devtool sin depender de detección automática
        const result = await resolverService.resolve(url);

        const duration = Date.now() - startTime;
        incrementHttpRequest(request.method, '/api/v1/resolve/protected', 200, duration);

        getLogger().info({
          requestId,
          manifestsFound: result.manifests.length,
          duration,
        }, '🎉 Protected resolve request completed');

        return reply.status(200).send({
          sessionId: crypto.randomUUID(),
          url,
          success: result.manifests.length > 0,
          manifests: result.manifests.map(m => ({
            url: m.url,
            status: m.status,
            contentType: m.contentType,
          })),
          timings: result.timings,
          clicksPerformed: result.clicksPerformed,
          antiDevtoolEnabled: true,
        });

      } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';

        incrementHttpRequest(request.method, '/api/v1/resolve/protected', 500, duration);

        getLogger().error({
          requestId,
          url,
          error: errorMessage,
          duration,
        }, '❌ Protected resolve request failed');

        return reply.status(500).send({
          error: 'Internal Server Error',
          message: errorMessage,
          statusCode: 500,
          timestamp: new Date().toISOString(),
        });
      }
    },
  });

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

        const result = await resolverService.resolveLegacy(request.body);
        
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
