export interface Server {
  id: string;
  url: string;
}

export const redisChatServersKey = "servers";

export interface ClientMessage<T> {
  type: "chat" | "register";
  payload: T;
}

export interface ChatPayload {
  message: string;
}

export interface RegistrationPayload {
  chatId: string;
}

declare const process: {
  env: Record<string, string | undefined>;
};

export const debugLog = (message: string) => {
  if (process.env.CHAT_DEBUG_LOG === "true") {
    console.log(message);
  }
};
