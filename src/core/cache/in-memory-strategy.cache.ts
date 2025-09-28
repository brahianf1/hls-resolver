import { getLogger } from '../observability/logger.js';
import { IActivationStrategyCache, ActivationStrategy } from './strategy-cache.interface.js';

export class InMemoryStrategyCache implements IActivationStrategyCache {
  private cache: Map<string, ActivationStrategy> = new Map();
  private readonly logger = getLogger();

  async initialize(): Promise<void> {
    this.logger.info('Initializing in-memory strategy cache...');
    this.cache.clear();
    this.logger.info('In-memory strategy cache initialized.');
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
  }
}
