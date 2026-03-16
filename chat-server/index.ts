import { createClient } from "redis";
import { v4 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import type {
  ChatPayload,
  RedistributionPayload,
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

interface ClientSocket extends WebSocket {
  id: string;
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
const url = `ws://localhost:${port}`;
debugLog(`started ${serverId} on port ${port}`);
void addSelfToRedis();

interface Room {
  clients: Set<ClientSocket>;
  queue: Array<string>;
  running: boolean;
}
const connections: Map<string, Room> = new Map();

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
      connections.get(chatId)?.clients.delete(client);
    }
    if (chatId && (connections.get(chatId)?.clients.size ?? 0) < 1) {
      debugLog(`unsubscribing from ${chatId}`);
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
      .map((c) => [...c])
      .flat()
      .sort(() => 0.5 - Math.random())
      .slice(0, redistributeBy)
      .forEach((socket) => socket.send(JSON.stringify(payload)));
  },
);

setInterval(async () => {
  await redisClient.zAdd(serversTimeoutKey, {
    score: Date.now(),
    value: serverId,
  });
}, 1000);

setInterval(() => {
  const start = performance.now();
  setImmediate(() => {
    console.log(performance.now() - start);
  });
}, 1000);

const flush = (room: Room) => {
  if (room.queue.length < 1) {
    room.running = false;

    return;
  }

  const message = room.queue.shift() as string;
  const sockets = Array.from(room.clients);

  let i = 0;

  const batch = () => {
    const end = Math.min(i + 50, sockets.length);

    for (; i < end; i++) {
      const socket = sockets[i];

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  };

  i < sockets.length ? setImmediate(batch) : setImmediate(() => flush(room));

  batch();
};

const registerSocket = async (
  registrationMessage: WebSocketMessage<RegistrationPayload>,
  socket: ClientSocket,
) => {
  const chatChannel = registrationMessage.payload.chatId;

  if (connections.get(chatChannel) === undefined) {
    debugLog(`subscribing to ${chatChannel}`);
    await subscriber.subscribe(chatChannel, (message: string) => {
      const room = connections.get(registrationMessage.payload.chatId);

      if (room === undefined) {
        debugLog(`failed to find room ${registrationMessage.payload.chatId}!`);

        return;
      }

      room.queue.push(message);
      if (!room.running) {
        flush(room);
      }
    });
  }

  socket.chatId = registrationMessage.payload.chatId;

  if (connections.get(chatChannel) === undefined) {
    connections.set(chatChannel, {
      clients: new Set(),
      queue: [],
      running: false,
    });
  }

  connections.get(chatChannel)?.clients.add(socket);
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
