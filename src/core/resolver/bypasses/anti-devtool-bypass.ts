import type { Page } from 'puppeteer';
import { getLogger } from '../../observability/logger.js';

/**
 * Script de bypass completo basado en el código exitoso de n8n/Browserless.
 * 
 * Este script se inyecta ANTES de cualquier otro script de la página usando
 * evaluateOnNewDocument, lo que garantiza que el mock esté presente cuando
 * disable-devtool intente cargarse.
 * 
 * Técnicas implementadas:
 * 1. Mock completo del objeto DisableDevtool
 * 2. Sobrescritura de navigator.webdriver
 * 3. Neutralización de detección por dimensiones de ventana
 * 4. Bloqueo de debugger statements
 */
export const ANTI_DEVTOOL_BYPASS_SCRIPT = `
(function() {
    'use strict';
    
    // =============================================================================
    // 1. MOCK COMPLETO DE DisableDevtool (CRÍTICO)
    // =============================================================================
    // Crear el objeto mock ANTES de que se cargue el script real
    // Si el script se carga desde un CDN que no bloqueamos, encontrará este objeto
    window.DisableDevtool = {
        isRunning: false,
        isSuspend: true,
        md5: () => '',
        version: '0.0.0',
        DetectorType: {},
        isDevToolOpened: () => false,
        // Métodos adicionales que podrían ser verificados
        setDetectDelay: () => {},
        ondetect: () => {},
        md5Script: () => '',
        clearLog: () => {}
    };
    
    // =============================================================================
    // 2. SOBRESCRITURA DE navigator.webdriver (CRÍTICO)
    // =============================================================================
    Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
        configurable: true
    });
    
    // Eliminar del prototipo también
    try {
        delete navigator.__proto__.webdriver;
    } catch(e) {}
    
    // =============================================================================
    // 3. NEUTRALIZAR DETECCIÓN POR DIMENSIONES DE VENTANA
    // =============================================================================
    // Algunos anti-devtools detectan si outer !== inner (indica devtools abierto)
    Object.defineProperty(window, 'outerWidth', {
        get: () => window.innerWidth,
        configurable: true
    });
    Object.defineProperty(window, 'outerHeight', {
        get: () => window.innerHeight,
        configurable: true
    });
    
    // =============================================================================
    // 4. BLOQUEAR DEBUGGER STATEMENTS
    // =============================================================================
    // Anti-devtools a menudo usa debugger en loops para detectar devtools
    const originalSetInterval = window.setInterval;
    const originalSetTimeout = window.setTimeout;
    
    window.setInterval = function(callback, delay, ...args) {
        // Bloquear timers que contienen debugger
        if (typeof callback === 'string' && callback.includes('debugger')) {
            return -1;
        }
        if (typeof callback === 'function') {
            const callbackStr = callback.toString();
            if (callbackStr.includes('debugger')) {
                // Retornar un ID falso pero no ejecutar
                return -1;
            }
        }
        return originalSetInterval.apply(this, [callback, delay, ...args]);
    };
    
    window.setTimeout = function(callback, delay, ...args) {
        // Bloquear timers que contienen debugger
        if (typeof callback === 'string' && callback.includes('debugger')) {
            return -1;
        }
        if (typeof callback === 'function') {
            const callbackStr = callback.toString();
            if (callbackStr.includes('debugger')) {
                return -1;
            }
        }
        return originalSetTimeout.apply(this, [callback, delay, ...args]);
    };
    
    // =============================================================================
    // 5. NEUTRALIZAR LISTENERS DE RESIZE
    // =============================================================================
    // Anti-devtools monitorea cambios de tamaño para detectar apertura de devtools
    const originalAddEventListener = window.addEventListener;
    window.addEventListener = function(type, listener, options) {
        if (type === 'resize') {
            // No registrar listeners de resize que podrían ser de anti-devtools
            return;
        }
        return originalAddEventListener.apply(this, [type, listener, options]);
    };
    
    // Sobrescribir handler directo
    window.onresize = null;
    
    // =============================================================================
    // 6. PREVENIR RECARGAS Y REDIRECTS FORZADOS
    // =============================================================================
    // Anti-devtools puede intentar recargar o redirigir la página
    const originalReload = window.location.reload;
    window.location.reload = function() {
        console.log('[Anti-Devtool Bypass] Blocked reload attempt');
        return false;
    };
    
    try {
        const originalHref = window.location.href;
        Object.defineProperty(window.location, 'href', {
            set: (value) => {
                // Solo permitir cambios a la misma página
                if (value !== originalHref) {
                    console.log('[Anti-Devtool Bypass] Blocked redirect to:', value);
                    return;
                }
            },
            get: () => originalHref,
            configurable: true
        });
    } catch(e) {}
    
    // =============================================================================
    // 7. NEUTRALIZAR CONSOLE TRAPS
    // =============================================================================
    // Algunos anti-devtools intentan detectar console.log modificado
    const originalConsole = window.console;
    try {
        // Clonar console para mantener funcionalidad
        const consoleClone = Object.create(originalConsole);
        Object.setPrototypeOf(consoleClone, originalConsole);
        window.console = consoleClone;
    } catch(e) {}
    
    // =============================================================================
    // 8. PROTEGER RegExp.toString
    // =============================================================================
    const originalRegExpToString = RegExp.prototype.toString;
    RegExp.prototype.toString = function() {
        try {
            return originalRegExpToString.call(this);
        } catch (e) {
            return '';
        }
    };
    
    // =============================================================================
    // 9. BLOQUEAR Function.prototype.toString TRAPS
    // =============================================================================
    const originalFunctionToString = Function.prototype.toString;
    Function.prototype.toString = function() {
        if (this === window.setInterval || this === window.setTimeout) {
            // Retornar código nativo para timers sobrescritos
            return 'function() { [native code] }';
        }
        return originalFunctionToString.call(this);
    };
    
    console.log('[Anti-Devtool Bypass] Successfully injected - DisableDevtool neutralized');
})();
`;

