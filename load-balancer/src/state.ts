import { NumericList, type Server, type ServerState } from "@chat/shared";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface ChatRoomState {
  clients: NumericList;
  cumulativeMessages: NumericList;
  cumulativeSocketWrites: NumericList;
}

export interface ChildProcess {
  server: Server;
  process: ChildProcessWithoutNullStreams;
  state: ServerState;
}

export const serverBlacklist: Map<string, number> = new Map();
export const socketServers: Map<string, ChildProcess> = new Map();
export const chatRooms: Map<string, ChatRoomState> = new Map();
export const ppsHistory: NumericList = new NumericList(
  ...Array.from({ length: 100 }).map(() => 0),
);
export let pps = 0;
export let provisionsThisSecond = 0;
export const incrProvisionsThisSecond = () => provisionsThisSecond++;
export const setPps = (value: number) => (pps = value);
export const resetProvisionsThisSecond = () => (provisionsThisSecond = 0);
