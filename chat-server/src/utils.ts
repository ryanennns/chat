import {
  debugLog,
  getLowestLoadServer,
  RedistributionPayload,
  Server,
  WebSocketMessage,
} from "@chat/shared";
import WebSocket from "ws";

export let redistributeBy = 0;
export const setRedistributeBy = (number: number) => (redistributeBy = number);
export const REQUEST_HELP_EVERY_MS = 10_000;
export const EVENTLOOP_TIMEOUT_THRESHOLD_MS = 15.0;
// export const REDISTRIBUTE_BY_FACTOR = 0.22;
export const MESSAGE_BATCH_SIZE = 10;

let lowestLoadServer: Server | undefined = undefined;
setInterval(async () => {
  lowestLoadServer = await getLowestLoadServer();
}, 1000);

const redistributeMessageFactory =
  (): WebSocketMessage<RedistributionPayload> => {
    const message: WebSocketMessage<RedistributionPayload> = {
      type: "redistribute",
      payload: {
        reason: "new-wss",
        redirect: undefined,
      },
    };

    if (lowestLoadServer) {
      message.payload.redirect = lowestLoadServer.url;
    }

    return message;
  };

export interface ClientSocket extends WebSocket {
  id: string;
  isAlive: boolean;
  chatId: string | undefined;
}

export interface Room {
  clients: Set<ClientSocket>;
  queue: Array<string>;
  running: boolean;
}

export const redistributeListener = (message: string) => {
  redistributeBy = Math.floor(Math.max(Number(message) * 0.15, 1));
};

export const flushRoom = (room: Room, callback: () => void = () => {}) => {
  if (room.queue.length < 1) {
    room.running = false;

    return;
  }

  const message = room.queue.shift() as string;
  const sockets = room.clients.values();

  let i = 0;

  const batch = () => {
    const end = Math.min(i + MESSAGE_BATCH_SIZE, room.clients.size);

    for (; i < end; i++) {
      const socket = sockets.next().value;
      if (!socket) {
        return;
      }

      if (socket.readyState === WebSocket.OPEN) {
        if (redistributeBy > 0) {
          socket.send(JSON.stringify(redistributeMessageFactory()));
          redistributeBy--;
        } else {
          socket.send(message);
        }
        callback();
      }
    }

    i < room.clients.size
      ? setImmediate(batch)
      : setImmediate(() => flushRoom(room));
  };

  batch();
};
