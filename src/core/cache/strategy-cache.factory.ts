import { getConfig } from '../../config/env.js';
import { IStrategyCache } from './strategy-cache.interface.js';
import { InMemoryStrategyCache } from './in-memory-strategy.cache.js';
import { JsonStrategyCache } from './json-strategy.cache.js';
import { getLogger } from '../observability/logger.js';

export class StrategyCacheFactory {
  public static createCache(): IStrategyCache {
    const config = getConfig();
    const logger = getLogger();

    const cacheType = config.STRATEGY_CACHE_TYPE || 'memory';

    logger.info({ cacheType }, 'Creating strategy cache');

    switch (cacheType) {
      case 'json':
        return new JsonStrategyCache();
      case 'memory':
        return new InMemoryStrategyCache();
      default:
        logger.warn(`Unknown cache type: ${cacheType}. Defaulting to in-memory.`);
        return new InMemoryStrategyCache();
    }
  }
}
