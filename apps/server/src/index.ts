import { LISTEN_HOST, buildServer } from './app.ts';

async function main(): Promise<void> {
  const { app, config } = await buildServer();

  // buildServer already registered every route (accounts, auth, transfers, events) and owns the
  // transfer engine; `app.close()` ends the event streams, stops the engine and closes the database.

  const shutdown = (): void => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: LISTEN_HOST, port: config.port });
  app.log.info(`MultiCloud server ready on http://${LISTEN_HOST}:${config.port} (web UI: ${config.webOrigin})`);
}

main().catch((err: unknown) => {
  // Message only: never dump error objects, they may reference configuration values.
  console.error(`MultiCloud server failed to start: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
});
