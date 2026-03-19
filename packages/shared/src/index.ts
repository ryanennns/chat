import { createClient } from "redis";

export interface Server {
  id: string;
  url: string;
}

export const redistributeChannel = "wss-redistribute";
export const serversClientCountKey = "servers:load";
export const serversChatRoomsCountKey = "servers:chats";
export const serversRatioKey = "servers:load";
export const serversTimeoutKey = "servers:timeout";
export const redisRedistributeChannelFactory = (serverId: string) =>
  `${serverId}-${redistributeChannel}`;
export const redisServerKeyFactory = (serverId: string) => `server:${serverId}`;

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
  await redisClient.zAdd(serversTimeoutKey, {
    score: Date.now(),
    value: server.id,
  });

  redisClient.destroy();
};

export const removeServerFromRedis = async (serverId: string) => {
  const redisClient = createClient();
  await redisClient.connect();

  await redisClient.del(redisServerKeyFactory(serverId));
  await redisClient.zRem(serversClientCountKey, serverId);
  await redisClient.zRem(serversTimeoutKey, serverId);

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
}

declare const process: {
  env: Record<string, string | undefined>;
};

export const debugLog = (message: any) => {
  if (process.env.CHAT_DEBUG_LOG === "true") {
    console.log(message);
  }
};
