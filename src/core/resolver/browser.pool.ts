import puppeteerDefault from 'puppeteer-extra';
import { PuppeteerBlocker } from '@ghostery/adblocker-puppeteer';
import fetch from 'cross-fetch';
import { promises as fs } from 'node:fs';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import pLimit from 'p-limit';
import { z } from 'zod';
import { BrowserPoolOptions } from '../../types/dto.js';
import { getLogger } from '../observability/logger.js';
import { 
  updateBrowserPages, 
  incrementBrowserPages,
  incrementNavigationError 
} from '../observability/metrics.js';
import { getConfig } from '../../config/env.js';

// HACK: Estandarizar la importación de puppeteer-extra para compatibilidad CJS/ESM
const puppeteer = (puppeteerDefault as any).default ?? puppeteerDefault;

// Configurar puppeteer con stealth plugin
puppeteer.use(StealthPlugin());

const LaunchOptionsZod = z.object({
  headless: z.union([z.boolean(), z.literal('new')]).optional(),
  args: z.array(z.string()).optional(),
  ignoreDefaultArgs: z.union([z.boolean(), z.array(z.string())]).optional(),
});

export class BrowserPool {
  private browsers: Browser[] = [];
  private pageLimit: ReturnType<typeof pLimit>;
  private activePagesCount = 0;
  private options: BrowserPoolOptions;
  private isShuttingDown = false;
  // Adblocker compartido para todas las páginas del pool
  private adBlocker?: PuppeteerBlocker;
  private adBlockerReady?: Promise<void>;

