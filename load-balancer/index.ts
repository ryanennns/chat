import { app } from "./src/app.ts";
import { terminalUi } from "./terminal-ui.ts";
import { shutdown } from "./src/utils.ts";
import { startIntervals } from "./src/intervals.ts";

const port = 3000;
terminalUi.setRuntimeInfo({ port, serviceName: "load-balancer" });

app.listen(port, () => {
  console.log(`listening on port ${port}`);
});

startIntervals();

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGUSR2", shutdown);
process.on("SIGHUP", shutdown);
