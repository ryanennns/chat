import type {
  ChatPayload,
  WebSocketMessage,
  RegistrationPayload,
} from "@chat/shared";

const LOAD_BALANCER_URL = "http://localhost:3000";
const CHATTER_COUNT = 5000
const CHAT_ROOM_COUNT = 1;
const MESSAGE_INTERVAL_MIN_MS = 1500;
const MESSAGE_INTERVAL_MAX_MS = 6_000;
const INITIAL_CONNECT_STAGGER_MS = 20;
const RECONNECT_DELAY_MS = 100;

type ProvisionedServer = {
  id: string;
  url: string;
};

type ProvisionError = {
  error: string;
};

const loremWords = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const randomBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const provisionServer = async (): Promise<ProvisionedServer> => {
  const response = await fetch(`${LOAD_BALANCER_URL}/servers/provision`);

  if (!response.ok) {
    throw new Error(
      `Provision request failed with ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as ProvisionedServer | ProvisionError;

  if ("error" in payload) {
    throw new Error(`Provisioning failed: ${payload.error}`);
  }

  return payload;
};

const buildMessage = (chatRoomId: string) => {
  const wordCount = randomBetween(3, 8);
  const words = Array.from({ length: wordCount }, () => {
    return loremWords[randomBetween(0, loremWords.length - 1)];
  });

  const sentence = words.join(" ");
  return `${chatRoomId} - ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
};

const runChatter = async (chatterId: number) => {
  const label = `chatter-${chatterId + 1}`;
  const chatRoomId = `chat-room-${(chatterId % CHAT_ROOM_COUNT) + 1}`;

  while (true) {
    let socket: WebSocket | null = null;
    let keepSending = true;
    let sender: Promise<void> | undefined;

    try {
      const server = await provisionServer();
      console.log(`[${label}] provisioned ${server.id} at ${server.url}`);

      await new Promise<void>((resolve, reject) => {
        socket = new WebSocket(server.url);

        socket.addEventListener("message", (message) => {
          const payload = JSON.parse(message.data) as WebSocketMessage<unknown>;

          if (payload.type === "redistribute") {
            socket?.close();
          }
        });

        socket.addEventListener("open", () => {
          const registrationMessage: WebSocketMessage<RegistrationPayload> = {
            type: "register",
            payload: {
              chatId: chatRoomId,
            },
          };

          if (socket === null) {
            return;
          }
          socket.send(JSON.stringify(registrationMessage));
          console.log(`[${label}] connected to ${chatRoomId}`);

          sender = (async () => {
            while (keepSending) {
              const delay = randomBetween(
                MESSAGE_INTERVAL_MIN_MS,
                MESSAGE_INTERVAL_MAX_MS,
              );

              await sleep(delay);

              if (!socket || socket.readyState !== WebSocket.OPEN) {
                continue;
              }

              const message = buildMessage(chatRoomId);
              const payload: WebSocketMessage<ChatPayload> = {
                type: "chat",
                payload: {
                  message,
                },
              };

              socket.send(JSON.stringify(payload));
              console.log(
                `[${label}] sent to ${chatRoomId} after ${delay}ms ${JSON.stringify(payload)}`,
              );
            }
          })().catch((error) => {
            const message =
              error instanceof Error ? error.message : "sender loop failed";
            console.error(`[${label}] ${message}`);
          });

          resolve();
        });

        socket.addEventListener("error", () => {
          reject(new Error("websocket connection failed"));
        });

        socket.addEventListener("close", () => {
          reject(new Error("websocket connection closed"));
        });
      });

      await new Promise<void>((resolve) => {
        socket?.addEventListener("close", () => resolve(), { once: true });
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown chatter failure";
      console.error(`[${label}] ${message}`);
    } finally {
      keepSending = false;
      if (socket) {
        (socket as unknown as WebSocket).close();
      }
      await sender;
    }

    console.log(`[${label}] reconnecting in ${RECONNECT_DELAY_MS}ms`);
    await sleep(RECONNECT_DELAY_MS);
  }
};

const main = async () => {
  if (CHAT_ROOM_COUNT < 1) {
    throw new Error("CHAT_ROOM_COUNT must be at least 1");
  }

  console.log(
    `Starting ${CHATTER_COUNT} simulated chatter(s) across ${CHAT_ROOM_COUNT} chat room(s) against ${LOAD_BALANCER_URL}`,
  );

  for (let index = 0; index < CHATTER_COUNT; index += 1) {
    void (async () => {
      await sleep(index * INITIAL_CONNECT_STAGGER_MS);
      await runChatter(index);
    })();
  }
};

await main();
