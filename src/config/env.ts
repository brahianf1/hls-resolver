import { z } from 'zod/v4';
import dotenv from 'dotenv';
import path from 'path';

const envSchema = z.object({
  // Server
  PORT: z.coerce.number(),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  STRATEGY_CACHE_TYPE: z.enum(['memory', 'json']).default('memory'),
  
  // Security
  API_KEY: z.string().optional(),
  CORS_ORIGINS: z.string().default('*'),
  ALLOWLIST_HOSTS: z.string().optional(),
  
  // Browser/Puppeteer
  PUPPETEER_HEADLESS: z.coerce.boolean().default(true),
  PUPPETEER_ENABLE_ADBLOCKER: z.coerce.boolean().default(false),
  NAV_TIMEOUT_MS: z.coerce.number().default(30000),
  MAX_WAIT_MS: z.coerce.number().default(15000),
  M3U8_DOWNLOAD_TIMEOUT_MS: z.coerce.number().default(10000),
  USER_AGENT: z.string().default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'),
  HTTP_PROXY: z.string().optional(),
  
  // Pool settings
  MAX_CONCURRENT_PAGES: z.coerce.number().default(5),
  BROWSER_POOL_SIZE: z.coerce.number().default(2),
  
  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  
  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  
  // Session
  SESSION_SECRET: z.string().default('default-secret-change-in-production'),
});

export type EnvConfig = z.infer<typeof envSchema>;

let config: EnvConfig;

export function loadConfig(): EnvConfig {
  if (config) {
    return config;
  }

  const envFile = process.env.NODE_ENV === 'production' 
    ? '.env.production' 
    : '.env.development';

  const envPath = path.resolve(process.cwd(), envFile);

  dotenv.config({ path: envPath });
  
  try {
    config = envSchema.parse(process.env);
    return config;
  } catch (error) {
    console.error('❌ Invalid environment configuration:');
    if (error instanceof z.ZodError) {
      error.issues.forEach((err) => {
        console.error(`  ${err.path.join('.')}: ${err.message}`);
      });
    }
    process.exit(1);
  }
}

export function getConfig(): EnvConfig {
  if (!config) {
    throw new Error('Configuration not loaded. Call loadConfig() first.');
  }
  return config;
}

// Helper functions
export function isDevelopment(): boolean {
  return getConfig().NODE_ENV === 'development';
}

export function isProduction(): boolean {
  return getConfig().NODE_ENV === 'production';
}

export function getAllowlistHosts(): string[] {
  const allowlist = getConfig().ALLOWLIST_HOSTS;
  if (!allowlist) return [];
  return allowlist.split(',').map(host => host.trim()).filter(Boolean);
}

export function getCorsOrigins(): string[] {
  const origins = getConfig().CORS_ORIGINS;
  if (origins === '*') return ['*'];
  return origins.split(',').map(origin => origin.trim()).filter(Boolean);
}
