import { createDemoServer } from './demoServer.ts';
import { MexcFocusWorker } from './workers/mexcFocus.ts';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port.');

const mexcFocus = new MexcFocusWorker({
  supabaseUrl: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});
const server = createDemoServer({ mexcFocus });
setInterval(() => void mexcFocus.run().catch(() => undefined), 5 * 60_000).unref();
void mexcFocus.run(true).catch(() => undefined);
server.listen(port, '0.0.0.0', () => {
  console.log(`${new Date().toISOString()} Firstprint read-only demo API listening on port ${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
