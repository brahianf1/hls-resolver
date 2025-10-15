import type { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import puppeteerDefault from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getLogger } from '../observability/logger.js';
import { getConfig } from '../../config/env.js';
import { applyAntiDevtoolProtection } from './bypasses/anti-devtool-bypass.js';
import { RequestInterceptorFactory } from './interceptors/request-interceptor.js';

// HACK: Estandarizar la importación de puppeteer-extra para compatibilidad CJS/ESM
const puppeteer = (puppeteerDefault as any).default ?? puppeteerDefault;

// Configurar puppeteer con stealth plugin
puppeteer.use(StealthPlugin());

/**
 * Opciones para crear una página anti-devtool
 */
export interface AntiDevtoolPageOptions {
  url: string;
  sessionId: string;
  userAgent?: string;
  viewport?: {
    width: number;
    height: number;
  };
}

/**
 * Clase especializada para manejar sitios con bloqueadores anti-devtool.
 * 
 * Diferencias clave con BrowserPage normal:
 * 1. Flags de Chrome optimizados para anti-detección
 * 2. Request interceptor con reglas anti-devtool
 * 3. Bypass scripts inyectados antes de navegación
 * 4. Configuración de página más agresiva
 */
export class AntiDevtoolBrowserPage {
  private browser?: Browser;
  private page?: Page;
  private sessionId: string;
  private config = getConfig();
  private isReleased = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Crea y configura el navegador con flags anti-detección optimizados.
   * 
   * Flags críticos basados en Browserless y mejores prácticas:
   * - --disable-blink-features=AutomationControlled: Oculta automatización
   * - --no-sandbox: Necesario para Docker
   * - --disable-dev-shm-usage: Evita problemas de memoria compartida
   */
  async initialize(options: AntiDevtoolPageOptions): Promise<void> {
    try {
      getLogger().info(
        { sessionId: this.sessionId },
        'Initializing Anti-Devtool Browser Page',
      );

      // Flags optimizados para anti-detección (basados en Browserless)
      const launchOptions: PuppeteerLaunchOptions = {
        headless: this.config.PUPPETEER_HEADLESS ? 'new' : false,
        args: [
          // === CRÍTICO: Flags anti-detección ===
          '--disable-blink-features=AutomationControlled', // ⭐ Oculta que es automatizado
          
          // === Seguridad y estabilidad ===
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          
          // === Performance ===
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          
          // === Tamaño de ventana ===
          '--window-size=1920,1080',
          
          // === Desactivar funciones innecesarias ===
          '--disable-extensions',
          '--disable-plugins',
          '--disable-component-extensions-with-background-pages',
          '--disable-default-apps',
          '--disable-sync',
          
          // === Audio/Video (necesario para reproductores) ===
          '--autoplay-policy=no-user-gesture-required',
          '--disable-features=MediaRouter',
          
          // === Idioma ===
          '--lang=es-ES,es',
        ],
      };

      // Lanzar navegador temporal para esta petición
      this.browser = await puppeteer.launch(launchOptions);
      
      if (!this.browser) {
        throw new Error('Failed to launch browser');
      }
      
      getLogger().debug(
        { sessionId: this.sessionId },
        'Anti-devtool browser launched',
      );

      // Crear página
      this.page = await this.browser.newPage();

      // Configurar la página
      await this.configurePage(options);

      getLogger().info(
        { sessionId: this.sessionId },
        'Anti-devtool browser page initialized successfully',
      );
    } catch (error) {
      getLogger().error(
        { sessionId: this.sessionId, error },
        'Failed to initialize anti-devtool browser page',
      );
      throw error;
    }
  }

  /**
   * Configura la página con todas las protecciones anti-devtool
   */
  private async configurePage(options: AntiDevtoolPageOptions): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    // 1. Configurar User Agent
    const userAgent =
      options.userAgent ||
      this.config.USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
    
    await this.page.setUserAgent(userAgent);

    // 2. Configurar Viewport
    await this.page.setViewport({
      width: options.viewport?.width || 1920,
      height: options.viewport?.height || 1080,
      deviceScaleFactor: 1,
    });

    // 3. Configurar timeouts
    this.page.setDefaultNavigationTimeout(this.config.NAV_TIMEOUT_MS);
    this.page.setDefaultTimeout(this.config.MAX_WAIT_MS);

    // 4. ⭐ CRÍTICO: Aplicar bypass anti-devtool ANTES de todo
    await applyAntiDevtoolProtection(this.page, this.sessionId);

    // 5. ⭐ CRÍTICO: Configurar request interceptor UNIFICADO
    await this.page.setRequestInterception(true);
    
    const interceptor = RequestInterceptorFactory.createAntiDevtool(this.sessionId);
    this.page.on('request', interceptor.getHandler());
    
    getLogger().debug(
      { sessionId: this.sessionId },
      'Request interceptor configured with anti-devtool rules',
    );

    // 6. Configurar extra headers si es necesario
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    // 7. Manejar errores de página
    this.page.on('error', (error) => {
      getLogger().error(
        { sessionId: this.sessionId, error },
        'Anti-devtool page error occurred',
      );
    });

    this.page.on('pageerror', (error) => {
      getLogger().debug(
        { sessionId: this.sessionId, error: error.message },
        'Anti-devtool page script error',
      );
    });

    // 8. Log de console para debugging
    if (this.config.LOG_LEVEL === 'debug') {
      this.page.on('console', (msg) => {
        if (msg.text().includes('[Anti-Devtool Bypass]')) {
          getLogger().info(
            { sessionId: this.sessionId, message: msg.text() },
            'Anti-devtool bypass message',
          );
        }
      });
    }
  }

  /**
   * Obtiene la instancia de la página
   */
  getPage(): Page {
    if (!this.page || this.isReleased) {
      throw new Error('Page not available');
    }
    return this.page;
  }

  /**
   * Navega a una URL
   */
  async navigateTo(
    url: string,
    options?: {
      waitUntil?: 'domcontentloaded' | 'networkidle2' | 'networkidle0';
      timeout?: number;
    },
  ): Promise<void> {
    const page = this.getPage();

    try {
      getLogger().info(
        { sessionId: this.sessionId, url },
        'Navigating to URL with anti-devtool protection',
      );

      await page.goto(url, {
        waitUntil: options?.waitUntil || 'domcontentloaded',
        timeout: options?.timeout || this.config.NAV_TIMEOUT_MS,
      });

      getLogger().debug(
        { sessionId: this.sessionId },
        'Navigation completed',
      );
    } catch (error) {
      getLogger().error(
        { sessionId: this.sessionId, error, url },
        'Navigation failed',
      );
      throw error;
    }
  }

  /**
   * Espera un tiempo específico
   */
  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Libera recursos y cierra el navegador
   */
  async release(): Promise<void> {
    if (this.isReleased) {
      return;
    }

    this.isReleased = true;

    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close();
      }
    } catch (error) {
      getLogger().error(
        { sessionId: this.sessionId, error },
        'Error closing page',
      );
    }

    try {
      if (this.browser && this.browser.isConnected()) {
        await this.browser.close();
      }
    } catch (error) {
      getLogger().error(
        { sessionId: this.sessionId, error },
        'Error closing browser',
      );
    }

    getLogger().debug(
      { sessionId: this.sessionId },
      'Anti-devtool browser page released',
    );
  }

  /**
   * Verifica si la página está liberada
   */
  isPageReleased(): boolean {
    return this.isReleased;
  }
}

