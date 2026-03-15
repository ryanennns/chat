import express from "express";
import { createClient } from "redis";
import {
  serversLoadKey,
  redisRedistributeChannelFactory,
  serversTimeoutKey,
  removeServerFromRedis,
  redisServerKeyFactory,
} from "@chat/shared";

const app = express();
const port = 3000;

app.use(express.json());

const redisClient = createClient();
await redisClient.connect();

app.get("/servers/provision", async (req, res) => {
  let id: string | null = (await redisClient.zRange(serversLoadKey, 0, 0))[0];

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
});

const shouldRedistribute = (
  distribution: number,
  totalClients: number,
  totalServers: number,
) => {
  const optimalDistribution = totalClients / totalServers;

  // console.log({
  //   distribution,
  //   optimal: Number(optimalDistribution.toFixed(4)),
  //   ratio: Number((distribution / optimalDistribution).toFixed(4)),
  // });
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
  const numberOfClients = serverConnectionsMap.reduce(
    (a, b) => Number(a) + Number(b.score),
    0,
  );
  serverConnectionsMap.sort((a, b) => b.score - a.score);
  console.log("number of servers: ", serverConnectionsMap);
  console.log("number of clients: ", numberOfClients);
  const optimal = numberOfClients / serverConnectionsMap.length;
  console.log("optimal distribution: ", optimal);

  for (const map of serverConnectionsMap) {
    if (
      shouldRedistribute(
        map.score,
        numberOfClients,
        serverConnectionsMap.length,
      )
    ) {
      await redisClient.publish(
        redisRedistributeChannelFactory(map.value),
        JSON.stringify(map.score - Math.floor(optimal)),
      );
    }
  }
}

const healthChecks = async () => {
  const cutoff = Date.now() - 3_000;
  const deadServerIds = await redisClient.zRangeByScore(
    serversTimeoutKey,
    0,
    cutoff,
  );

  deadServerIds.forEach(
    async (serverId) => await removeServerFromRedis(serverId),
  );

  // console.log("dead servers", deadServerIds);
};

setInterval(async () => {
  await redistributeLoad();
  await healthChecks();
}, 1000);

app.listen(port, () => {
  console.log(`listening on port ${port}`);
});

const shutdown = async () => {
  try {
    await redisClient.quit();
  } catch {
    redisClient.destroy();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
