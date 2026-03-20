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
  serversChatRoomsCountKey,
  serversClientCountKey,
  serversHeartbeatKey,
  serversSocketWritesPerSecondKey,
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
  const [serverConnections, serverWritesPerSecond] = await Promise.all([
    redisClient.zRangeWithScores(serversClientCountKey, 0, -1),
    redisClient.zRangeWithScores(serversSocketWritesPerSecondKey, 0, -1),
  ]);
  const serverConnectionsMap = serverConnections.filter(
    (serverConnection) => !serverBlacklist.has(serverConnection.value),
  );
  runtimeState.serverMps = serverWritesPerSecond.map(({ value, score }) => [
    value,
    score,
  ]);
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

interface ServerState {
  clients: Array<number>;
  chatRooms: Array<number>;
  socketWritesPerSecond: Array<number>;
}

const serverStates: Record<string, ServerState> = {};

const detectTimedOutServers = async () => {
  const now = Date.now();
  const cutoff = now - wssServerTimeoutMs;
  const timedOutServers = await redisClient.zRangeByScore(
    serversHeartbeatKey,
    0,
    cutoff,
  );
  runtimeState.timedOutServers = timedOutServers;

  timedOutServers.forEach((serverId) => {
    if (!serverBlacklist.has(serverId)) {
      serverBlacklist.set(serverId, now);
    }
  });
};

const purgeBlacklistedServers = () => {
  serverBlacklist.forEach((timeout, server) => {
    if (Date.now() - timeout > wssBlacklistRemovalTimeoutMs) {
      void removeServerFromRedis(server);
      serverBlacklist.delete(server);
      childServerMap.get(server)?.kill(0);
      childServerMap.delete(server);
      runtimeState.lastRemovedServer = server;
    }
  });
};

const defaultServerState = {
  clients: Array.from({ length: 10 }).map(() => 0),
  chatRooms: Array.from({ length: 10 }).map(() => 0),
  socketWritesPerSecond: Array.from({ length: 10 }).map(() => 0),
};
export const healthChecks = async () => {
  // socket writes
  const socketWrites = await redisClient.zRangeWithScores(
    serversSocketWritesPerSecondKey,
    0,
    -1,
  );
  socketWrites.forEach(({ value: id, score: writesPerSecond }) => {
    serverStates[id] =
      serverStates[id] === undefined
        ? { ...defaultServerState }
        : serverStates[id];
    serverStates[id].socketWritesPerSecond.shift();
    serverStates[id].socketWritesPerSecond.push(writesPerSecond);
  });
  // clients
  const clients = await redisClient.zRangeWithScores(
    serversClientCountKey,
    0,
    -1,
  );
  clients.forEach(({ value: id, score: clients }) => {
    serverStates[id] =
      serverStates[id] === undefined
        ? { ...defaultServerState }
        : serverStates[id];
    serverStates[id].clients.shift();
    serverStates[id].clients.push(clients);
  });
  // chat rooms
  const chatRooms = await redisClient.zRangeWithScores(
    serversChatRoomsCountKey,
    0,
    -1,
  );
  chatRooms.forEach(({ value: id, score: chatRooms }) => {
    serverStates[id] =
      serverStates[id] === undefined
        ? { ...defaultServerState }
        : serverStates[id];
    serverStates[id].chatRooms.shift();
    serverStates[id].chatRooms.push(chatRooms);
  });

  await detectTimedOutServers();
  purgeBlacklistedServers();
};

export const spawnServer = async () => {
  const output = await websocketServerFactory(v4());

  if (output) {
    childServerMap.set(output.server.id, output.child);
  }
};

const spawnServerIfRequired = async () => {
  const THRESHOLD = 75_000;
  const result = Object.entries(serverStates)
    .filter(([_, state]) => {
      const arr = state.socketWritesPerSecond;
      if (!arr.length) return false;

      const avg = arr.reduce((sum, v) => sum + v, 0) / arr.length;

      return avg > THRESHOLD;
    })
    .map(([serverId, state]) => ({ serverId, state }));

  if (result.length) {
    debugLog("spawning new process");
    await spawnServer();
  }
};

export async function cleanupDeadServers() {
  const loadKeys = await redisClient.zRangeByScore(
    serversSocketWritesPerSecondKey,
    "-inf",
    "+inf",
  );
  const timeoutKeys = await redisClient.zRangeByScore(
    serversHeartbeatKey,
    "-inf",
    "+inf",
  );

  loadKeys.forEach((key) => {
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
  }, 1000);
  setInterval(async () => {
    await spawnServerIfRequired();
  }, 1000);
  setInterval(async () => {
    await cleanupDeadServers();
  }, 1000);
  setInterval(() => {
    updatePps();
  }, 1000);
  setInterval(async () => {
    await redistributeLoad();
  }, 1000);
};
