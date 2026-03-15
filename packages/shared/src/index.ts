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
