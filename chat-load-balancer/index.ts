import express from "express";
import { createClient } from "redis";
import {
  debugLog,
  redisChatServersKey,
  redistributeChannelKeyGenerator,
  type Server,
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
}

const serverHealthDictionary: Record<string, number> = {};
(await getServers()).forEach(
  (server) => (serverHealthDictionary[server.id] = new Date().getTime()),
);
let pingClient = createClient();
await pingClient.connect();
await pingClient.subscribe("pong", (message) => {
  serverHealthDictionary[message] = new Date().getTime();
});
const healthChecks = async () => {
  await redisClient.publish("ping", "");

  const removeTheseServers: Array<string> = [];
  for (const key in serverHealthDictionary) {
    if (new Date().getTime() - serverHealthDictionary[key] > 1_500) {
      removeTheseServers.push(key);
      delete serverHealthDictionary[key];
    }
  }
  console.log(`removing ${removeTheseServers.length} dead servers`);
  const newServers = (await getServers()).filter(
    (server) => !removeTheseServers.includes(server.id),
  );
  await redisClient.set(redisChatServersKey, JSON.stringify(newServers));
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
    await pingClient.quit();
  } catch {
    redisClient.destroy();
    pingClient.destroy();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
