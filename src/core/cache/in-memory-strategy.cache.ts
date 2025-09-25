import { getLogger } from '../observability/logger.js';
import { IStrategyCache, Strategy } from './strategy-cache.interface.js';

export class InMemoryStrategyCache implements IStrategyCache {
  private cache: Map<string, Strategy> = new Map();
  private readonly logger = getLogger();

  async initialize(): Promise<void> {
    this.logger.info('Initializing in-memory strategy cache...');
    this.cache.clear();
    this.logger.info('In-memory strategy cache initialized.');
  }

  async get(domain: string): Promise<Strategy | null> {
    const strategy = this.cache.get(domain);
    if (strategy) {
      this.logger.debug({ domain, strategy }, 'Strategy cache hit');
      return strategy;
    }
    this.logger.debug({ domain }, 'Strategy cache miss');
    return null;
  }

  async set(domain: string, strategy: Strategy): Promise<void> {
    this.logger.debug({ domain, strategy }, 'Storing strategy in cache');
    this.cache.set(domain, strategy);
  }
}
