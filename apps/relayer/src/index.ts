import { buildServer } from "./server.js";
import { getPort, loadEnv } from "./config.js";

loadEnv();
const app = await buildServer({ logger: true });
const port = getPort();

try {
  await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
