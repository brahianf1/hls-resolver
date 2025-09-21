import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { getLogger, logSecurityEvent } from '../observability/logger.js';
import { getConfig } from '../../config/env.js';
import { incrementSecurityEvent } from '../observability/metrics.js';

/**
 * Middleware para validar API Key
 */
export async function validateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const config = getConfig();
  
  // Si no hay API key configurada, permitir acceso
  if (!config.API_KEY) {
    return;
  }

  const providedKey = extractApiKey(request);
  
  if (!providedKey) {
    incrementSecurityEvent('api_key_missing', 'warn');
    logSecurityEvent('api_key_missing', 'warn', {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      url: request.url,
    });

    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'API key is required',
      statusCode: 401,
      timestamp: new Date().toISOString(),
    });
  }

  if (!isValidApiKey(providedKey, config.API_KEY)) {
    incrementSecurityEvent('api_key_invalid', 'error');
    logSecurityEvent('api_key_invalid', 'error', {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      url: request.url,
      providedKeyPrefix: providedKey.substring(0, 8) + '...',
    });

    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Invalid API key',
      statusCode: 403,
      timestamp: new Date().toISOString(),
    });
  }

  // Log acceso exitoso
  logSecurityEvent('api_key_valid', 'info', {
    ip: request.ip,
    url: request.url,
  });
}

/**
 * Extrae la API key del request
 */
function extractApiKey(request: FastifyRequest): string | undefined {
  // Intentar obtener de diferentes headers
  const possibleHeaders = [
    'x-api-key',
    'api-key',
    'authorization',
    'x-auth-token',
  ];

  for (const header of possibleHeaders) {
    const value = request.headers[header] as string;
    if (value) {
      // Si es Authorization header, extraer el token
      if (header === 'authorization') {
        const match = value.match(/^Bearer\s+(.+)$/i);
        if (match) {
          return match[1];
        }
        // Si no tiene Bearer, usar el valor completo
        return value;
      }
      return value;
    }
  }

  // Intentar obtener de query parameters
  const query = request.query as Record<string, unknown>;
  if (query.api_key && typeof query.api_key === 'string') {
    return query.api_key;
  }

  return undefined;
}

/**
 * Valida si la API key es correcta
 */
function isValidApiKey(provided: string, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }

  // Comparación segura usando crypto.timingSafeEqual si están disponibles
  try {
    if (provided.length !== expected.length) {
      return false;
    }

    // Usar Buffer.compare para comparación timing-safe
    const providedBuffer = Buffer.from(provided, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    
    return providedBuffer.length === expectedBuffer.length && 
           Buffer.compare(providedBuffer, expectedBuffer) === 0;
  } catch (error) {
    getLogger().error({ error }, 'Error during API key validation');
    return false;
  }
}

async function apiKeyPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', async (request, reply) => {
    await validateApiKey(request, reply);
  });
}

/**
 * Genera una API key segura
 */
export function generateApiKey(length = 32): string {
  const crypto = require('crypto');
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Valida el formato de una API key
 */
export function isValidApiKeyFormat(apiKey: string): boolean {
  // Debe tener al menos 16 caracteres y solo caracteres alfanuméricos
  return /^[a-zA-Z0-9]{16,}$/.test(apiKey);
}

/**
 * Middleware para rutas que requieren API key específicamente
 */
export function requireApiKey() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await validateApiKey(request, reply);
  };
}

// Plugin de Fastify para API key validation
export default fp(apiKeyPlugin, { name: 'apiKey' });
