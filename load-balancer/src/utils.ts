import { createClient } from "redis";
// import { terminalUi } from "../terminal-ui.ts";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import {
  chatRoomTotalClientsKey,
  chatRoomSocketWritesPerSecondKey,
  debugLog,
  defaultServerState,
  redisServerKeyFactory,
  removeServerFromRedis,
  type Server,
  type ServerState,
} from "@chat/shared";
import { v4 } from "uuid";

export const redisClient = createClient();
await redisClient.connect();
export const subscriptionClient = createClient();
await subscriptionClient.connect();

void subscriptionClient.subscribe("message", (message) => {
  const payload = JSON.parse(message);
  debugLog(`${payload.serverId} - ${payload.message}`);
});

export const serverBlacklist = new Map<string, number>();

export const runtimeState = {
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

export const shutdown = async () => {
  try {
    // terminalUi.destroy();
    await redisClient.quit();
    await subscriptionClient.quit();
    for (let [id, childServerMapElement] of childServerMap) {
      await removeServerFromRedis(id);
      childServerMapElement.process.kill(1);
    }
    await redisClient.del(chatRoomSocketWritesPerSecondKey);
    await redisClient.del(chatRoomTotalClientsKey);
  } catch {
    redisClient.destroy();
    subscriptionClient.destroy();
  } finally {
    process.exit(0);
  }
};

await subscriptionClient.subscribe("panic", (server: string) => {
  const payload = JSON.parse(server);
  debugLog(
    `server id ${payload.serverId.slice(0, 5)} is timing out (${payload.timeout.toFixed(2)})`,
  );
});

export const spawnServer = async () => {
  const output = await websocketServerFactory(v4());

  if (output) {
    childServerMap.set(output.server.id, output);

    return output.server;
  }

  if (!output) {
    debugLog("error; unable to spawn server");

    return undefined;
  }
};

export interface ChildProcess {
  server: Server;
  process: ChildProcessWithoutNullStreams;
  state: ServerState;
}

export const childServerMap = new Map<string, ChildProcess>();
export const websocketServerFactory = async (
  id: string,
): Promise<ChildProcess | undefined> => {
  let foundNewServer = false;
  let url: string | undefined = undefined;
  await subscriptionClient.subscribe(
    redisServerKeyFactory(id),
    (newUrl: string) => {
      console.log(newUrl);
      foundNewServer = true;
      url = newUrl;
    },
  );

  const args = [
    "--experimental-transform-types",
    path.resolve("../chat-server/dist/chat-server/index.js"),
  ];
  args.push(`--id=${id}`);

  const child = spawn(process.execPath, args);

  child.on("error", (e) => debugLog(`child process error: ${e.message}`));
  child.on("exit", (code, signal) =>
    debugLog(`child exited with code=${code} signal=${signal}`),
  );
  child.stderr.on("data", (chunk) =>
    debugLog(`child stderr: ${chunk.toString().trim()}`),
  );

  const timeoutMs = 5_000;
  const now = Date.now();
  const poll = async () => {
    while (!foundNewServer && Date.now() - now < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  await poll();

  await subscriptionClient.unsubscribe(redisServerKeyFactory(id));

  if (!url) {
    return undefined;
  }

  return {
    server: {
      id,
      url,
    },
    process: child,
    state: defaultServerState(),
  };
};
