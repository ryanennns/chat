import { NumericList } from "@chat/shared";

export interface ChatRoomState {
  clients: NumericList;
  messagesPerSecond: NumericList;
  socketWritesPerSecond: NumericList;
}

export const chatRooms: Map<string, ChatRoomState> = new Map();
export let lastSpawnedServer = Date.now();
export const setLastSpawnedServer = (time: number) =>
  (lastSpawnedServer = time);
