import { redisClient, serverBlacklist } from "./utils.ts";
import {
  chatRoomCumulativeMessages,
  chatRoomCumulativeSocketWrites,
  chatRoomTotalClientsKey,
  type HistoryKey,
  NumericList,
  redisServerKeyFactory,
  removeServerFromRedis,
  serversClientCountKey,
  serversEventLoopTimeoutKey,
  serversHeartbeatKey,
  serversSocketWritesPerSecondKey,
} from "@chat/shared";
import {
  chatRooms,
  ppsHistory,
  provisionsThisSecond,
  resetProvisionsThisSecond,
  setPps,
  type ChatRoomState,
  socketServers,
} from "./state.ts";

const wssServerTimeoutMs: number = Number(
  process.env.SERVER_TIMEOUT_MS ?? 1_000,
);
const wssBlacklistRemovalTimeoutMs = Number(
  process.env.BLACKLIST_REMOVAL_TIMEOUT_MS ?? 10_000,
);

const detectTimedOutServers = async () => {
  const now = Date.now();
  const cutoff = now - wssServerTimeoutMs;
  const timedOutServers = await redisClient.zRangeByScore(
    serversHeartbeatKey,
    0,
    cutoff,
  );

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
  await detectTimedOutServers();
  purgeBlacklistedServers();
};

export const updateServerState = async () => {
  const [socketWrites, clients, timeoutValues] = await Promise.all([
    redisClient.zRangeWithScores(serversSocketWritesPerSecondKey, 0, -1),
    redisClient.zRangeWithScores(serversClientCountKey, 0, -1),
    redisClient.zRangeWithScores(serversEventLoopTimeoutKey, 0, -1),
  ]);

  // socket writes
  socketWrites.forEach(({ value: id, score: writesPerSecond }) =>
    updateServerStateHistoryArray(id, "socketWrites", writesPerSecond),
  );
  // clients
  clients.forEach(({ value: id, score: clients }) =>
    updateServerStateHistoryArray(id, "clients", clients),
  );
  timeoutValues.forEach(({ value: id, score: timeout }) =>
    updateServerStateHistoryArray(id, "timeouts", timeout),
  );

  for (const cp of [...socketServers.values()]) {
    const hashFields = await redisClient.hGetAll(
      redisServerKeyFactory(cp.server.id),
    );
    const rooms = Object.entries(hashFields).filter(([key]) =>
      key.startsWith("chat:"),
    );

    for (const [key, value] of rooms) {
      socketServers.get(cp.server.id)!.state.chatRooms[key] = Number(value);
    }
  }

  updatePps();
};
const updatePps = () => {
  setPps(provisionsThisSecond);
  ppsHistory.rotate(provisionsThisSecond);
  resetProvisionsThisSecond();
};

const ensureChatRoomExists = (id: string): ChatRoomState => {
  if (!chatRooms.has(id)) {
    const empty = () =>
      new NumericList(...Array.from({ length: 100 }).map(() => 0));
    chatRooms.set(id, {
      clients: empty(),
      cumulativeMessages: empty(),
      cumulativeSocketWrites: empty(),
    });
  }
  return chatRooms.get(id)!;
};

export const updateChatRoomState = async () => {
  const [socketWrites, messages, clients] = await Promise.all([
    redisClient.zRangeWithScores(chatRoomCumulativeSocketWrites, 0, -1),
    redisClient.zRangeWithScores(chatRoomCumulativeMessages, 0, -1),
    redisClient.zRangeWithScores(chatRoomTotalClientsKey, 0, -1),
  ]);

  socketWrites.forEach(({ value: id, score }) => {
    const room = ensureChatRoomExists(id);
    room.cumulativeSocketWrites.rotate(score);
  });

  messages.forEach(({ value: id, score }) => {
    const room = ensureChatRoomExists(id);
    room.cumulativeMessages.rotate(score);
  });

  clients.forEach(({ value: id, score }) => {
    const room = ensureChatRoomExists(id);
    room.clients.rotate(score);
  });
};

export const startIntervals = () => {
  setInterval(async () => {
    console.log(
      JSON.stringify(
        {
          servers: [...socketServers.values()].map((s) => ({
            clients: s.state.clients.lastN(10).trendScore(),
            socketWrites: s.state.socketWrites.lastN(10).deltas().trendScore(),
            timeouts: s.state.timeouts.lastN(10).deltas().trendScore(),
            chatRooms: s.state.chatRooms,
          })),
          chatRooms: [...chatRooms.values()].map((chatRoom) => ({
            clients: chatRoom.clients.lastN(10).trendScore(),
            cumulativeMessages: chatRoom.cumulativeMessages
              .lastN(10)
              .deltas()
              .trendScore(),
            cumulativeSocketWrites: chatRoom.cumulativeSocketWrites
              .lastN(10)
              .deltas()
              .trendScore(),
          })),
        },
        null,
        2,
      ),
    );

    await healthChecks();
    await updateServerState();
    await updateChatRoomState();
  }, 1000);
};
