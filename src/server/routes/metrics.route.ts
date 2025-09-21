import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registry } from '../../core/observability/metrics.js';
import { getLogger } from '../../core/observability/logger.js';
import pkg from 'prom-client';
const { MetricType } = pkg;

const MetricsResponseZod = z.string();

const JsonMetricsResponseZod = z.object({
  timestamp: z.string(),
  metrics: z.record(z.string(), z.number()),
  system: z.object({
    uptime: z.number(),
    memory: z.object({
      used: z.number(),
      total: z.number(),
    }),
    cpu: z.object({
      usage: z.number(),
    }),
  }),
});

const ErrorResponseZod = z.object({
  error: z.string(),
  message: z.string(),
  timestamp: z.string(),
});

export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get('/metrics', {
    schema: {
      description: 'Métricas del servicio en formato Prometheus',
      tags: ['metrics'],
      response: {
        200: MetricsResponseZod,
        500: ErrorResponseZod,
      },
    },
    handler: async (request, reply) => {
      try {
        const metrics = await registry.metrics();
        getLogger().debug({ requestId: request.id, metricsSize: metrics.length }, 'Metrics request completed');
        reply.header('Content-Type', registry.contentType);
        return reply.status(200).send(metrics);
      } catch (error) {
        getLogger().error({ requestId: request.id, error }, 'Failed to get metrics');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve metrics',
          timestamp: new Date().toISOString(),
        });
      }
    },
  });

  app.get('/metrics/json', {
    schema: {
      description: 'Métricas del servicio en formato JSON',
      tags: ['metrics'],
      response: {
        200: JsonMetricsResponseZod,
        500: ErrorResponseZod,
      },
    },
    handler: async (request, reply) => {
      try {
        const metricsJson = await registry.getMetricsAsJSON();
        const processedMetrics: Record<string, number> = {};

        for (const metric of metricsJson) {
          const values = (metric as any).values || [];
          if (values.length === 0) continue;

          if (metric.type === MetricType.Counter || metric.type === MetricType.Gauge) {
            processedMetrics[metric.name] = values[0]?.value as number ?? 0;
          } else if (metric.type  === MetricType.Histogram) {
            const countValue = values.find((v: any) => v.labels?.le === '+Inf');
            if (countValue) {
              processedMetrics[metric.name] = countValue.value as number;
            }
          }
        }

        const memoryUsage = process.memoryUsage();
        const response = {
          timestamp: new Date().toISOString(),
          metrics: processedMetrics,
          system: {
            uptime: Math.floor(process.uptime()),
            memory: {
              used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
              total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            },
            cpu: {
              usage: Math.round(process.cpuUsage().user / 1000),
            },
          },
        };

        getLogger().debug({ requestId: request.id, metricsCount: Object.keys(processedMetrics).length }, 'JSON metrics request completed');
        return reply.status(200).send(response);
      } catch (error) {
        getLogger().error({ requestId: request.id, error }, 'Failed to get JSON metrics');
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to retrieve JSON metrics',
          timestamp: new Date().toISOString(),
        });
      }
    },
  });
}
