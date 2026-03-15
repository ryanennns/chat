import express from "express";
import { createClient } from "redis";
import {
  debugLog,
  redisChatServersKey,
  redistributeChannelKeyGenerator,
  type Server,
  type WebSocketMessage,
} from "@chat/shared";

const app = express();
const port = 3000;

app.use(express.json());

const redisClient = createClient();
await redisClient.connect();

const getServers = async (): Promise<Array<Server>> =>
  JSON.parse((await redisClient.get(redisChatServersKey)) ?? "[]") || [];

console.log(`${(await getServers()).length} active servers`);

const serverLiveConnectionsKey = (server: Server) => `${server.id}-connections`;

const getLiveConnections = async (server: Server): Promise<number> => {
  return Number((await redisClient.get(serverLiveConnectionsKey(server))) ?? 0);
};

app.get("/servers", async (req, res) => {
  const servers = await getServers();

  res.send(JSON.stringify(servers));
});

app.get("/servers/provision", async (req, res) => {
  const servers = await getServers();

  if (servers.length === 0) {
    res.send(JSON.stringify({ error: "no servers" }));
  }

  let server = servers[0];
  for (const s of servers) {
    const liveConnections = await getLiveConnections(s);
    if (liveConnections < (await getLiveConnections(server))) {
      server = s;
    }
  }

  res.send(JSON.stringify(server));
});

const shouldRedistribute = (
  distribution: number,
  totalClients: number,
  totalServers: number,
) => {
  const optimalDistribution = totalClients / totalServers;

  console.log({
    distribution,
    optimalDistribution,
    ratio: (distribution / optimalDistribution),
  });
  return distribution > optimalDistribution &&
      distribution / optimalDistribution > 0.95;
};

setInterval(async () => {
  const servers = await getServers();
  let activeClients = 0;
  let activeServers = servers.length;
  const serverIdToActiveConnectionsMap: Record<string, number> = {};
  for (const server of servers) {
    serverIdToActiveConnectionsMap[server.id] = Number(
      (await redisClient.get(`${server.id}-connections`)) ?? 0,
    );
    activeClients += serverIdToActiveConnectionsMap[server.id];
  }

  const optimalDistribution = activeClients / activeServers;

  for (const server of servers) {
    if (
      shouldRedistribute(
        serverIdToActiveConnectionsMap[server.id],
        activeClients,
        activeServers,
      )
    ) {
      debugLog(`${server.id} needs client redistribution`);
      await redisClient.publish(
        redistributeChannelKeyGenerator(server.id),
        JSON.stringify(
          serverIdToActiveConnectionsMap[server.id] -
            Math.floor(optimalDistribution),
        ),
      );
    }
  }

  debugLog(serverIdToActiveConnectionsMap);
  debugLog(`optimal distribution: ${activeClients / activeServers}`);
}, 5000);

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
