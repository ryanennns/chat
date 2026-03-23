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

export const terminalUiRuntimeState = {
  currentRequests: 0,
  lastProvisionedServer: null as string | null,
  lastRedistribution: null as {
    amount: number;
    serverId: string;
    timestamp: string;
  } | null,
  lastRemovedServer: null as string | null,
  optimalDistribution: 0,
  provisionCount: 0,
  pps: 0,
  serverMps: [] as Array<[string, number]>,
  serverLoads: [] as Array<[string, number]>,
  timedOutServers: [] as string[],
  totalClients: 0,
  totalServers: 0,
};

export const socketServers = new Map<string, ChildProcess>();
export const chatRooms: Map<string, ChatRoomState> = new Map();
export const ppsHistory: NumericList = new NumericList(
  ...Array.from({ length: 100 }).map(() => 0),
);
export let pps = 0;
export let provisionsThisSecond = 0;
export const incrProvisionsThisSecond = () => provisionsThisSecond++;
export const setPps = (value: number) => (pps = value);
export const resetProvisionsThisSecond = () => (provisionsThisSecond = 0);
export let lastSpawnedServer = Date.now();
export const setLastSpawnedServer = (time: number) =>
  (lastSpawnedServer = time);
