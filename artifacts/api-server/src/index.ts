import app from "./app";
import { logger } from "./lib/logger";

// Without this, a single transient network hiccup (a remote socket closing
// mid-request — undici's UND_ERR_SOCKET / "other side closed", seen from
// Baileys' own media/HTTP calls) surfaces as an unhandled 'error' event and
// kills the ENTIRE process — dropping every connected user's live WhatsApp
// session at once, not just the one request that failed. That's the root
// cause behind repeated PM2 restarts and the "messages coming in/out slow"
// symptom reported live: every crash + reconnect cycle stalls delivery for
// everyone until Baileys re-establishes its socket. These errors are
// per-request and recoverable — logging and continuing is correct here,
// unlike Node's usual "an uncaught exception means undefined state, exit"
// guidance, which assumes the failure is in this process's own logic rather
// than a remote peer closing a connection.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection (process kept alive)");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception (process kept alive)");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
