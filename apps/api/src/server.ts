import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerCheckinRoutes } from "./routes/checkin.js";

export function buildServer() {
  const app = Fastify({
    logger: {
      level: "info"
    },
    bodyLimit: 50 * 1024 * 1024 // allow larger payloads for base64 audio
  });

  // We keep the same permissive CORS as before.
  void app.register(cors, { origin: true });

  app.get("/health", async () => {
    return { ok: true, service: "earlyrise-api", ts: new Date().toISOString() };
  });

  registerAdminRoutes(app);
  registerCheckinRoutes(app);

  return app;
}