  constructor(options: BrowserPoolOptions) {
    this.options = options;
    this.pageLimit = pLimit(options.maxConcurrentPages);

    // Activar adblocker por defecto, a menos que se deshabilite explícitamente
    const _cfg = getConfig?.();
    if (_cfg?.PUPPETEER_ENABLE_ADBLOCKER !== false) {
      this.initializeAdBlocker();
    }
    
    // Manejar señales de cierre
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  /**
   * Inicializa el pool de navegadores
   */
  async initialize(): Promise<void> {
    getLogger().info({
      browserPoolSize: this.options.browserPoolSize,
      maxConcurrentPages: this.options.maxConcurrentPages,
      headless: this.options.headless,
    }, 'Initializing browser pool');

    try {
      for (let i = 0; i < this.options.browserPoolSize; i++) {
        const browser = await this.createBrowser();
        this.browsers.push(browser);
        getLogger().debug({ browserIndex: i }, 'Browser created in pool');
      }
      
      getLogger().info({ browsersCreated: this.browsers.length }, 'Browser pool initialized');
    } catch (error) {
      getLogger().error({ error }, 'Failed to initialize browser pool');
      throw error;
    }
  }

  /**
   * Inicializa el adblocker
   */
  private initializeAdBlocker(): void {
    // Inicializar el bloqueador con listas precompiladas (ads + tracking), con caché binaria opcional
    // Debe hacerse una sola vez por proceso para evitar sobrecarga en el arranque
    try {
      this.adBlockerReady = PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: 'engine.bin',
        read: fs.readFile,
        write: fs.writeFile,
      }).then((blocker) => {
        this.adBlocker = blocker;
        getLogger().info('Adblocker initialized successfully');
      });
    } catch (error) {
      getLogger().warn({ error }, 'Failed to initialize adblocker, continuing without it');
      // Si falla la carga de listas, continuar sin bloquear, para no romper el flujo
    }
  }

  /**
   * Crea un nuevo navegador con la configuración especificada
   */
  private async createBrowser(): Promise<Browser> {
    const launchOptions: PuppeteerLaunchOptions = {
      headless: this.options.headless ? 'new' : false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-images', // No cargar imágenes para mejor performance
        '--disable-javascript-harmony-shipping',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-component-extensions-with-background-pages',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
    };

    // Configurar proxy si está especificado
    // if (this.options.proxy) {
    //   launchOptions.args?.push(`--proxy-server=${this.options.proxy}`);
    // }

    try {
      // Validar las opciones antes de lanzar el navegador
      const validatedOptions = LaunchOptionsZod.parse(launchOptions);
      const browser = await puppeteer.launch(validatedOptions);
      
      // Manejar eventos del navegador
      browser.on('disconnected', () => {
        getLogger().warn('Browser disconnected');
      });

      return browser;
    } catch (error) {
      incrementNavigationError('browser_launch_failed');
      getLogger().error({ error, options: launchOptions }, 'Failed to launch browser');
      throw error;
    }
  }

  /**
   * Obtiene una página del pool con límite de concurrencia
   */
  async getPage(): Promise<BrowserPage> {
    if (this.isShuttingDown) {
      throw new Error('Browser pool is shutting down');
    }

    return this.pageLimit(async () => {
      try {
        const browser = await this.getAvailableBrowser();
        const page = await browser.newPage();
        
        this.activePagesCount++;
        updateBrowserPages(this.activePagesCount);
        incrementBrowserPages('created');

        // Configurar página
        await this.configurePage(page);

        getLogger().debug({ activePagesCount: this.activePagesCount }, 'Page created from pool');

        return new BrowserPage(page, () => this.releasePage());
      } catch (error) {
        incrementBrowserPages('error');
        getLogger().error({ error }, 'Failed to create page from pool');
        throw error;
      }
    });
  }

  /**
   * Configura una página con las opciones por defecto
   */
  private async configurePage(page: Page): Promise<void> {
    // Habilitar bloqueo de anuncios ANTES de cualquier navegación
    try {
      if (this.adBlocker) {
        await (this.adBlocker as PuppeteerBlocker).enableBlockingInPage(page);
      } else if (this.adBlockerReady) {
        try {
          await this.adBlockerReady;
          if (this.adBlocker) {
            await (this.adBlocker as PuppeteerBlocker).enableBlockingInPage(page);
          }
        } catch {
          // Si falla la inicialización, seguir sin adblocker
        }
      }
    } catch (error) {
      getLogger().warn({ error }, 'Failed to enable ad blocker, continuing without it');
    }
    
    // Configurar user agent
    await page.setUserAgent(this.options.userAgent);

    // Configurar viewport
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    });

    // Configurar timeouts
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(15000);

    // Interceptar requests para optimización y bloqueo de anuncios
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      try {
        const resourceType = request.resourceType();
        const url = request.url().toLowerCase();
        
        // Lista de dominios de anuncios conocidos
        const adDomains = [
          'ads-twitter.com',
          'imasdk.googleapis.com',
          'googleads.com',
          'googlesyndication.com',
          'doubleclick.net',
          'ptichoolsougn.net',
          'campfirecroutondecorator.com',
          'jilliandescribecompany.com/log',
          'static.ads-twitter.com',
          'facebook.com/tr',
          'analytics.google.com',
          'googletagmanager.com',
          'google-analytics.com'
        ];
        
        // Bloquear dominios de anuncios
        if (adDomains.some(domain => url.includes(domain))) {
          request.abort().catch(() => {});
          return;
        }
        
        // Bloquear requests de tracking y analytics
        if (url.includes('/log_js_error') || 
            url.includes('/analytics') || 
            url.includes('/tracking') ||
            url.includes('/metrics') ||
            url.includes('/ping') ||
            url.includes('ima3.js') ||
            url.includes('vignette.min.js') ||
            url.includes('uwt.js')) {
          request.abort().catch(() => {});
          return;
        }
        
        // Permitir recursos importantes para HLS y streaming
        if (
          url.includes('.m3u8') ||
          url.includes('.ts') ||
          url.includes('manifest') ||
          url.includes('playlist') ||
          url.includes('hls') ||
          url.includes('orbitcache.com') ||
          url.includes('urlset') ||
          resourceType === 'media' ||
          resourceType === 'xhr' ||
          resourceType === 'fetch' ||
          resourceType === 'document' ||
          resourceType === 'script'
        ) {
          // Log HLS/streaming resources
          if (url.includes('m3u8') || url.includes('hls') || url.includes('orbitcache')) {
            getLogger().info({ url, resourceType }, 'Allowing potential HLS resource');
          }
          request.continue().catch(() => {});
        }
        // Bloquear recursos innecesarios 
        else if (['image', 'stylesheet', 'font'].includes(resourceType)) {
          // Permitir solo thumbnails importantes
          if (url.includes('thumb') || url.includes('preview') || url.includes('poster')) {
            request.continue().catch(() => {});
          } else {
            request.abort().catch(() => {});
          }
        } else {
          request.continue().catch(() => {});
        }
      } catch (error) {
        try {
          getLogger().error({ error }, 'Error in request handler');
          request.continue().catch(() => {});
        } catch {
          // Fallback silencioso
        }
      }
    });

    // Manejar errores de página
    page.on('error', (error) => {
      getLogger().error({ error }, 'Page error occurred');
    });

    page.on('pageerror', (error) => {
      getLogger().error({ error }, 'Page script error occurred');
    });
  }

  /**
   * Obtiene un navegador disponible del pool
   */
  private async getAvailableBrowser(): Promise<Browser> {
    // Simple round-robin selection
    const browser = this.browsers[Math.floor(Math.random() * this.browsers.length)];
    
    if (!browser || !browser.isConnected()) {
      // Re-crear el navegador si se desconectó
      getLogger().warn('Browser disconnected, attempting to recreate...');
      const newBrowser = await this.createBrowser();
      this.browsers = this.browsers.map(b => (b === browser ? newBrowser : b));
      return newBrowser;
    }
    
    return browser;
  }

  /**
   * Libera una página del pool
   */
  private releasePage(): void {
    this.activePagesCount = Math.max(0, this.activePagesCount - 1);
    updateBrowserPages(this.activePagesCount);
    incrementBrowserPages('closed');
    
    getLogger().debug({ activePagesCount: this.activePagesCount }, 'Page released to pool');
  }

  /**
   * Obtiene estadísticas del pool
   */
  getStats(): {
    browserCount: number;
    activePagesCount: number;
    maxConcurrentPages: number;
  } {
    return {
      browserCount: this.browsers.length,
      activePagesCount: this.activePagesCount,
      maxConcurrentPages: this.options.maxConcurrentPages,
    };
  }

  /**
   * Cierra el pool de navegadores
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    
    this.isShuttingDown = true;
    getLogger().info('Shutting down browser pool...');

    try {
      // Esperar a que todas las páginas activas se liberen
      await this.pageLimit.clearQueue();

      // Cerrar todos los navegadores
      await Promise.all(
        this.browsers.map(async (browser, index) => {
          try {
            if (browser.isConnected()) {
              await browser.close();
              getLogger().debug({ browserIndex: index }, 'Browser closed');
            }
          } catch (error) {
            getLogger().error({ error, browserIndex: index }, 'Error closing browser');
          }
        })
      );

      this.browsers = [];
      this.activePagesCount = 0;
      updateBrowserPages(0);
      
      getLogger().info('Browser pool shutdown completed');
    } catch (error) {
      getLogger().error({ error }, 'Error during browser pool shutdown');
      throw error;
    }
  }
}

/**
 * Wrapper para páginas del navegador con auto-cleanup
 */
