export interface Strategy {
  selector?: string;
  timeout: number;
}

export interface IStrategyCache {
  initialize(): Promise<void>;
  get(domain: string): Promise<Strategy | null>;
  set(domain: string, strategy: Strategy): Promise<void>;
}
