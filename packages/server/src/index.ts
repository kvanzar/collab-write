import { createCollabServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
createCollabServer(port);
console.log(`collab server listening on ws://localhost:${port}`);