export class BrowserPage {
  private page: Page;
  private releaseCallback: () => void;
  private isReleased = false;

  constructor(page: Page, releaseCallback: () => void) {
    this.page = page;
    this.releaseCallback = releaseCallback;
  }

  /**
   * Obtiene la página de Puppeteer
   */
  getPage(): Page {
    if (this.isReleased) {
      throw new Error('Page has been released');
    }
    return this.page;
  }

  /**
   * Navega a una URL con opciones de espera
   */
  async navigateTo(
    url: string, 
    options?: {
      waitUntil?: 'domcontentloaded' | 'networkidle2' | 'networkidle0';
      timeout?: number;
    }
  ): Promise<void> {
    const page = this.getPage();
    
    try {
      await page.goto(url, {
        waitUntil: options?.waitUntil || 'domcontentloaded',
        timeout: options?.timeout || 30000,
      });
    } catch (error) {
      incrementNavigationError('navigation_failed');
      getLogger().error({ error, url }, 'Navigation failed');
      throw error;
    }
  }

  /**
   * Espera por un tiempo específico
   */
  async wait(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Espera por un selector
   */
  async waitForSelector(selector: string, timeout = 5000): Promise<void> {
    const page = this.getPage();
    await page.waitForSelector(selector, { timeout });
  }

  /**
   * Libera la página y limpia recursos
   */
  async release(): Promise<void> {
    if (this.isReleased) {
      return;
    }

    try {
      // Cerrar la página
      if (!this.page.isClosed()) {
        await this.page.close();
      }
    } catch (error) {
      getLogger().error({ error }, 'Error closing page');
    } finally {
      this.isReleased = true;
      if (this.releaseCallback) {
        this.releaseCallback();
      }
    }
  }
}
