import { redisClient, runtimeState, serverBlacklist } from "./utils.ts";
import {
  redisRedistributeChannelFactory,
  removeServerFromRedis,
  serversLoadKey,
  serversTimeoutKey,
} from "@chat/shared";

const wssServerTimeoutMs: number = Number(
  process.env.SERVER_TIMEOUT_MS ?? 1_000,
);

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

export const startIntervals = () =>
  setInterval(async () => {
    await redistributeLoad();
    await healthChecks();
  }, 1000);
