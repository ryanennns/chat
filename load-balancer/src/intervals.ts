import { terminalUi } from "../terminal-ui.ts";
import {
  childServerMap,
  redisClient,
  runtimeState,
  serverBlacklist,
} from "./utils.ts";
import {
  chatRoomTotalMessagesKey,
  type HistoryKey,
  NumericList,
  redisServerKeyFactory,
  removeServerFromRedis,
  serversClientCountKey,
  serversEventLoopTimeoutKey,
  serversHeartbeatKey,
  serversSocketWritesPerSecondKey,
} from "@chat/shared";

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

const updateServerStateHistoryArray = (
  id: string,
  key: HistoryKey,
  value: number,
) => {
  if (!childServerMap.has(id)) {
    return;
  }

  childServerMap.get(id)?.state[key]?.shift();
  childServerMap.get(id)?.state[key]?.push(value);
};

const setServerChatRoomState = (id: string, value: Record<string, number>) => {
  if (childServerMap.has(id)) {
    childServerMap.get(id)!.state["chatRooms"] = value;
  }
};

export const healthChecks = async () => {
  // socket writes
  const socketWrites = await redisClient.zRangeWithScores(
    serversSocketWritesPerSecondKey,
    0,
    -1,
  );
  socketWrites.forEach(({ value: id, score: writesPerSecond }) =>
    updateServerStateHistoryArray(id, "socketWrites", writesPerSecond),
  );
  // clients
  const clients = await redisClient.zRangeWithScores(
    serversClientCountKey,
    0,
    -1,
  );
  clients.forEach(({ value: id, score: clients }) =>
    updateServerStateHistoryArray(id, "clients", clients),
  );
  const timeoutValues = await redisClient.zRangeWithScores(
    serversEventLoopTimeoutKey,
    0,
    -1,
  );
  timeoutValues.forEach(({ value: id, score: timeout }) =>
    updateServerStateHistoryArray(id, "timeouts", timeout),
  );
  const chatRoomMessages = await redisClient.zRangeWithScores(
    chatRoomTotalMessagesKey,
    0,
    -1,
  );
  chatRoomMessages.forEach(({ value: id, score: totalMessages }) =>
    updateServerStateHistoryArray(id, "messages", totalMessages),
  );

  for (const c of [...childServerMap.values()]) {
    const redisData = await redisClient.hGetAll(redisServerKeyFactory(c.server.id));
    const chatKeys = Object.keys(redisData).filter((k) => k.includes("chat:"));
    const keyValuePairs: Record<string, number> = {};

    for (let chatKey of chatKeys) {
      keyValuePairs[chatKey.split("chat:")[1]] = Number(redisData[chatKey]);
    }

    setServerChatRoomState(c.server.id, keyValuePairs);
  }

  await detectTimedOutServers();
  purgeBlacklistedServers();

  updatePps();
};

export const ppsHistory: NumericList = new NumericList(
  ...Array.from({ length: 100 }).map(() => 0),
);
export let pps = 0;
export let provisionsThisSecond = 0;
export const incrProvisionsThisSecond = () => provisionsThisSecond++;
const updatePps = () => {
  pps = provisionsThisSecond;
  runtimeState.pps = pps;
  ppsHistory.shift();
  ppsHistory.push(pps);
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
    syncTerminalUi();
  }, 1000);
};
