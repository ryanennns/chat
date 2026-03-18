import { createClient } from "redis";
import { terminalUi } from "../terminal-ui.ts";

export const redisClient = createClient();
await redisClient.connect();

export const serverBlacklist = new Map<string, number>();

export const runtimeState = {
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

export const shutdown = async () => {
  try {
    terminalUi.destroy();
    await redisClient.quit();
  } catch {
    redisClient.destroy();
  } finally {
    process.exit(0);
  }
};

setInterval(() => {
  terminalUi.setSnapshot({
    blacklistedServers: [...serverBlacklist.entries()].map(
      ([serverId, startedAt]) => [
        serverId,
        Math.floor((Date.now() - startedAt) / 1000),
      ],
    ),
    status: "running",
    ...runtimeState,
  });
}, 1000);
