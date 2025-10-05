import { Queue, Job } from 'bullmq';
import { IQueueService, IJob } from '../contracts/queue.service.js';
import { getConfig, EnvConfig } from '../../config/env.js';
import { ConnectionOptions } from 'tls';

const HLS_RESOLVER_QUEUE = 'hls-resolver';

export class QueueService implements IQueueService {
  private static instance: QueueService;
  private queue: Queue;

  private constructor(config: EnvConfig) {
    const redisUrl = new URL(config.REDIS_URL);
    const connection: ConnectionOptions = {
      host: redisUrl.hostname,
      port: parseInt(redisUrl.port, 10),
      // Añade aquí más opciones si tu Redis requiere autenticación o SSL
    };

    this.queue = new Queue(HLS_RESOLVER_QUEUE, { connection });
  }

  public static getInstance(): QueueService {
    if (!QueueService.instance) {
      const config = getConfig();
      QueueService.instance = new QueueService(config);
    }
    return QueueService.instance;
  }

  public async addJob<T>(job: IJob<T>): Promise<Job<T>> {
    return this.queue.add(job.name, job.data, job.opts);
  }

  public async getJob<T>(jobId: string): Promise<Job<T> | null> {
    const job = await this.queue.getJob(jobId);
    return job || null;
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }

  public getQueue(): Queue {
    return this.queue;
  }
}
