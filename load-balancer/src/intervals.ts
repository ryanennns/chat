import {
  redisClient,
  runtimeState,
  serverBlacklist,
  websocketServerFactory,
} from "./utils.ts";
import {
  debugLog,
  redisRedistributeChannelFactory,
  removeServerFromRedis,
  serversClientCountKey,
  serversTimeoutKey,
  serversRatioKey,
} from "@chat/shared";
import { v4 } from "uuid";

const wssServerTimeoutMs: number = Number(
  process.env.SERVER_TIMEOUT_MS ?? 1_000,
);
const redistributeThreshold = Number(
  process.env.REDISTRIBUTE_THRESHOLD ?? 0.95,
);
const wssBlacklistRemovalTimeoutMs = Number(
  process.env.BLACKLIST_REMOVAL_TIMEOUT_MS ?? 10_000,
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
    distribution / optimalDistribution > redistributeThreshold
  );
};

export async function redistributeLoad() {
  const serverConnectionsMap = (
    await redisClient.zRangeWithScores(serversClientCountKey, 0, -1)
  ).filter((serverConnection) => !serverBlacklist.has(serverConnection.value));
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
  runtimeState.totalClients = Number(numberOfClients.toFixed(2));
  runtimeState.totalServers = serverConnectionsMap.length;
  const optimal = numberOfClients / serverConnectionsMap.length;
  runtimeState.optimalDistribution = Number.isFinite(optimal) ? optimal : 0;

  for (const serverScoreMap of serverConnectionsMap) {
    if (
      shouldRedistribute(
        serverScoreMap.score,
        numberOfClients,
        serverConnectionsMap.length,
      )
    ) {
      const redistributeBy = serverScoreMap.score - Math.floor(optimal);
      debugLog(
        `${serverScoreMap.score}, ${numberOfClients}, ${serverConnectionsMap.length}, ${redistributeBy}`,
      );
      runtimeState.lastRedistribution = {
        amount: redistributeBy,
        serverId: serverScoreMap.value,
        timestamp: new Date().toLocaleTimeString("en-US", {
          hour12: false,
        }),
      };
      await redisClient.publish(
        redisRedistributeChannelFactory(serverScoreMap.value),
        JSON.stringify(redistributeBy),
      );
    }
  }
}

export const healthChecks = async () => {
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
    if (Date.now() - timeout > wssBlacklistRemovalTimeoutMs) {
      void removeServerFromRedis(server);
      serverBlacklist.delete(server);
      runtimeState.lastRemovedServer = server;
    }
  });
};

export const startIntervals = () => {
  setInterval(async () => {
    await healthChecks();
  }, 100);
  setInterval(async () => {
    await redistributeLoad();
  }, 1500);
  setInterval(async () => {
    const keys = await redisClient.zRangeByScore(serversRatioKey, 400, "+inf");

    if (keys.length) {
      console.log("spawning new process");
      void websocketServerFactory(v4());
    }
  }, 15_000);
  setInterval(async () => {
    const ratioKeys = await redisClient.zRangeByScore(serversRatioKey, "-inf", "+inf");
    const timeoutKeys = await redisClient.zRangeByScore(serversTimeoutKey, "-inf", "+inf");

    ratioKeys.forEach(key => {
      if (timeoutKeys.includes(key)) {
        return;
      }

      removeServerFromRedis(key);
    })

  }, 1000);
};
