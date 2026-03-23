import { createClient } from "redis";

export interface Server {
  id: string;
  url: string;
}

export class NumericList extends Array<number> {
  max() {
    return Math.max(...this);
  }

  min() {
    return Math.min(...this);
  }

  average() {
    return this.reduce((a, b) => a + b) / this.length;
  }

  deltas() {
    return this.map((v, i) => v - (this[i - 1] ?? 0));
  }
}

export type HistoryKey = Exclude<
  {
    [K in keyof ServerState]: ServerState[K] extends NumericList ? K : never;
  }[keyof ServerState],
  "chatRooms"
>;

export interface ServerState {
  clients: NumericList;
  socketWrites: NumericList;
  timeouts: NumericList;
  messages: NumericList;
  chatRoomMessages: Record<string, number>;
  chatRoomSocketWrites: Record<string, NumericList>;
}
export const defaultServerState = (): ServerState => ({
  clients: new NumericList(...Array.from({ length: 100 }).map(() => 0)),
  socketWrites: new NumericList(...Array.from({ length: 100 }).map(() => 0)),
  timeouts: new NumericList(...Array.from({ length: 100 }).map(() => 0)),
  messages: new NumericList(...Array.from({ length: 100 }).map(() => 0)),
  chatRoomMessages: {},
  chatRoomSocketWrites: {},
});

export const redistributeChannel = "wss-redistribute";
export const serversClientCountKey = "servers:clients";
export const serversChatRoomsCountKey = "servers:chats";
export const serversHeartbeatKey = "servers:heartbeat";
export const serversSocketWritesPerSecondKey = "servers:swps";
export const serversEventLoopTimeoutKey = "servers:event-loop";
export const chatRoomSocketWritesPerSecondKey = "chat-rooms:socket-writes";
export const chatRoomMessagesPerSecondKey = "chat-rooms:messages";
export const chatRoomTotalClientsKey = "chat-rooms:clients";
export const redisRedistributeChannelFactory = (serverId: string) =>
  `${serverId}-${redistributeChannel}`;
export const redisServerKeyFactory = (serverId: string) => `server:${serverId}`;
export const redisChatCountKeyFactory = (chatChannel: string) =>
  `chat:${chatChannel}`;

export const addServerToRedis = async (server: Server) => {
  const redisClient = createClient();
  await redisClient.connect();

  await redisClient.hSet(redisServerKeyFactory(server.id), {
    serverId: server.id,
    url: server.url,
  });
  await redisClient.zAdd(serversClientCountKey, {
    score: 0,
    value: server.id,
  });
  await redisClient.zAdd(serversHeartbeatKey, {
    score: Date.now(),
    value: server.id,
  });
  await redisClient.zAdd(serversSocketWritesPerSecondKey, {
    score: 0,
    value: server.id,
  });

  redisClient.destroy();
};

export const removeServerFromRedis = async (serverId: string) => {
  const redisClient = createClient();
  await redisClient.connect();

  await redisClient.del(redisServerKeyFactory(serverId));
  await redisClient.zRem(serversClientCountKey, serverId);
  await redisClient.zRem(serversHeartbeatKey, serverId);
  await redisClient.zRem(serversChatRoomsCountKey, serverId);
  await redisClient.zRem(serversSocketWritesPerSecondKey, serverId);

  redisClient.destroy();
};

export interface WebSocketMessage<T> {
  type: "chat" | "register" | "redistribute";
  payload: T;
}

// server --> client, client --> server
// standard chat message payload
export interface ChatPayload {
  message: string;
}

// client --> server; informs the server
// which chat they are registering to, so
// the server can sub to redis channel
export interface RegistrationPayload {
  chatId: string;
}

// server --> client; informs client to
// ask server for new wss connection for
// rebalancing purposes
export interface RedistributionPayload {
  reason: string;
  redirect: string | undefined;
}

declare const process: {
  env: Record<string, string | undefined>;
};

export const debugLog = (message: any) => {
  if (process.env.CHAT_DEBUG_LOG === "true") {
    console.log(message);
  }
};

export const getLowestLoadServers = async (
  count?: number | undefined,
): Promise<Array<{ id: string; url: string }>> => {
  const redisClient = createClient();
  await redisClient.connect();

  const ids = await redisClient.zRange(
    serversClientCountKey,
    0,
    (count ?? 100) - 1,
  );

  const results: Array<{ id: string; url: string }> = [];

  for (const id of ids) {
    const url = await redisClient.hGet(redisServerKeyFactory(id), "url");
    if (url) {
      results.push({ id, url });
    }
  }

  redisClient.destroy();

  return results;
};

export const getLowestLoadServer = async (): Promise<Server | undefined> => {
  const server = (await getLowestLoadServers())[0];

  if (!server) {
    return undefined;
  }

  return server;
};
