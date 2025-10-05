import { IProxyProvider } from '../contracts/proxy.provider.js';
import { getConfig } from '../../config/env.js';
import { DummyProxyProvider } from './dummy-proxy.provider.js';
import { RotatingProxyProvider } from './rotating-proxy.provider.js';

/**
 * Fábrica para crear una instancia del proveedor de proxies.
 * Decide qué proveedor instanciar basándose en la configuración del entorno.
 */
export class ProxyProviderFactory {
  /**
   * Crea y devuelve una instancia de IProxyProvider.
   * 
   * @returns {IProxyProvider} Una instancia de `RotatingProxyProvider` si los proxies están habilitados,
   * de lo contrario, una instancia de `DummyProxyProvider`.
   */
  public static create(): IProxyProvider {
    const config = getConfig();

    if (config.PROXY_ENABLED) {
      return new RotatingProxyProvider();
    }

    return new DummyProxyProvider();
  }
}
