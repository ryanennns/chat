import { terminalUi } from "../terminal-ui.ts";
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
  serversEventLoopTimeoutKey,
  serversHeartbeatKey,
  serversSocketWritesPerSecondKey,
  type ServerState,
} from "@chat/shared";
import { v4 } from "uuid";

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
const SOCKET_WRITES_PER_SECOND_CRITICAL_MASS = Number(
  process.env.SOCKET_WRITES_PER_SECOND_THRESHOLD ?? 150_000,
);
const AVERAGE_INTERVAL_TIMEOUT_CRITICAL_THRESHOLD = Number(
  process.env.AVERAGE_INTERVAL_TIMEOUT_CRITICAL_THRESHOLD ?? 10,
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
      childServerMap.get(server)?.process?.kill(0);
      childServerMap.delete(server);
      runtimeState.lastRemovedServer = server;
    }
  });
};

const updateServerState = (
  id: string,
  key: keyof ServerState,
  value: number,
) => {
  if (!childServerMap.has(id)) {
    return;
  }

  childServerMap.get(id)?.state[key]?.shift();
  childServerMap.get(id)?.state[key]?.push(value);
};

export const healthChecks = async () => {
  // socket writes
  const socketWrites = await redisClient.zRangeWithScores(
    serversSocketWritesPerSecondKey,
    0,
    -1,
  );
  socketWrites.forEach(({ value: id, score: writesPerSecond }) =>
    updateServerState(id, "socketWrites", writesPerSecond),
  );
  // clients
  const clients = await redisClient.zRangeWithScores(
    serversClientCountKey,
    0,
    -1,
  );
  clients.forEach(({ value: id, score: clients }) =>
    updateServerState(id, "clients", clients),
  );
  // chat rooms
  const chatRooms = await redisClient.zRangeWithScores(
    serversChatRoomsCountKey,
    0,
    -1,
  );
  chatRooms.forEach(({ value: id, score: chatRooms }) =>
    updateServerState(id, "chatRooms", chatRooms),
  );
  const timeoutValues = await redisClient.zRangeWithScores(
    serversEventLoopTimeoutKey,
    0,
    -1,
  );
  timeoutValues.forEach(({ value: id, score: timeout }) =>
    updateServerState(id, "timeouts", timeout),
  );

  await detectTimedOutServers();
  purgeBlacklistedServers();
};

export const spawnServer = async () => {
  const output = await websocketServerFactory(v4());

  if (output) {
    childServerMap.set(output.server.id, output);
  }
};

let lastSpawnedServer = 0;
export const shouldSpawnNewServer = () => {
  const lastFiveSecondsOfSocketWrites: Array<Array<number>> = [
    ...childServerMap.values(),
  ].map((process) => {
    const arr = process.state.socketWrites;
    const sampleSize = 5;
    if (!arr.length) {
      return Array.from({ length: sampleSize }).map(() => 0);
    }

    return arr.slice(arr.length - sampleSize, arr.length);
  });
  const serversAboveSocketWriteThreshold = lastFiveSecondsOfSocketWrites.filter(
    (n) =>
      n.reduce((a, b) => a + b) / n.length >
      SOCKET_WRITES_PER_SECOND_CRITICAL_MASS,
  );

  const maxCapacity = 100_000 * childServerMap.size;
  const lastFiveSecondsOfTotalLoad = [];
  const len = lastFiveSecondsOfSocketWrites[0]?.length ?? 1;
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let j = 0; j < lastFiveSecondsOfSocketWrites.length; j++) {
      sum += lastFiveSecondsOfSocketWrites[j][i];
    }
    lastFiveSecondsOfTotalLoad.push(sum);
  }

  const serverStartedRecently = Date.now() - lastSpawnedServer < 10_000;
  const serverAboveCriticalMass = Boolean(
    serversAboveSocketWriteThreshold.length,
  );
  const cumulativeSocketLoadAboveSafeAverage = Boolean(
    lastFiveSecondsOfTotalLoad.reduce((a, b) => a + b) /
      lastFiveSecondsOfTotalLoad.length >
    maxCapacity,
  );
  const areServersTimingOut = Boolean(
    [...childServerMap.values()].filter((server) => {
      const len = server.state.timeouts.length;
      const lastFive = server.state.timeouts.slice(len - 5, len);
      return (
        lastFive.reduce((a, b) => a + b) / lastFive.length >
        AVERAGE_INTERVAL_TIMEOUT_CRITICAL_THRESHOLD
      );
    }).length,
  );

  const val =
    !serverStartedRecently &&
    (serverAboveCriticalMass ||
      cumulativeSocketLoadAboveSafeAverage ||
      areServersTimingOut);

  if (val) {
    debugLog({
      serverStartedRecently,
      serverAboveCriticalMass,
      averageSocketLoadAboveSafeAverage: `${cumulativeSocketLoadAboveSafeAverage} - ${lastFiveSecondsOfTotalLoad.reduce((a, b) => a + b) / lastFiveSecondsOfTotalLoad.length} > ${maxCapacity}`,
      areServersTimingOut,
    });
  }
  return val;
};

const spawnServerIfRequired = async () => {
  if (shouldSpawnNewServer()) {
    debugLog("spawning new process");
    await spawnServer();
    lastSpawnedServer = Date.now();
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
    childServerMap.get(key)?.process?.kill(0);
    childServerMap.delete(key);
  });

  childServerMap.forEach((server, key) => {
    if (server.process.killed) {
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

const syncTerminalUi = () => {
  const clientsByServerId = new Map(runtimeState.serverLoads);
  const mpsByServerId = new Map(runtimeState.serverMps);

  terminalUi.setSnapshot({
    blacklistedServers: [...serverBlacklist.entries()].map(
      ([serverId, startedAt]) => [
        serverId,
        Math.floor((Date.now() - startedAt) / 1000),
      ],
    ),
    childServers: [...childServerMap.entries()].map(([serverId, child]) => ({
      clients: clientsByServerId.get(serverId) ?? 0,
      isKilled: child.process.killed,
      mps: mpsByServerId.get(serverId) ?? 0,
      pid: child.process.pid,
      serverId,
      state: child.state,
    })),
    status: "running",
    ...runtimeState,
  });
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
  setInterval(() => {
    syncTerminalUi();
  }, 1000);
};
