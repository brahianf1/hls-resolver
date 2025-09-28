import { ActivationStrategyName } from "../resolver/resolver.service.js";

export interface ActivationStrategy {
  name: ActivationStrategyName;
}

export interface IActivationStrategyCache {
  initialize(): Promise<void>;
  get(domain: string): Promise<ActivationStrategy | null>;
  set(domain: string, strategy: ActivationStrategy): Promise<void>;
}
