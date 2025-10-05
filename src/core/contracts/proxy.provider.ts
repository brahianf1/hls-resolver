export interface IProxyProvider {
  /**
   * Obtiene una URL de proxy para ser utilizada en una petición.
   * La implementación decidirá si devuelve un proxy de un pool rotativo,
   * uno estático o nulo si los proxies están deshabilitados.
   * 
   * @returns Una cadena con la URL del proxy o null.
   */
  getProxy(): Promise<string | null>;
}
