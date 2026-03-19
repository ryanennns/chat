import {
  childServerMap,
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

const SOCKETS_PER_CHAT_ROOM_NEW_SERVER_THRESHOLD = 350;
const PPS_SURGE_THRESHOLD = 40;

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
    distribution / optimalDistribution > redistributeThreshold &&
    !isSurge()
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
  const now = Date.now();
  const cutoff = now - wssServerTimeoutMs;
  const timedOutServers = await redisClient.zRangeByScore(
    serversTimeoutKey,
    0,
    cutoff,
  );
  runtimeState.timedOutServers = timedOutServers;

  timedOutServers.forEach((serverId) => {
    if (!serverBlacklist.has(serverId)) {
      serverBlacklist.set(serverId, now);
    }
  });

  serverBlacklist.forEach((timeout, server) => {
    if (now - timeout > wssBlacklistRemovalTimeoutMs) {
      void removeServerFromRedis(server);
      serverBlacklist.delete(server);
      runtimeState.lastRemovedServer = server;
    }
  });
};

export const spawnServer = async () => {
  const output = await websocketServerFactory(v4());

  if (output) {
    childServerMap.set(output.server.id, output.child);
  }
};

const spawnServerIfRequired = async () => {
  const keys = await redisClient.zRangeByScore(
    serversRatioKey,
    SOCKETS_PER_CHAT_ROOM_NEW_SERVER_THRESHOLD,
    "+inf",
  );

  if (keys.length) {
    debugLog("spawning new process");
    await spawnServer();
  }
};

export async function cleanupDeadServers() {
  const ratioKeys = await redisClient.zRangeByScore(
    serversRatioKey,
    "-inf",
    "+inf",
  );
  const timeoutKeys = await redisClient.zRangeByScore(
    serversTimeoutKey,
    "-inf",
    "+inf",
  );

  ratioKeys.forEach((key) => {
    if (timeoutKeys.includes(key)) {
      return;
    }

    removeServerFromRedis(key);
    childServerMap.get(key)?.kill(0);
    childServerMap.delete(key);
  });

  childServerMap.forEach((process, key) => {
    if (process.killed) {
      void removeServerFromRedis(key);
      childServerMap.delete(key);
    }
  });
}

export let pps = 0;
export const isSurge = () => pps > PPS_SURGE_THRESHOLD;
export let provisionsThisSecond = 0;
export const incrProvisionsThisSecond = () => provisionsThisSecond++;
const updatePps = () => {
  pps = provisionsThisSecond;
  runtimeState.pps = pps;
  provisionsThisSecond = 0;
};

export const startIntervals = () => {
  setInterval(async () => {
    await healthChecks();
  }, 500);
  setInterval(async () => {
    await redistributeLoad();
  }, 1500);
  setInterval(async () => {
    await spawnServerIfRequired();
  }, 15_000);
  setInterval(async () => {
    await cleanupDeadServers();
  }, 1000);
  setInterval(() => {
    updatePps();
  }, 1000);
};
