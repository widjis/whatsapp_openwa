import dotenv from 'dotenv';
import { startHelpdeskDispatcher } from './features/dispatcher/helpdeskDispatcher.js';

dotenv.config();

const running = startHelpdeskDispatcher();

function shutdown() {
  running.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

