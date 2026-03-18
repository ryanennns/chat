import { createClient } from "redis";
import { v4 } from "uuid";
import { WebSocketServer } from "ws";
import type {
  ChatPayload,
  RegistrationPayload,
  WebSocketMessage,
} from "@chat/shared";
import {
  addServerToRedis,
  debugLog,
  redisRedistributeChannelFactory,
  removeServerFromRedis,
  serversLoadKey,
  serversTimeoutKey,
} from "@chat/shared";
import {
  ClientSocket,
  EVENTLOOP_TIMEOUT_THRESHOLD_MS,
  flushRoom,
  redistributeListener,
  REQUEST_HELP_EVERY_MS,
  Room,
} from "@chat-server/src/utils.js";

const redisClient = createClient();
await redisClient.connect();

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

const websocketServerFactory = (port: number): Promise<WebsocketServerInfo> => {
  return new Promise<WebsocketServerInfo>((resolve) => {
    let wss = new WebSocketServer({ port });

    wss.on("error", () => resolve(websocketServerFactory(port + 1)));

    wss.on("listening", async () => resolve({ wss, port, serverId: v4() }));
  });
};
let { wss, port, serverId } = await websocketServerFactory(8080);
const url = `ws://localhost:${port}`;
debugLog(`started ${serverId} on port ${port}`);
void addSelfToRedis();

const rooms: Map<string, Room> = new Map();

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

  client.on("close", () => {
    const chatId = client.chatId;
    if (chatId) {
      rooms.get(chatId)?.clients.delete(client);
    }
    if (chatId && (rooms.get(chatId)?.clients.size ?? 0) < 1) {
      debugLog(`unsubscribing from ${chatId}`);
      rooms.delete(chatId);
      subscriber.unsubscribe(chatId);
    }

    redisClient.zIncrBy(serversLoadKey, -1, serverId);
  });

  client.send(
    JSON.stringify({
      type: "welcome",
      connected_at: new Date().toISOString(),
    }),
  );

  await redisClient.zIncrBy(serversLoadKey, 1, serverId);
});

const subscriber = createClient();
await subscriber.connect();

await subscriber.subscribe(
  redisRedistributeChannelFactory(serverId),
  redistributeListener,
);

setInterval(async () => {
  await redisClient.zAdd(serversTimeoutKey, {
    score: Date.now(),
    value: serverId,
  });
  if (((await redisClient.zScore(serversLoadKey, serverId)) ?? 0) < 0) {
    await redisClient.zAdd(serversLoadKey, {
      score: 0,
      value: serverId,
    });
  }
}, 1000);

let lastRequestedHelp = 0;
const lastFivePerformanceNumbers = new Array(5).fill(0);
const shouldPanic = () => {
  return (
    lastFivePerformanceNumbers.reduce((a, b) => a + b) /
      lastFivePerformanceNumbers.length >
      EVENTLOOP_TIMEOUT_THRESHOLD_MS &&
    Date.now() - lastRequestedHelp > REQUEST_HELP_EVERY_MS
  );
};
const updatePerformanceNumbers = async (timeout: number) => {
  lastFivePerformanceNumbers.shift();
  lastFivePerformanceNumbers.push(timeout);
  if (shouldPanic()) {
    lastRequestedHelp = Date.now();
    debugLog("event loop is blocking! timeout: " + timeout);
    void redisClient.publish("panic", serverId);
  }
};
setInterval(() => {
  const start = performance.now();
  setImmediate(() => {
    const timeout = performance.now() - start;
    void updatePerformanceNumbers(timeout);
  });
}, 1000);

const registerSocket = async (
  registrationMessage: WebSocketMessage<RegistrationPayload>,
  socket: ClientSocket,
) => {
  const chatChannel = registrationMessage.payload.chatId;

  if (rooms.get(chatChannel) === undefined) {
    debugLog(`subscribing to ${chatChannel}`);

    rooms.set(chatChannel, {
      clients: new Set(),
      queue: [],
      running: false,
    });

    await subscriber.subscribe(chatChannel, (message: string) => {
      const room = rooms.get(registrationMessage.payload.chatId);

      if (room === undefined) {
        debugLog(`failed to find room ${registrationMessage.payload.chatId}!`);

        return;
      }

      room.queue.push(message);
      if (!room.running) {
        flushRoom(room);
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

  await redisClient.publish(socket.chatId, JSON.stringify(message.payload));
};

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
