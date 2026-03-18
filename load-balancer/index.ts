import express from "express";
import { terminalUi } from "./terminal-ui.ts";
import { provisionServer } from "./src/controllers/servers.provision.ts";
import { shutdown } from "./src/utils.ts";
import { createServer } from "./src/controllers/servers.create.ts";
import { startIntervals } from "./src/intervals.ts";

const app = express();
const port = 3000;
terminalUi.setRuntimeInfo({ port, serviceName: "load-balancer" });

app.use(express.json());

app.get("/servers/provision", provisionServer);
app.post("/servers/create", createServer);

app.listen(port, () => {
  console.log(`listening on port ${port}`);
});

startIntervals();

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGUSR2", shutdown);
process.on("SIGHUP", shutdown);
