import { createServer } from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { initSocket } from './lib/socket';
import { startScheduler } from './jobs/scheduler';

const app = createApp();
const httpServer = createServer(app);

initSocket(httpServer);
startScheduler();

httpServer.listen(env.port, () => {
  console.log(`[server] listening on http://localhost:${env.port} (${env.nodeEnv})`);
});
