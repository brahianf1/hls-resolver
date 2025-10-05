import { Worker, Job } from 'bullmq';
import { URL } from 'url';
import { loadConfig, getConfig, EnvConfig } from './config/env.js';
import { createLogger, ILogger } from './core/observability/logger.js';
import { ResolverService } from './core/resolver/resolver.service.js';
import { ProxyProviderFactory } from './core/proxy/proxy.factory.js';
import { IProxyProvider } from './core/contracts/proxy.provider.js';
import { BrowserPool } from './core/resolver/browser.pool.js';
import { StrategyCacheFactory } from './core/cache/strategy-cache.factory.js';

// Tipos de datos para los trabajos
interface ResolveJobData {
  url: string;
}

// Cargar configuración al inicio
loadConfig();
const config: EnvConfig = getConfig();
const logger: ILogger = createLogger('worker', config.LOG_LEVEL);

const HLS_RESOLVER_QUEUE = 'hls-resolver';

// --- Función principal del Worker ---
async function runWorker() {
  logger.info('Starting worker process...');

  const redisUrl = new URL(config.REDIS_URL);
  const connection = {
    host: redisUrl.hostname,
    port: parseInt(redisUrl.port, 10),
  };

  // Instanciar dependencias
  const strategyCache = StrategyCacheFactory.createCache();
  const browserPool = new BrowserPool({
    browserPoolSize: config.BROWSER_POOL_SIZE,
    maxConcurrentPages: config.WORKER_CONCURRENCY, // Usar la concurrencia del worker
    headless: config.PUPPETEER_HEADLESS,
    userAgent: config.USER_AGENT,
  });
  await browserPool.initialize();

  // Instanciar el servicio de resolución y el proveedor de proxies
  const resolverService = new ResolverService(browserPool, strategyCache);
  const proxyProvider: IProxyProvider = ProxyProviderFactory.create();

  // Crear el worker de BullMQ
  const worker = new Worker<ResolveJobData>(HLS_RESOLVER_QUEUE, async (job: Job<ResolveJobData>) => {
    const { url } = job.data;
    logger.info(`Processing job ${job.id} for URL: ${url}`);

    try {
      const proxyUrl = await proxyProvider.getProxy();
      const result = await resolverService.resolve(url, proxyUrl);
      
      if (result.manifests && result.manifests.length > 0) {
        logger.info(`HLS found for ${url} in job ${job.id}`);
        // Devolver el objeto de resultado completo para mantener la consistencia del esquema.
        return result;
      } else {
        const reason = 'HLS not found after processing';
        logger.warn(`HLS not found for ${url} in job ${job.id}. Reason: ${reason}`);
        throw new Error(reason);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Job ${job.id} failed for URL ${url}. Error: ${errorMessage}`);
      throw error; // Lanzar el error para que BullMQ lo marque como fallido
    }
  }, {
    connection,
    concurrency: config.WORKER_CONCURRENCY,
    removeOnComplete: { count: 1000 }, // Mantener 1000 trabajos completados
    removeOnFail: { count: 5000 },    // Mantener 5000 trabajos fallidos
  });

  // --- Eventos del Worker ---
  worker.on('completed', (job, result) => {
    logger.debug(`Job ${job.id} has completed.`);
  });

  worker.on('failed', (job, err) => {
    // El job puede ser undefined en algunos casos de error
    if (job) {
      logger.error(`Job ${job.id} has failed with error: ${err.message}`);
    } else {
      logger.error(`A job has failed with an unknown ID. Error: ${err.message}`);
    }
  });

  worker.on('error', err => {
    logger.error('Worker encountered an error:', err);
  });

  logger.info(`Worker listening for jobs on queue: ${HLS_RESOLVER_QUEUE}`);

  // --- Manejo de cierre elegante ---
  const gracefulShutdown = async () => {
    logger.info('Shutting down worker gracefully...');
    await worker.close();
    await browserPool.shutdown(); // Asegurar que los navegadores del worker se cierren
    process.exit(0);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

// --- Iniciar el Worker ---
runWorker().catch(error => {
  logger.fatal('Failed to start worker:', error);
  process.exit(1);
});
