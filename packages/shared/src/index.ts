export interface Server {
  id: string;
  url: string;
}

export const redisChatServersKey = "servers";
export const redistributeChannel = "wss-redistribute";

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

export const debugLog = (message: string) => {
  if (process.env.CHAT_DEBUG_LOG === "true") {
    console.log(message);
  }
};
