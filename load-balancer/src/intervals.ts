import { terminalUi } from "../terminal-ui.ts";
import {
  childServerMap,
  redisClient,
  runtimeState,
  serverBlacklist,
} from "./utils.ts";
import {
  NumericList,
  removeServerFromRedis,
  serversChatRoomsCountKey,
  serversClientCountKey,
  serversEventLoopTimeoutKey,
  serversHeartbeatKey,
  serversSocketWritesPerSecondKey,
  type ServerState,
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
