import { NumericList, type Server, type ServerState } from "@chat/shared";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface ChatRoomState {
  clients: NumericList;
  messagesPerSecond: NumericList;
  socketWritesPerSecond: NumericList;
}

export interface ChildProcess {
  server: Server;
  process: ChildProcessWithoutNullStreams;
  state: ServerState;
}

export const socketServers = new Map<string, ChildProcess>();
export const chatRooms: Map<string, ChatRoomState> = new Map();
export let lastSpawnedServer = Date.now();
export const setLastSpawnedServer = (time: number) =>
  (lastSpawnedServer = time);
