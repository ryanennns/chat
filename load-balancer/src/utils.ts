import { createClient } from "redis";
import { terminalUi } from "../terminal-ui.ts";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { redisServerKeyFactory, type Server } from "@chat/shared";
import { v4 } from "uuid";

export const redisClient = createClient();
await redisClient.connect();
export const subscriptionClient = createClient();
await subscriptionClient.connect();

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
  rps: 0,
  serverLoads: [] as Array<[string, number]>,
  timedOutServers: [] as string[],
  totalClients: 0,
  totalServers: 0,
};

export const shutdown = async () => {
  try {
    terminalUi.destroy();
    await redisClient.quit();
    await subscriptionClient.quit();
  } catch {
    redisClient.destroy();
    subscriptionClient.destroy();
  } finally {
    process.exit(0);
  }
};

await subscriptionClient.subscribe("panic", () => {
  // void websocketServerFactory(v4());
});

setInterval(() => {
  terminalUi.setSnapshot({
    blacklistedServers: [...serverBlacklist.entries()].map(
      ([serverId, startedAt]) => [
        serverId,
        Math.floor((Date.now() - startedAt) / 1000),
      ],
    ),
    status: "running",
    ...runtimeState,
  });
}, 1000);

export const childServerMap = new Map<string, ChildProcessWithoutNullStreams>();
export const websocketServerFactory = async (
  id: string,
): Promise<
  | {
      server: Server;
      child: ChildProcessWithoutNullStreams;
    }
  | undefined
> => {
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

  const args = [path.resolve("../chat-server/dist/chat-server/index.js")];
  args.push(`--id=${id}`);

  const child = spawn(process.execPath, args);

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
    child,
  };
};
