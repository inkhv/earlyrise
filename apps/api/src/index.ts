import { env } from "./config.js";
import { buildServer } from "./server.js";

const app = buildServer();
const port = Number(env.PORT || 3001);
await app.listen({ port, host: "0.0.0.0" });


