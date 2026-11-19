import { createApp } from "./app.js";

const app = await createApp();
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("unhandledRejection", (error) => {
  console.error("[mesa] promessa rejeitada", error);
});
