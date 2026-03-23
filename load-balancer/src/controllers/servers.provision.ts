import { runtimeState, spawnServer } from "../utils.ts";
import express from "express";
import { incrProvisionsThisSecond } from "../intervals.ts";
import { getLowestLoadServer, type Server } from "@chat/shared";
import {
  ChildProcess,
  lastSpawnedServer,
  setLastSpawnedServer,
  socketServers,
} from "../state.ts";

const MAX_SOCKET_SPIKE_LOAD = 75_000;
const serverAtMaxCapacity = (server: ChildProcess): boolean => {
  return server.state.socketWrites.max() > MAX_SOCKET_SPIKE_LOAD;
};
const shouldSpawnServer = () => Date.now() - lastSpawnedServer > 10_000;
export const getBestCandidateServer = async (): Promise<Server | undefined> => {
  const servers = [...socketServers.values()];

  let candidate: ChildProcess | undefined = undefined;
  servers.forEach((server) => {
    if (serverAtMaxCapacity(server)) {
      return;
    }

    if (true /* some other conditions... */) {
      // early return
    }

    candidate = server;
  });

  if (!candidate && shouldSpawnServer()) {
    setLastSpawnedServer(Date.now());
    return await spawnServer();
  }

  return (candidate as ChildProcess | undefined)?.server;
};

export const provisionServer = async (
  req: express.Request,
  res: express.Response,
) => {
  incrProvisionsThisSecond();
  let server = await getLowestLoadServer();

  if (!server) {
    res.sendStatus(404);
    return;
  }

  res.status(200).json({
    id: server.id,
    url: server.url,
  });

  runtimeState.provisionCount++;
  runtimeState.lastProvisionedServer = server.id;
};
