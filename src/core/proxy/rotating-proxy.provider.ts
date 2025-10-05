import { IProxyProvider } from '../contracts/proxy.provider.js';
import { getConfig, EnvConfig } from '../../config/env.js';
import { getLogger } from '../observability/logger.js';

/**
 * Implementación de un proveedor de proxies que utiliza las credenciales
 * de las variables de entorno para construir la URL del proxy.
 */
export class RotatingProxyProvider implements IProxyProvider {
  private readonly config: EnvConfig;

  constructor() {
    this.config = getConfig();
  }

  /**
   * Construye y devuelve la URL del proxy utilizando la configuración del entorno.
   * Si la configuración del proxy no está completa, devuelve null.
   * 
   * @returns {Promise<string | null>} La URL del proxy o null.
   */
  public async getProxy(): Promise<string | null> {
    // Si los proxies no están habilitados, no hacer nada.
    if (!this.config.PROXY_ENABLED) {
      return null;
    }

    const { PROXY_ENDPOINT, PROXY_USERNAME, PROXY_PASSWORD } = this.config;

    if (!PROXY_ENDPOINT) {
      return null;
    }

    // Añadir una salvaguarda para no usar la URL de ejemplo por defecto.
    if (PROXY_ENDPOINT.includes('your-proxy-provider.com')) {
        getLogger().warn(
            { proxyEndpoint: PROXY_ENDPOINT }, 
            'Proxy is enabled, but the endpoint appears to be a placeholder. Skipping proxy for this request.'
        );
        return null;
    }

    // Si el endpoint ya incluye credenciales (ej. http://user:pass@host:port)
    if (PROXY_ENDPOINT.includes('@')) {
      return PROXY_ENDPOINT;
    }

    // Si las credenciales se proporcionan por separado
    if (PROXY_USERNAME && PROXY_PASSWORD) {
      const url = new URL(PROXY_ENDPOINT);
      url.username = PROXY_USERNAME;
      url.password = PROXY_PASSWORD;
      return url.toString();
    }

    return PROXY_ENDPOINT;
  }
}
