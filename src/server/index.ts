import { fileURLToPath } from 'url';
import { resolve } from 'path';
import Fastify from 'fastify';
import { ZodTypeProvider, validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { loadConfig, getConfig, getCorsOrigins } from '../config/env.js';
import { getLogger } from '../core/observability/logger.js';
import { BrowserPool } from '../core/resolver/browser.pool.js';
import { ResolverService } from '../core/resolver/resolver.service.js';
import apiKeyPlugin from '../core/security/api-key.js';
import allowlistPlugin from '../core/security/allowlist.js';
import { resolveRoutes } from './routes/resolve.route.js';
import { healthRoutes } from './routes/health.route.js';
import { metricsRoutes } from './routes/metrics.route.js';
import { IStrategyCache } from '../core/cache/strategy-cache.interface.js';
import { StrategyCacheFactory } from '../core/cache/strategy-cache.factory.js';

// Cargar configuración
loadConfig();
const config = getConfig();

// Crear instancia de Fastify con el Type Provider de Zod
const fastify = Fastify({
  logger: false, // Usamos nuestro logger personalizado
  requestIdHeader: 'x-request-id',
  requestIdLogLabel: 'requestId',
  genReqId: (req) => {
    return req.headers['x-request-id'] as string || 
           `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  },
}).withTypeProvider<ZodTypeProvider>();

fastify.setValidatorCompiler(validatorCompiler);
fastify.setSerializerCompiler(serializerCompiler);

// Variables globales
let browserPool: BrowserPool;
let resolverService: ResolverService;
let strategyCache: IStrategyCache;

/**
 * Configura los plugins de Fastify
 */
async function setupPlugins(): Promise<void> {
  // Plugin de CORS
  await fastify.register(cors, {
    origin: getCorsOrigins(),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-ID'],
    credentials: true,
  });

  // Plugin de Swagger (documentación)
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Stream Resolver API',
        description: 'API para resolver URLs de streams HLS',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://localhost:${config.PORT}`,
          description: 'Servidor de desarrollo',
        },
      ],
      tags: [
        { name: 'resolver', description: 'Endpoints de resolución de streams' },
        { name: 'health', description: 'Endpoints de salud del servicio' },
        { name: 'metrics', description: 'Endpoints de métricas' },
      ],
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      },
      security: [
        {
          apiKey: [],
        },
      ],
    },
  });

  // Plugin de Swagger UI
  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
    transformSpecificationClone: true,
  });

  // Plugins de seguridad
  await fastify.register(apiKeyPlugin);
  await fastify.register(allowlistPlugin);

  getLogger().info('Fastify plugins configured');
}

/**
 * Configura los hooks de Fastify
 */