/**
 * Inyecta el script de bypass en una página ANTES de cualquier navegación.
 * Debe llamarse antes de page.goto().
 * 
 * @param page - Instancia de la página de Puppeteer
 * @param sessionId - ID de sesión para logging (opcional)
 */
export async function injectAntiDevtoolBypass(page: Page, sessionId?: string): Promise<void> {
  try {
    await page.evaluateOnNewDocument(ANTI_DEVTOOL_BYPASS_SCRIPT);
    
    getLogger().info(
      { sessionId },
      'Anti-devtool bypass script injected successfully',
    );
  } catch (error) {
    getLogger().error(
      { sessionId, error },
      'Failed to inject anti-devtool bypass script',
    );
    throw error;
  }
}

/**
 * Configuración adicional de la página para máxima evasión.
 * Debe llamarse después de crear la página pero antes de navegar.
 * 
 * @param page - Instancia de la página de Puppeteer
 * @param sessionId - ID de sesión para logging (opcional)
 */
export async function configureAntiDetection(page: Page, sessionId?: string): Promise<void> {
  try {
    // 1. Deshabilitar Service Workers (pueden ser usados para detección)
    await page.setBypassServiceWorker(true);
    
    // 2. Configurar permisos para evitar prompts
    const context = page.browserContext();
    await context.overridePermissions(page.url() || 'https://example.com', [
      'geolocation',
      'notifications',
    ]);
    
    // 3. Bloquear alertas, confirms y prompts que pueden interrumpir
    await page.evaluateOnNewDocument(() => {
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => null;
      
      // Bloquear window.open
      window.open = () => null;
    });
    
    getLogger().debug(
      { sessionId },
      'Anti-detection configuration applied',
    );
  } catch (error) {
    getLogger().warn(
      { sessionId, error },
      'Failed to apply some anti-detection configurations',
    );
  }
}

/**
 * Aplica todas las configuraciones anti-devtool a una página.
 * Esta es la función principal que debe llamarse.
 * 
 * @param page - Instancia de la página de Puppeteer
 * @param sessionId - ID de sesión para logging (opcional)
 */
export async function applyAntiDevtoolProtection(
  page: Page,
  sessionId?: string,
): Promise<void> {
  await injectAntiDevtoolBypass(page, sessionId);
  await configureAntiDetection(page, sessionId);
  
  getLogger().info(
    { sessionId },
    'Anti-devtool protection fully applied',
  );
}

