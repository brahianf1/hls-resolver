
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import { getConfig } from '../../config/env.js';
import { QueueService } from '../../core/queue/queue.service.js';
import basicAuth from 'express-basic-auth';

export function setupBullBoard() {
  // Get config for credentials
  const config = getConfig();

  // Get the queue instance from our QueueService
  const queueService = QueueService.getInstance();
  const hlsResolverQueue: Queue = queueService.getQueue();

  // Create the server adapter
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  // Add basic authentication
  const bullBoardRouter = serverAdapter.getRouter();

  if (config.BULL_BOARD_USER && config.BULL_BOARD_PASSWORD) {
    bullBoardRouter.use(basicAuth({
      users: { [config.BULL_BOARD_USER]: config.BULL_BOARD_PASSWORD },
      challenge: true,
      realm: 'StreamSuite-BullBoard',
    }));
  }

  // Create the Bull Board
  createBullBoard({
    queues: [new BullMQAdapter(hlsResolverQueue)],
    serverAdapter: serverAdapter,
  });

  // Return the router
  return bullBoardRouter;
}
