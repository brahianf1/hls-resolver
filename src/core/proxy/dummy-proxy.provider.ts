import { IProxyProvider } from '../contracts/proxy.provider.js';

/**
 * Implementación del proveedor de proxies que no utiliza ningún proxy.
 * Se usa cuando la funcionalidad de proxy está deshabilitada.
 */
export class DummyProxyProvider implements IProxyProvider {
  /**
   * Devuelve siempre null, indicando que no se debe usar ningún proxy.
   * @returns {Promise<null>} Siempre null.
   */
  public async getProxy(): Promise<string | null> {
    return null;
  }
}
