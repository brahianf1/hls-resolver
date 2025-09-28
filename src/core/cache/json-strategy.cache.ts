import fs from 'fs/promises';
import path from 'path';
import { getLogger } from '../observability/logger.js';
import { IActivationStrategyCache, ActivationStrategy } from './strategy-cache.interface.js';

const CACHE_FILE = 'strategy-cache.json';

export class JsonStrategyCache implements IActivationStrategyCache {
  private cache: Map<string, ActivationStrategy> = new Map();
  private readonly logger = getLogger();
  private cacheFilePath: string;

  constructor() {
    // Ubicar el archivo de caché en la raíz del proyecto
    this.cacheFilePath = path.join(process.cwd(), CACHE_FILE);
  }

  async initialize(): Promise<void> {
    this.logger.info(`Initializing JSON strategy cache from ${this.cacheFilePath}...`);
    try {
      const data = await fs.readFile(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(data);
      this.cache = new Map(Object.entries(parsed));
      this.logger.info(`JSON strategy cache initialized with ${this.cache.size} entries.`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.logger.warn('Cache file not found. A new one will be created.');
        this.cache.clear();
      } else {
        this.logger.error({ error }, 'Failed to initialize JSON strategy cache');
        throw error;
      }
    }
  }

  async get(domain: string): Promise<ActivationStrategy | null> {
    const strategy = this.cache.get(domain);
    if (strategy) {
      this.logger.debug({ domain, strategy: strategy.name }, 'Strategy cache hit');
      return strategy;
    }
    this.logger.debug({ domain }, 'Strategy cache miss');
    return null;
  }

  async set(domain: string, strategy: ActivationStrategy): Promise<void> {
    this.logger.debug({ domain, strategy: strategy.name }, 'Storing strategy in cache');
    this.cache.set(domain, strategy);
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      const data = JSON.stringify(Object.fromEntries(this.cache), null, 2);
      await fs.writeFile(this.cacheFilePath, data, 'utf-8');
    } catch (error) {
      this.logger.error({ error }, 'Failed to persist strategy cache');
    }
  }
}
