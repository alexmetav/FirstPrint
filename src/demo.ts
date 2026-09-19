import { createDemoServer } from './demoServer.ts';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port.');

const server = createDemoServer();
server.listen(port, '0.0.0.0', () => {
  console.log(`${new Date().toISOString()} Firstprint read-only demo API listening on port ${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
