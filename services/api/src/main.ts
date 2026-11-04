/**
 * Tandem API — process entry point.
 *
 *   TANDEM_DEV=1 node src/main.ts
 */

import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";

function main(): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const app = createApp(db, config);
  const server = createServer({ requestTimeout: 30_000 }, (req, res) => {
    void app.handle(req, res);
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `tandem api listening on http://${config.host}:${config.port} ` +
        `(policy ${config.policyVersion}, matcher ${config.matcherUrl})`,
    );
    if (config.dev) console.log("dev mode: OTP codes are returned in responses");
  });

  const shutdown = (signal: string) => {
    console.log(`received ${signal}, closing`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
