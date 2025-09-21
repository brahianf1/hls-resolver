import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { getLogger, logSecurityEvent } from '../observability/logger.js';
import { getAllowlistHosts } from '../../config/env.js';
import { isDomainAllowed } from '../../utils/url.js';
import { incrementSecurityEvent } from '../observability/metrics.js';

/**
 * Middleware para validar que las URLs de destino estén en la allowlist
 */
export async function validateAllowlist(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const allowedHosts = getAllowlistHosts();
  
  // Si no hay allowlist configurada, permitir todo
  if (allowedHosts.length === 0) {
    return;
  }

  const targetUrl = getTargetUrl(request);
  
  if (!targetUrl) {
    // Si no se puede extraer URL, continuar (será validado en otro lugar)
    return;
  }

  if (!isDomainAllowed(targetUrl, allowedHosts)) {
    incrementSecurityEvent('domain_not_allowed', 'error');
    logSecurityEvent('domain_not_allowed', 'error', {
      requestId: request.id,
      targetUrl,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return reply.status(403).send({
      error: 'Forbidden',
      message: `Domain not allowed: ${targetUrl}`
    });
  }

  getLogger().debug({ requestId: request.id, targetUrl }, 'Domain validated against allowlist');
}

/**
 * Extrae la URL de destino del request
 */
function getTargetUrl(request: FastifyRequest): string | undefined {
  // Para requests POST a /resolve, extraer URL del body
  if (request.method === 'POST' && request.url.includes('/resolve')) {
    const body = request.body as any;
    return body?.url;
  }

  // Para otros casos, extraer de query parameters
  const query = request.query as Record<string, unknown>;
  if (query.url && typeof query.url === 'string') {
    return query.url;
  }

  return undefined;
}

async function allowlistPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', async (request, reply) => {
    const protectedRoutes = ['/api/v1/resolve'];
    if (protectedRoutes.some(route => request.url.startsWith(route))) {
      await validateAllowlist(request, reply);
    }
  });
}

/**
 * Valida si un dominio está permitido
 */
export function isDomainInAllowlist(domain: string): boolean {
  const allowedHosts = getAllowlistHosts();
  
  if (allowedHosts.length === 0) {
    return true; // No hay restricciones
  }

  return allowedHosts.some(allowedDomain => {
    // Permitir subdominios con wildcard
    if (allowedDomain.startsWith('*.')) {
      const baseDomain = allowedDomain.slice(2);
      return domain === baseDomain || domain.endsWith(`.${baseDomain}`);
    }
    
    // Match exacto
    return domain === allowedDomain;
  });
}

/**
 * Obtiene la lista de dominios permitidos
 */
export function getAllowedDomains(): string[] {
  return getAllowlistHosts();
}

/**
 * Añade un dominio a la allowlist (runtime)
 */
export function addToAllowlist(domain: string): void {
  // Esta función sería útil para gestión dinámica de allowlist
  // Por ahora, los dominios se configuran via variables de entorno
  getLogger().info({ domain }, 'Domain would be added to allowlist (not implemented)');
}

/**
 * Remueve un dominio de la allowlist (runtime)
 */
export function removeFromAllowlist(domain: string): void {
  // Esta función sería útil para gestión dinámica de allowlist
  // Por ahora, los dominios se configuran via variables de entorno
  getLogger().info({ domain }, 'Domain would be removed from allowlist (not implemented)');
}

/**
 * Valida el formato de un dominio
 */
export function isValidDomainFormat(domain: string): boolean {
  // Regex básico para validar formato de dominio
  const domainRegex = /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  
  return domainRegex.test(domain) && domain.length <= 253;
}

/**
 * Normaliza un dominio para comparación
 */
export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim();
}

/**
 * Obtiene estadísticas de la allowlist
 */
export function getAllowlistStats(): {
  totalDomains: number;
  wildcardDomains: number;
  exactDomains: number;
  isEnabled: boolean;
} {
  const allowedHosts = getAllowlistHosts();
  const wildcardDomains = allowedHosts.filter(d => d.startsWith('*.')).length;
  
  return {
    totalDomains: allowedHosts.length,
    wildcardDomains,
    exactDomains: allowedHosts.length - wildcardDomains,
    isEnabled: allowedHosts.length > 0,
  };
}

export default fp(allowlistPlugin, { name: 'allowlist' });
