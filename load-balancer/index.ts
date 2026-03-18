import express from "express";
import { createClient } from "redis";
import {
  serversLoadKey,
  redisRedistributeChannelFactory,
  serversTimeoutKey,
  removeServerFromRedis,
  redisServerKeyFactory,
} from "@chat/shared";
import { terminalUi } from "./terminal-ui.ts";

const app = express();
const port = 3000;
terminalUi.setRuntimeInfo({ port, serviceName: "load-balancer" });

app.use(express.json());

const redisClient = createClient();
await redisClient.connect();

const blacklist = new Map<string, number>();
const runtimeState = {
  lastProvisionedServer: null as string | null,
  lastRedistribution: null as {
    amount: number;
    serverId: string;
    timestamp: string;
  } | null,
  lastRemovedServer: null as string | null,
  optimalDistribution: 0,
  provisionCount: 0,
  serverLoads: [] as Array<[string, number]>,
  timedOutServers: [] as string[],
  totalClients: 0,
  totalServers: 0,
};
app.get("/servers/provision", async (req, res) => {
  let i = 0;
  let id: string | null = null;

  while (i < 5) {
    id = (await redisClient.zRange(serversLoadKey, 0, 0))[0];

    if (!id || blacklist.has(id)) {
      i++;
      continue;
    }

    break;
  }

  if (!id) {
    res.sendStatus(500);
    return;
  }

  let url = await redisClient.hGet(redisServerKeyFactory(id), "url");

  if (!id || !url) {
    res.sendStatus(404);
    return;
  }

  res.send(
    JSON.stringify({
      id,
      url,
    }),
  );

  runtimeState.provisionCount++;
  runtimeState.lastProvisionedServer = id;
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
      blacklist.get(serverId) ?? blacklist.set(serverId, Date.now()),
  );

  blacklist.forEach((timeout, server) => {
    if (Date.now() - timeout > 10_000) {
      void removeServerFromRedis(server);
      blacklist.delete(server);
      runtimeState.lastRemovedServer = server;
    }
  });
};

setInterval(async () => {
  await redistributeLoad();
  await healthChecks();
  terminalUi.setSnapshot({
    blacklistedServers: [...blacklist.entries()].map(
      ([serverId, startedAt]) => [
        serverId,
        Math.floor((Date.now() - startedAt) / 1000),
      ],
    ),
    status: "running",
    ...runtimeState,
  });
}, 1000);

app.listen(port, () => {
  console.log(`listening on port ${port}`);
});

const shutdown = async () => {
  try {
    terminalUi.destroy();
    await redisClient.quit();
  } catch {
    redisClient.destroy();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
