import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HealthResponseZod, ErrorResponseZod } from '../../types/dto.js';
import { getLogger } from '../../core/observability/logger.js';
import { incrementHttpRequest, getMetricsSnapshot } from '../../core/observability/metrics.js';
import { BrowserPool } from '../../core/resolver/browser.pool.js';

const startTime = Date.now();
const version = process.env['npm_package_version'] || '1.0.0';

const DetailedHealthResponseZod = HealthResponseZod.extend({
  system: z.object({
    nodeVersion: z.string(),
    platform: z.string(),
    arch: z.string(),
    memory: z.object({ used: z.number(), total: z.number(), free: z.number() }),
    cpu: z.object({ usage: z.number(), cores: z.number() }),
  }),
  browserPool: z.object({
    browserCount: z.number(),
    activePagesCount: z.number(),
    maxConcurrentPages: z.number(),
  }).optional(),
  metrics: z.object({
    httpRequests: z.number(),
    resolveRequests: z.number(),
    activeBrowserPages: z.number(),
    hlsStreamsDetected: z.number(),
  }),
});

const ReadinessResponseZod = z.object({
  status: z.string(),
  ready: z.boolean(),
  timestamp: z.string(),
  error: z.string().optional(),
});

export async function healthRoutes(
  fastify: FastifyInstance,
  browserPool?: BrowserPool
): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  const handleHealthRequest = async (request: any, reply: any, handler: Function) => {
    const requestStartTime = Date.now();
    try {
      const response = await handler();
      const duration = Date.now() - requestStartTime;
      incrementHttpRequest(request.method, request.url, 200, duration);
      getLogger().debug({ requestId: request.id }, `Health check successful for ${request.url}`);
      return reply.status(200).send(response);
    } catch (error) {
      const duration = Date.now() - requestStartTime;
      incrementHttpRequest(request.method, request.url, 503, duration);
      getLogger().error({ requestId: request.id, error }, `Health check failed for ${request.url}`);
      return reply.status(503).send({
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }
  };

  app.get('/health', {
    schema: {
      description: 'Health check del servicio',
      tags: ['health'],
      response: { 200: HealthResponseZod, 503: ErrorResponseZod },
    },
    handler: (request, reply) => handleHealthRequest(request, reply, () => ({
      status: 'ok' as const,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version,
      timestamp: new Date().toISOString(),
    })),
  });

  app.get('/health/detailed', {
    schema: {
      description: 'Health check detallado con información del sistema',
      tags: ['health'],
      response: { 200: DetailedHealthResponseZod, 503: ErrorResponseZod },
    },
    handler: (request, reply) => handleHealthRequest(request, reply, async () => {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      const metricsSnapshot = await getMetricsSnapshot();
      const browserPoolStats = browserPool ? browserPool.getStats() : { browserCount: 0, activePagesCount: 0, maxConcurrentPages: 0 };

      return {
        status: 'ok' as const,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        version,
        timestamp: new Date().toISOString(),
        system: {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          memory: {
            used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
            total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            free: Math.round((memoryUsage.heapTotal - memoryUsage.heapUsed) / 1024 / 1024),
          },
          cpu: {
            usage: Math.round((cpuUsage.user + cpuUsage.system) / 1000),
            cores: (await import('os')).cpus().length,
          },
        },
        browserPool: browserPoolStats,
        metrics: {
          httpRequests: metricsSnapshot.httpRequests,
          resolveRequests: metricsSnapshot.resolveRequests,
          activeBrowserPages: metricsSnapshot.activeBrowserPages,
          hlsStreamsDetected: metricsSnapshot.hlsStreamsDetected,
        },
      };
    }),
  });

  app.get('/health/readiness', {
    schema: {
      description: 'Readiness probe - verifica si el servicio está listo para recibir tráfico',
      tags: ['health'],
      response: { 200: ReadinessResponseZod, 503: ReadinessResponseZod },
    },
    handler: async (request, reply) => {
      let isReady = true;
      let errorMessage = '';

      if (browserPool) {
        const stats = browserPool.getStats();
        if (stats.browserCount === 0) {
          isReady = false;
          errorMessage = 'Browser pool not initialized';
        }
      }

      const statusCode = isReady ? 200 : 503;
      const response = {
        status: isReady ? 'ready' : 'not_ready',
        ready: isReady,
        timestamp: new Date().toISOString(),
        ...(errorMessage && { error: errorMessage }),
      };

      return reply.status(statusCode).send(response);
    },
  });


  app.get('/health/liveness', {
    schema: {
      description: 'Liveness probe - verifica si el servicio está vivo',
      tags: ['health'],
      response: {
        200: z.object({ status: z.string(), alive: z.boolean(), timestamp: z.string() }),
      },
    },
    handler: (request, reply) => handleHealthRequest(request, reply, () => ({
      status: 'alive',
      alive: true,
      timestamp: new Date().toISOString(),
    })),
  });
}
