import { createClient } from "redis";
import { v4 } from "uuid";
import { WebSocketServer } from "ws";
import {
  addServerToRedis,
  ChatPayload,
  chatRoomCumulativeMessages,
  chatRoomCumulativeSocketWrites,
  chatRoomTotalClientsKey,
  debugLog,
  redisChatCountKeyFactory,
  redisRedistributeChannelFactory,
  redisServerKeyFactory,
  RegistrationPayload,
  removeServerFromRedis,
  serversClientCountKey,
  serversCumulativeSocketWritesKey,
  serversEventLoopTimeoutKey,
  serversFanoutCounterKey,
  serversHeartbeatKey,
  type WebSocketMessage,
} from "@chat/shared";
import { ClientSocket, flushRoom, redistributeListener } from "./src/utils.js";
import {
  clientCount,
  decrementChatCount,
  decrementClientCount,
  incrementChatCount,
  incrementClientCount,
  rooms,
} from "./src/state.js";

const redisClient = createClient();
await redisClient.connect();
const subscriber = createClient();
await subscriber.connect();

const removeSelfFromRedis = async () => {
  void removeServerFromRedis(serverId);
};

const addSelfToRedis = async () => {
  void addServerToRedis({
    id: serverId,
    url,
  });

  debugLog("successfully added wss to redis!");
};

interface WebsocketServerInfo {
  wss: WebSocketServer;
  port: number;
  serverId: string;
}

const idArg = process.argv.find((arg) => arg.startsWith("--id="));
const idArgument = idArg ? idArg.split("=")[1] : undefined;
const websocketServerFactory = (port: number): Promise<WebsocketServerInfo> => {
  return new Promise<WebsocketServerInfo>((resolve) => {
    let wss = new WebSocketServer({ port });

    wss.on("error", () => resolve(websocketServerFactory(port + 1)));

    wss.on("listening", async () =>
      resolve({ wss, port, serverId: idArgument ?? v4() }),
    );
  });
};
let { wss, port, serverId } = await websocketServerFactory(8080);
await subscriber.subscribe(
  redisRedistributeChannelFactory(serverId),
  redistributeListener,
);
const url = `ws://localhost:${port}`;
debugLog(`started ${serverId} on port ${port}`);
await redisClient.publish(redisServerKeyFactory(serverId), url);
void addSelfToRedis();

wss.on("connection", async (socket) => {
  const client = socket as ClientSocket;
  client.id = v4();

  client.isAlive = true;

  client.on("pong", () => {
    client.isAlive = true;
  });

  client.on("message", async (rawData) => {
    const message = JSON.parse(rawData.toString()) as WebSocketMessage<unknown>;

    switch (message.type) {
      case "chat":
        void publishChat(message as WebSocketMessage<ChatPayload>, client);
        break;
      case "register":
        void registerSocket(
          message as WebSocketMessage<RegistrationPayload>,
          client,
        );
        break;
      default:
        return;
    }
  });

  client.on("close", async () => {
    const chatId = client.chatId;
    if (chatId) {
      void redisClient.zIncrBy(chatRoomTotalClientsKey, -1, chatId);
      void redisClient.hIncrBy(
        redisServerKeyFactory(serverId),
        redisChatCountKeyFactory(chatId),
        -1,
      );
      rooms.get(chatId)?.clients.delete(client);
    }

    if (chatId && (rooms.get(chatId)?.clients.size ?? 0) < 1) {
      debugLog(`unsubscribing from ${chatId}`);
      rooms.delete(chatId);
      await subscriber.unsubscribe(chatId);
      decrementChatCount();
    }

    decrementClientCount();
  });

  client.send(
    JSON.stringify({
      type: "welcome",
      connected_at: new Date().toISOString(),
    }),
  );

  incrementClientCount();
});

