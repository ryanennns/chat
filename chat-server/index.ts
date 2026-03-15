import { createClient } from "redis";
import { v4 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import {
  debugLog,
  redistributeChannel,
  redisChatServersKey,
  redistributeChannelKeyGenerator,
} from "@chat/shared";
import type {
  ChatPayload,
  WebSocketMessage,
  RegistrationPayload,
  Server,
  RedistributionPayload,
} from "@chat/shared";

const redisClient = createClient();
await redisClient.connect();

const getServerList = async (): Promise<Server[]> =>
  JSON.parse((await redisClient.get(redisChatServersKey)) ?? "[]") ?? [];

const removeSelfFromRedis = async (id: string) => {
  await redisClient.set(
    redisChatServersKey,
    JSON.stringify(
      (await getServerList()).filter((server: Server) => server.id !== id),
    ),
  );
};

const addSelfToRedis = async (id: string, url: string) => {
  await redisClient.set(
    redisChatServersKey,
    JSON.stringify([...(await getServerList()), { id, url }]),
  );
  debugLog("successfully added wss to redis!");
};

interface ClientSocket extends WebSocket {
  isAlive: boolean;
  chatId: string | undefined;
}

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
const liveConnectionsRedisKey = `${serverId}-connections`;
const url = `ws://localhost:${port}`;
debugLog(`started wss on port ${port}`);
void addSelfToRedis(serverId, url).catch((e) => debugLog(`oh no ${String(e)}`));
const connections: Record<string, ClientSocket> = {};

wss.on("connection", async (socket) => {
  const client = socket as ClientSocket;
  const uuid = v4();

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
    const socket: ClientSocket = connections[uuid];
    delete connections[uuid];

    if (
      Object.values(connections).filter((c) => c.chatId === socket.chatId)
        .length < 1
    ) {
      debugLog(`unsubscribing from ${socket.chatId}`);
      subscriber.unsubscribe(socket.chatId);
    }

    redisClient.decr(liveConnectionsRedisKey);
  });

  client.send(
    JSON.stringify({
      type: "welcome",
      connected_at: new Date().toISOString(),
    }),
  );

  connections[uuid] = client;
  await redisClient.incr(liveConnectionsRedisKey);
});

const subscriber = createClient();
await subscriber.connect();

await subscriber.subscribe(
  redistributeChannelKeyGenerator(serverId),
  (message: string) => {
    const payload: WebSocketMessage<RedistributionPayload> = {
      type: "redistribute",
      payload: {
        reason: "new-wss",
      },
    };
    const redistributeBy = Math.floor(Math.max(Number(message) * 0.25, 1));
    debugLog(`over by ${message}; nuking ${redistributeBy} clients`);
    // get random connections
    Object.values(connections)
      .sort(() => 0.5 - Math.random())
      .slice(0, redistributeBy)
      .forEach((socket) => socket.send(JSON.stringify(payload)));
  },
);

const isSubscribedToChannel = (chatId: string) =>
  Object.values(connections).filter((socket) => socket.chatId === chatId)
    .length > 1;

const registerSocket = async (
  registrationMessage: WebSocketMessage<RegistrationPayload>,
  socket: ClientSocket,
) => {
  socket.chatId = registrationMessage.payload.chatId;
  const chatChannel = registrationMessage.payload.chatId;

  if (isSubscribedToChannel(chatChannel)) {
    return;
  }

  // debugLog(`subscribing to ${chatChannel}`);
  await subscriber.subscribe(chatChannel, (message: string) => {
    // debugLog(`redis msg --> channel ${chatChannel} ${message}`);
    Object.values(connections)
      .filter((socket) => socket.chatId === registrationMessage.payload.chatId)
      .forEach((socket) => socket.send(message));
  });
};

const publishChat = async (
  message: WebSocketMessage<ChatPayload>,
  socket: ClientSocket,
) => {
  if (!socket.chatId) {
    return;
  }

  // debugLog(`wss --> redis: ${JSON.stringify(message.payload)}`);
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
    await removeSelfFromRedis(serverId);
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
