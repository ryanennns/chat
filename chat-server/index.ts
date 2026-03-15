import { createClient } from "redis";
import { v4 } from "uuid";
import WebSocket, { WebSocketServer } from "ws";
import { redisChatServersKey } from "@chat/shared";
import type {
  ChatPayload,
  ClientMessage,
  RegistrationPayload,
  Server,
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
  console.log("successfully added wss to redis!");
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

    wss.on("listening", () => resolve({ wss, port, serverId: v4() }));
  });
};
let { wss, port, serverId } = await websocketServerFactory(8080);
const liveConnectionsRedisKey = `${serverId}-connections`;
const url = `ws://localhost:${port}`;
console.log(`started wss on port ${port}`);
void addSelfToRedis(serverId, url).catch((e) => console.log("oh no", e));
const connections: Record<string, ClientSocket> = {};

wss.on("connection", async (socket) => {
  const client = socket as ClientSocket;
  const uuid = v4();

  client.isAlive = true;

  client.on("pong", () => {
    client.isAlive = true;
  });

  client.on("message", async (rawData) => {
    const message = JSON.parse(rawData.toString()) as ClientMessage<unknown>;

    switch (message.type) {
      case "chat":
        void publishChat(message as ClientMessage<ChatPayload>, client);
        break;
      case "register":
        void registerSocket(
          message as ClientMessage<RegistrationPayload>,
          client,
        );
        break;
      default:
        return;
    }
  });

  client.on("close", () => {
    delete connections[uuid];
    console.log("closing");
  });

  client.send(
    JSON.stringify({
      type: "welcome",
      connected_at: new Date().toISOString(),
    }),
  );

  connections[uuid] = client;
  await redisClient.set(
    liveConnectionsRedisKey,
    Object.keys(connections).length,
  );

  console.log(Object.values(connections).map((c) => c.chatId));
});

const subscriber = createClient();
await subscriber.connect();
// await subscriber.subscribe("chat", (message) => {
//   console.log(
//     "redis --> wss:",
//     message,
//     `across ${Object.values(connections).length} socket(s)`,
//   );
//
//   Object.values(connections).forEach((socket) => socket.send(message));
// });

const registerSocket = async (
  registrationMessage: ClientMessage<RegistrationPayload>,
  socket: ClientSocket,
) => {
  socket.chatId = registrationMessage.payload.chatId;

  const chatChannel = registrationMessage.payload.chatId;
  console.log(`subscribing to ${chatChannel}`);
  await subscriber.subscribe(chatChannel, (message: string) => {
    console.log(
      `redis msg --> channel ${chatChannel}`,
        message
    );
    Object.values(connections)
      .filter((socket) => socket.chatId === registrationMessage.payload.chatId)
      .forEach((socket) =>
        socket.send(
          message
        ),
      );
  });
};

const publishChat = async (
  message: ClientMessage<ChatPayload>,
  socket: ClientSocket,
) => {
  if (!socket.chatId) {
    return;
  }

  console.log("wss --> redis:", JSON.stringify(message.payload));
  await redisClient.publish(socket.chatId, JSON.stringify(message.payload));
};

await subscriber.subscribe("wss-list.clear", async () => {
  // todo all of the servers race against one another, making them unable
  // to all write back into redis simultaneously...
  // console.log(`re-registering wss ${serverId} with redis...`);
  // await addServer(serverId, url);
});

const shutdown = async () => {
  try {
    console.log("SIGTERM received. Shutting down Redis subscriber.");
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

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