// === metrics updating === //
let socketWritesThisSecond = 0;
const updateMetrics = () => {
  void redisClient.zAdd(serversHeartbeatKey, {
    score: Date.now(),
    value: serverId,
  });
  void redisClient.zAdd(serversCumulativeSocketWritesKey, {
    score: socketWritesThisSecond,
    value: serverId,
  });
  void redisClient.zAdd(serversClientCountKey, {
    score: clientCount,
    value: serverId,
  });
  void redisClient.zAdd(serversEventLoopTimeoutKey, {
    score: lastFiveTimeoutValues[0],
    value: serverId,
  });
  const memoryUsage = process.memoryUsage();
  void redisClient.hSet(
    redisServerKeyFactory(serverId),
    "rss",
    memoryUsage.rss,
  );
  void redisClient.hSet(
    redisServerKeyFactory(serverId),
    "heapTotal",
    memoryUsage.heapTotal,
  );
  void redisClient.hSet(
    redisServerKeyFactory(serverId),
    "heapUsed",
    memoryUsage.heapUsed,
  );
  void redisClient.hSet(
    redisServerKeyFactory(serverId),
    "external",
    memoryUsage.external,
  );
  void redisClient.hSet(
    redisServerKeyFactory(serverId),
    "arrayBuffers",
    memoryUsage.arrayBuffers,
  );
};
setInterval(updateMetrics, 1000);
const lastFiveTimeoutValues = new Array(5).fill(0);
setInterval(() => {
  const start = performance.now();
  setImmediate(() => {
    lastFiveTimeoutValues.shift();
    lastFiveTimeoutValues.push(performance.now() - start);
  });
}, 1000);

// === wss message actions === //
const registerSocket = async (
  registrationMessage: WebSocketMessage<RegistrationPayload>,
  socket: ClientSocket,
) => {
  const chatChannel = registrationMessage.payload.chatId;
  await redisClient.zIncrBy(chatRoomTotalClientsKey, 1, chatChannel);
  await redisClient.hIncrBy(
    redisServerKeyFactory(serverId),
    redisChatCountKeyFactory(chatChannel),
    1,
  );

  if (rooms.get(chatChannel) === undefined) {
    incrementChatCount();
    debugLog(`subscribing to ${chatChannel}`);

    rooms.set(chatChannel, {
      clients: new Set(),
      queue: [],
      running: false,
    });

    await subscriber.subscribe(chatChannel, (message: string) => {
      const room = rooms.get(registrationMessage.payload.chatId);

      void redisClient.zIncrBy(serversFanoutCounterKey, 1, serverId);

      if (room === undefined) {
        debugLog(`failed to find room ${registrationMessage.payload.chatId}!`);

        return;
      }

      room.queue.push(message);
      if (!room.running) {
        flushRoom(room, (socket: ClientSocket) => {
          socketWritesThisSecond++;
          if (!socket.chatId) {
            return;
          }

          void redisClient.zIncrBy(
            chatRoomCumulativeSocketWrites,
            1,
            socket.chatId,
          );
        });
      }
    });
  }

  socket.chatId = registrationMessage.payload.chatId;

  rooms.get(chatChannel)?.clients.add(socket);
};

const publishChat = async (
  message: WebSocketMessage<ChatPayload>,
  socket: ClientSocket,
) => {
  if (!socket.chatId) {
    return;
  }

  void redisClient.zIncrBy(chatRoomCumulativeMessages, 1, socket.chatId);
  void redisClient.publish(socket.chatId, JSON.stringify(message.payload));
};

// === shutdown === //
let isShuttingDown = false;
const shutdown = async (signal = "unknown") => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    debugLog(`${signal} received. Shutting down websocket server.`);
    wss.clients.forEach((client) => client.close());
    await new Promise<void>((resolve, reject) =>
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      }),
    );
    await removeSelfFromRedis();
    await subscriber.quit();
    await redisClient.quit();
  } catch {
    subscriber.destroy();
    redisClient.destroy();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGUSR2", () => void shutdown("SIGUSR2"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));
