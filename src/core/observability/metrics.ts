import pkg from 'prom-client';

const { Registry, collectDefaultMetrics, Counter, Histogram, Gauge, MetricType } = pkg;

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'streamsuite_' });

// Métricas personalizadas
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const resolveRequestsTotal = new Counter({
  name: 'resolve_requests_total',
  help: 'Total number of resolve requests',
  labelNames: ['status', 'has_streams'],
  registers: [registry],
});

export const resolveRequestDuration = new Histogram({
  name: 'resolve_request_duration_seconds',
  help: 'Resolve request duration in seconds',
  labelNames: ['status', 'has_streams'],
  buckets: [1, 5, 10, 15, 30, 45, 60, 90, 120],
  registers: [registry],
});

export const browserPagesActive = new Gauge({
  name: 'browser_pages_active',
  help: 'Number of active browser pages',
  registers: [registry],
});

export const browserPagesTotal = new Counter({
  name: 'browser_pages_total',
  help: 'Total number of browser pages created',
  labelNames: ['status'],
  registers: [registry],
});

export const hlsStreamsDetected = new Counter({
  name: 'hls_streams_detected_total',
  help: 'Total number of HLS streams detected',
  labelNames: ['is_live', 'is_low_latency', 'has_variants'],
  registers: [registry],
});

export const navigationErrors = new Counter({
  name: 'navigation_errors_total',
  help: 'Total number of navigation errors',
  labelNames: ['error_type'],
  registers: [registry],
});

export const securityEvents = new Counter({
  name: 'security_events_total',
  help: 'Total number of security events',
  labelNames: ['event_type', 'severity'],
  registers: [registry],
});

// Función para obtener todas las métricas
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

// Función para resetear métricas (útil para tests)
export function resetMetrics(): void {
  registry.clear();
}

// Helpers para incrementar métricas comunes
export function incrementHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  duration: number
): void {
  httpRequestsTotal.inc({ method, route, status_code: statusCode.toString() });
  httpRequestDuration.observe(
    { method, route, status_code: statusCode.toString() },
    duration / 1000
  );
}

export function incrementResolveRequest(
  status: 'success' | 'error',
  hasStreams: boolean,
  duration: number
): void {
  resolveRequestsTotal.inc({ status, has_streams: hasStreams.toString() });
  resolveRequestDuration.observe(
    { status, has_streams: hasStreams.toString() },
    duration / 1000
  );
}

export function updateBrowserPages(active: number): void {
  browserPagesActive.set(active);
}

export function incrementBrowserPages(status: 'created' | 'closed' | 'error'): void {
  browserPagesTotal.inc({ status });
}

export function incrementHlsStreams(
  isLive: boolean,
  isLowLatency: boolean,
  hasVariants: boolean
): void {
  hlsStreamsDetected.inc({
    is_live: isLive.toString(),
    is_low_latency: isLowLatency.toString(),
    has_variants: hasVariants.toString(),
  });
}

export function incrementNavigationError(errorType: string): void {
  navigationErrors.inc({ error_type: errorType });
}

export function incrementSecurityEvent(
  eventType: string,
  severity: 'info' | 'warn' | 'error'
): void {
  securityEvents.inc({ event_type: eventType, severity });
}

// Función para crear snapshot de métricas importantes
export interface MetricsSnapshot {
  httpRequests: number;
  resolveRequests: number;
  activeBrowserPages: number;
  hlsStreamsDetected: number;
  navigationErrors: number;
  securityEvents: number;
  timestamp: string;
}

export async function getMetricsSnapshot(): Promise<MetricsSnapshot> {
  const metrics = await registry.getMetricsAsJSON();
  
  const findMetricValue = (name: string): number => {
    const metric = metrics.find(m => m.name === name);
    if (!metric) return 0;

    const values = (metric as any).values || [];
    if (values.length === 0) return 0;

    switch (metric.type) {
      case MetricType.Counter:
        return values.reduce((sum: number, v: { value: number }) => sum + v.value, 0);
      case MetricType.Gauge:
        return values[0]?.value || 0;
      default:
        return 0;
    }
  };

  return {
    httpRequests: findMetricValue('http_requests_total'),
    resolveRequests: findMetricValue('resolve_requests_total'),
    activeBrowserPages: findMetricValue('browser_pages_active'),
    hlsStreamsDetected: findMetricValue('hls_streams_detected_total'),
    navigationErrors: findMetricValue('navigation_errors_total'),
    securityEvents: findMetricValue('security_events_total'),
    timestamp: new Date().toISOString(),
  };
}
