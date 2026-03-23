// import { terminalUi } from "../terminal-ui.ts";
import { redisClient, serverBlacklist } from "./utils.ts";
import {
  chatRoomMessagesPerSecondKey,
  chatRoomSocketWritesPerSecondKey,
  chatRoomTotalClientsKey,
  type HistoryKey,
  NumericList,
  removeServerFromRedis,
  serversClientCountKey,
  serversEventLoopTimeoutKey,
  serversHeartbeatKey,
  serversSocketWritesPerSecondKey,
} from "@chat/shared";
import {
  chatRooms,
  type ChatRoomState,
  socketServers,
  terminalUiRuntimeState,
} from "./state.ts";

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
  terminalUiRuntimeState.timedOutServers = timedOutServers;

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
      socketServers.get(server)?.process?.kill(0);
      socketServers.delete(server);
      terminalUiRuntimeState.lastRemovedServer = server;
    }
  });
};

const updateServerStateHistoryArray = (
  id: string,
  key: HistoryKey,
  value: number,
) => {
  if (!socketServers.has(id)) {
    return;
  }

  socketServers.get(id)?.state[key]?.shift();
  socketServers.get(id)?.state[key]?.push(value);
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
  terminalUiRuntimeState.pps = pps;
  ppsHistory.shift();
  ppsHistory.push(pps);
  provisionsThisSecond = 0;
};

const syncTerminalUi = () => {
  const clientsByServerId = new Map(terminalUiRuntimeState.serverLoads);
  const mpsByServerId = new Map(terminalUiRuntimeState.serverMps);

  // terminalUi.setSnapshot({
  //   blacklistedServers: [...serverBlacklist.entries()].map(
  //     ([serverId, startedAt]) => [
  //       serverId,
  //       Math.floor((Date.now() - startedAt) / 1000),
  //     ],
  //   ),
  //   childServers: [...childServerMap.entries()].map(([serverId, child]) => ({
  //     clients: clientsByServerId.get(serverId) ?? 0,
  //     isKilled: child.process.killed,
  //     mps: mpsByServerId.get(serverId) ?? 0,
  //     pid: child.process.pid,
  //     serverId,
  //     state: child.state,
  //   })),
  //   status: "running",
  //   ...runtimeState,
  // });
};

const ensureChatRoom = (id: string): ChatRoomState => {
  if (!chatRooms.has(id)) {
    const empty = () =>
      new NumericList(...Array.from({ length: 100 }).map(() => 0));
    chatRooms.set(id, {
      clients: empty(),
      messagesPerSecond: empty(),
      socketWritesPerSecond: empty(),
    });
  }
  return chatRooms.get(id)!;
};

const updateState = async () => {
  const [socketWrites, messages, clients] = await Promise.all([
    redisClient.zRangeWithScores(chatRoomSocketWritesPerSecondKey, 0, -1),
    redisClient.zRangeWithScores(chatRoomMessagesPerSecondKey, 0, -1),
    redisClient.zRangeWithScores(chatRoomTotalClientsKey, 0, -1),
  ]);

  socketWrites.forEach(({ value: id, score }) => {
    const room = ensureChatRoom(id);
    room.socketWritesPerSecond.shift();
    room.socketWritesPerSecond.push(score);
  });

  messages.forEach(({ value: id, score }) => {
    const room = ensureChatRoom(id);
    room.messagesPerSecond.shift();
    room.messagesPerSecond.push(score);
  });

  clients.forEach(({ value: id, score }) => {
    const room = ensureChatRoom(id);
    room.clients.shift();
    room.clients.push(score);
  });
};

export const startIntervals = () => {
  setInterval(async () => {
    await updateState();
    await healthChecks();
    // syncTerminalUi();
  }, 1000);
};