function setupHooks(): void {
  // Hook para logging de requests
  fastify.addHook('onRequest', async (request, _reply) => {
    getLogger().info({
      requestId: request.id,
      method: request.method,
      url: request.url,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    }, 'Incoming request');
  });

  // Hook para logging de responses
  fastify.addHook('onResponse', async (request, reply) => {
    getLogger().info({
      requestId: request.id,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    }, 'Request completed');
  });

  // Hook para manejo de errores
  fastify.setErrorHandler(async (error, request, reply) => {
    getLogger().error({
      requestId: request.id,
      method: request.method,
      url: request.url,
      error: error.message,
      stack: error.stack,
    }, 'Request error');

    // Determinar código de estado
    let statusCode = error.statusCode || 500;
    let errorMessage = error.message;

    // No exponer detalles internos en producción
    if (statusCode === 500 && config.NODE_ENV === 'production') {
      errorMessage = 'Internal Server Error';
    }

    return reply.status(statusCode).send({
      error: getErrorName(statusCode),
      message: errorMessage,
      statusCode,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  // Hook para manejar rutas no encontradas
  fastify.setNotFoundHandler(async (request, reply) => {
    getLogger().warn({
      requestId: request.id,
      method: request.method,
      url: request.url,
      ip: request.ip,
    }, 'Route not found');

    return reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
      timestamp: new Date().toISOString(),
      requestId: request.id,
    });
  });

  getLogger().info('Fastify hooks configured');
}

/**
 * Configura las rutas de la aplicación
 */
async function setupRoutes(): Promise<void> {
  // Ruta raíz
  fastify.get('/', async (_request, reply) => {
    return reply.send({
      service: 'Stream Resolver',
      version: '1.0.0',
      status: 'running',
      timestamp: new Date().toISOString(),
      documentation: '/docs',
    });
  });

  // Registrar rutas
  await resolveRoutes(fastify, resolverService);
  await healthRoutes(fastify, browserPool);
  await metricsRoutes(fastify);

  getLogger().info('Routes configured');
}

/**
 * Inicializa los servicios principales
 */
async function initializeServices(): Promise<void> {
  getLogger().info('Initializing services...');

  // Inicializar cache de estrategias
  strategyCache = StrategyCacheFactory.createCache();
  await strategyCache.initialize();

  // Inicializar browser pool
  browserPool = new BrowserPool({
    maxConcurrentPages: config.MAX_CONCURRENT_PAGES,
    browserPoolSize: config.BROWSER_POOL_SIZE,
    headless: config.PUPPETEER_HEADLESS,
    userAgent: config.USER_AGENT,
    proxy: config.HTTP_PROXY || undefined,
  });

  await browserPool.initialize();
  getLogger().info('Browser pool initialized');

  // Inicializar resolver service
  resolverService = new ResolverService(browserPool, strategyCache);
  getLogger().info('Resolver service initialized');

  getLogger().info('All services initialized successfully');
}

/**
 * Inicia el servidor
 */
async function startServer(): Promise<void> {
  try {
    await fastify.listen({
      host: config.HOST,
      port: config.PORT,
    });

    getLogger().info({
      host: config.HOST,
      port: config.PORT,
      nodeEnv: config.NODE_ENV,
      docs: `http://${config.HOST}:${config.PORT}/docs`,
    }, 'Server started successfully');

  } catch (error) {
    getLogger().error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

/**
 * Maneja el cierre ordenado del servidor
 */
async function gracefulShutdown(signal: string): Promise<void> {
  getLogger().info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

  try {
    // Cerrar servidor HTTP
    await fastify.close();
    getLogger().info('HTTP server closed');

    // Cerrar browser pool
    if (browserPool) {
      await browserPool.shutdown();
      getLogger().info('Browser pool closed');
    }

    getLogger().info('Graceful shutdown completed');
    process.exit(0);

  } catch (error) {
    getLogger().error({ error }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

/**
 * Función principal
 */
async function main(): Promise<void> {
  try {
    getLogger().info({
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      nodeEnv: config.NODE_ENV,
    }, 'Starting Stream Resolver service...');

    // Configurar plugins
    await setupPlugins();

    // Configurar hooks
    setupHooks();

    // Inicializar servicios
    await initializeServices();

    // Configurar rutas
    await setupRoutes();

    // Configurar manejo de señales
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Manejar errores no capturados
    process.on('uncaughtException', (error) => {
      getLogger().fatal({ error }, 'Uncaught exception');
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      getLogger().fatal({ reason, promise }, 'Unhandled rejection');
      process.exit(1);
    });

    // Iniciar servidor
    await startServer();

  } catch (error) {
    getLogger().fatal({ error }, 'Failed to start application');
    process.exit(1);
  }
}

/**
 * Obtiene el nombre del error basado en el código de estado
 */
function getErrorName(statusCode: number): string {
  const errorNames: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };

  return errorNames[statusCode] || 'Unknown Error';
}

// Ejecutar aplicación si es el módulo principal
if (import.meta.url.startsWith('file:')) { 
  const modulePath = fileURLToPath(import.meta.url);
  if (process.argv[1] === modulePath) {
    main().catch((error) => {
      console.error('Failed to start application:', error);
      process.exit(1);
    });
  }
}

export { fastify, main };
