import { runServer } from './run.ts';

runServer().catch((err: unknown) => {
  // Message only: never dump error objects, they may reference configuration values.
  console.error(`DriveHop server failed to start: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
});
