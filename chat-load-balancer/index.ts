import express from "express";
import { createClient } from "redis";
import { redisChatServersKey, type Server } from "@chat/shared";

const app = express();
const port = 3000;

app.use(express.json());

const client = createClient();
await client.connect();

const getServers = async (): Promise<Array<Server>> =>
  JSON.parse((await client.get(redisChatServersKey)) ?? "[]") || [];

console.log(`${(await getServers()).length} active servers`);

const serverLiveConnectionsKey = (server: Server) => `${server.id}-connections`;

const getLiveConnections = async (server: Server): Promise<number> => {
  return Number((await client.get(serverLiveConnectionsKey(server))) ?? 0);
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
    console.log(`server ${s.id} has ${liveConnections}`);
    if (liveConnections < (await getLiveConnections(server))) {
      server = s;
    }
  }

  res.send(JSON.stringify(server));
});

app.listen(port, () => {
  console.log(`listening on port ${port}`);
});

const shutdown = async () => {
  try {
    await client.quit();
  } catch {
    client.destroy();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
