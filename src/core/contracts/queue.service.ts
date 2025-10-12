import { Job } from 'bullmq';
import { Queue } from 'bullmq';

export interface IJob<T = any> {
  id?: string;
  name: string;
  data: T;
  opts?: any;
}

export interface IQueueService {
  /**
   * Añade un nuevo trabajo a la cola.
   * @param job El trabajo a añadir.
   */
  addJob<T>(job: IJob<T>): Promise<Job<T>>;

  /**
   * Busca un trabajo por su ID.
   * @param jobId El ID del trabajo a buscar.
   */
  getJob<T>(jobId: string): Promise<Job<T> | null>;

  /**
   * Cierra la conexión de la cola de forma segura.
   */
  close(): Promise<void>;

  getQueue(): Queue;
}
