import pino from 'pino';
// HACK: Estandarizar la importación de pino para compatibilidad CJS/ESM
const pinoInstance = (pino as any).default ?? pino;

import { getConfig, isDevelopment } from '../../config/env.js';

// Campos sensibles que deben ser enmascarados en logs
const SENSITIVE_FIELDS = [
  'password',
  'token',
  'authorization',
  'cookie',
  'api-key',
  'x-api-key',
  'secret',
  'key',
];

// Función para enmascarar valores sensibles
function maskSensitiveData(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(maskSensitiveData);
  }

  const masked: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_FIELDS.some(field => 
      lowerKey.includes(field)
    );
    
    if (isSensitive && typeof value === 'string') {
      masked[key] = value.length > 0 ? '***MASKED***' : '';
    } else if (typeof value === 'object' && value !== null) {
      masked[key] = maskSensitiveData(value);
    } else {
      masked[key] = value;
    }
  }
  
  return masked;
}

let loggerInstance: pino.Logger;

// Configuración del logger base
function createLogger(): pino.Logger {
  const config = getConfig();
  
  const loggerOptions: pino.LoggerOptions = {
    level: config.LOG_LEVEL,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        headers: maskSensitiveData(req.headers),
        remoteAddress: req.connection?.remoteAddress,
        remotePort: req.connection?.remotePort,
      }),
      res: (res) => ({
        statusCode: res.statusCode,
        headers: maskSensitiveData(res.getHeaders?.() || {}),
      }),
      err: pino.stdSerializers.err,
    },
  };

  // En desarrollo, usar pretty print
  if (isDevelopment()) {
    loggerOptions.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
    };
  }

  return pinoInstance(loggerOptions);
}

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    loggerInstance = createLogger();
  }
  return loggerInstance;
}

// Logger con contexto de request
export function createRequestLogger(requestId: string): pino.Logger {
  return getLogger().child({ requestId });
}

// Helper para logs de métricas
export function logMetric(
  name: string, 
  value: number, 
  labels?: Record<string, string>
): void {
  getLogger().info({
    metric: {
      name,
      value,
      labels: labels || {},
      timestamp: new Date().toISOString(),
    }
  }, `Metric: ${name} = ${value}`);
}

// Helper para logs de performance
export function logPerformance(
  operation: string,
  duration: number,
  success: boolean,
  metadata?: Record<string, unknown>
): void {
  getLogger().info({
    performance: {
      operation,
      duration,
      success,
      metadata: metadata ? maskSensitiveData(metadata) : {},
      timestamp: new Date().toISOString(),
    }
  }, `Performance: ${operation} took ${duration}ms (${success ? 'success' : 'failed'})`);
}

// Helper para logs de seguridad
export function logSecurityEvent(
  event: string,
  level: 'info' | 'warn' | 'error',
  details: Record<string, unknown>
): void {
  const maskedDetails = maskSensitiveData(details);
  
  getLogger()[level]({
    security: {
      event,
      details: maskedDetails,
      timestamp: new Date().toISOString(),
    }
  }, `Security event: ${event}`);
}
