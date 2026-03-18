import express from "express";
import {
  serversLoadKey,
  redisRedistributeChannelFactory,
  serversTimeoutKey,
  removeServerFromRedis,
} from "@chat/shared";
import { terminalUi } from "./terminal-ui.ts";
import { provisionServer } from "./src/controllers/servers.provision.ts";
import {
  redisClient,
  runtimeState,
  serverBlacklist,
  shutdown,
} from "./src/utils.ts";
import { createServer } from "./src/controllers/servers.create.ts";

const app = express();
const port = 3000;
terminalUi.setRuntimeInfo({ port, serviceName: "load-balancer" });

app.use(express.json());

app.get("/servers/provision", provisionServer);
app.post("/servers/create", createServer);

app.listen(port, () => {
  console.log(`listening on port ${port}`);
});

const shouldRedistribute = (
  distribution: number,
  totalClients: number,
  totalServers: number,
) => {
  const optimalDistribution = totalClients / totalServers;

  return (
    distribution > optimalDistribution &&
    distribution - optimalDistribution > 1 &&
    distribution / optimalDistribution > 0.95
  );
};

async function redistributeLoad() {
  const serverConnectionsMap = await redisClient.zRangeWithScores(
    serversLoadKey,
    0,
    -1,
  );
  runtimeState.lastRedistribution = null;
  const numberOfClients = serverConnectionsMap.reduce(
    (a, b) => Number(a) + Number(b.score),
    0,
  );
  serverConnectionsMap.sort((a, b) => b.score - a.score);
  runtimeState.serverLoads = serverConnectionsMap.map(({ value, score }) => [
    value,
    score,
  ]);
  runtimeState.totalClients = numberOfClients;
  runtimeState.totalServers = serverConnectionsMap.length;
  const optimal = numberOfClients / serverConnectionsMap.length;
  runtimeState.optimalDistribution = Number.isFinite(optimal) ? optimal : 0;

  for (const map of serverConnectionsMap) {
    if (
      shouldRedistribute(
        map.score,
        numberOfClients,
        serverConnectionsMap.length,
      )
    ) {
      const redistributeBy = map.score - Math.floor(optimal);
      runtimeState.lastRedistribution = {
        amount: redistributeBy,
        serverId: map.value,
        timestamp: new Date().toLocaleTimeString("en-US", {
          hour12: false,
        }),
      };
      await redisClient.publish(
        redisRedistributeChannelFactory(map.value),
        JSON.stringify(redistributeBy),
      );
    }
  }
}

const wssServerTimeoutMs = 1_200;
const healthChecks = async () => {
  const cutoff = Date.now() - wssServerTimeoutMs;
  const timedOutServers = await redisClient.zRangeByScore(
    serversTimeoutKey,
    0,
    cutoff,
  );
  runtimeState.timedOutServers = timedOutServers;

  timedOutServers.forEach(
    (serverId) =>
      serverBlacklist.get(serverId) ??
      serverBlacklist.set(serverId, Date.now()),
  );

  serverBlacklist.forEach((timeout, server) => {
    if (Date.now() - timeout > 10_000) {
      void removeServerFromRedis(server);
      serverBlacklist.delete(server);
      runtimeState.lastRemovedServer = server;
    }
  });
};

setInterval(async () => {
  await redistributeLoad();
  await healthChecks();
}, 1000);

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
