import { redisClient, serverBlacklist, spawnServer } from "./utils.ts";
import {
  chatRoomCumulativeMessages,
  chatRoomCumulativeSocketWrites,
  chatRoomTotalClientsKey,
  debugLog,
  type HistoryKey,
  NumericList,
  redisRedistributeChannelFactory,
  redisServerKeyFactory,
  removeServerFromRedis,
  serversClientCountKey,
  serversCumulativeSocketWritesKey,
  serversEventLoopTimeoutKey,
  serversHeartbeatKey,
} from "@chat/shared";
import {
  chatRooms,
  type ChatRoomState,
  ppsHistory,
  provisionsThisSecond,
  resetProvisionsThisSecond,
  setPps,
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
    redisClient.zRangeWithScores(serversCumulativeSocketWritesKey, 0, -1),
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
      socketServers.get(cp.server.id)!.state.chatRooms[key.split("chat:")[1]] =
        Number(value);
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
    await healthChecks();
    await updateServerState();
    await updateChatRoomState();

    await decideWhatToDoNext();
    resetAddressingServers();
  }, 1000);
};

const addressingServer: Record<string, number> = {};
const ADDRESSING_SERVER_TIMEOUT = 15_000;
const resetAddressingServers = () => {
  Object.keys(addressingServer).forEach((key) => {
    if (Date.now() - addressingServer[key] > ADDRESSING_SERVER_TIMEOUT) {
      delete addressingServer[key];
    }
  });
};

const SPAWN_NEW_SERVER = 40_000;
const otherServersDoNotHaveCapacity = () => {
  let hasCapacity = false;
  for (let [_, wss] of socketServers) {
    if (
      wss.state.socketWrites
        .deltas()
        .lastN(3)
        .filter((n) => n < SPAWN_NEW_SERVER * 0.8).length
    ) {
      hasCapacity = true;
    }
  }

  return !hasCapacity;
};
export const decideWhatToDoNext = async () => {
  let spawned = false;
  for (let [serverId, wss] of socketServers) {
    const socketWriteDeltas = wss.state.socketWrites.deltas();
    const aboveSocketWriteBreakpointInLastTenSeconds =
      socketWriteDeltas.lastN(10).filter((d) => d >= SPAWN_NEW_SERVER).length >
      1;

    if (
      aboveSocketWriteBreakpointInLastTenSeconds &&
      otherServersDoNotHaveCapacity() &&
      Date.now() - (addressingServer[serverId] ?? 0) > ADDRESSING_SERVER_TIMEOUT
    ) {
      addressingServer[serverId] = Date.now();
      !spawned ? void spawnServer() : null;
      spawned = true;
      debugLog("met criteria for new server spawn");
    }

    // redistribute
    if (
      socketWriteDeltas.lastN(5).filter((d) => d >= SPAWN_NEW_SERVER * 1.33)
        .length > 1
    ) {
      const serverChatRoomLoads: Record<string, number> = {};
      Object.keys(wss.state.chatRooms).forEach((chatRoomId) => {
        const chatRoom = chatRooms.get(chatRoomId);

        if (!chatRoom) {
          return;
        }

        serverChatRoomLoads[chatRoomId] =
          chatRoom.cumulativeMessages.deltas().lastN(3).average() *
          wss.state.chatRooms[chatRoomId];
      });

      let keyOfHighestLoadChatRoomOnServer: string | undefined = undefined;
      let maxValue = 0;
      for (const [key, value] of Object.entries(serverChatRoomLoads)) {
        if (value > maxValue) {
          maxValue = value;
          keyOfHighestLoadChatRoomOnServer = key;
        }
      }

      if (!keyOfHighestLoadChatRoomOnServer) {
        throw new Error("how did you do this");
      }

      console.log(
        `redistributing ${serverId} by ${wss.state.clients.last() * 0.04}`,
      );
      void redisClient.publish(
        redisRedistributeChannelFactory(serverId),
        JSON.stringify({
          chatRoom: keyOfHighestLoadChatRoomOnServer,
          n: wss.state.clients.last() * 0.04,
        }),
      );
    }
  }
};
