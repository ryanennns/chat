import { socketServers } from "../utils.ts";
import express from "express";
import { debugLog } from "@chat/shared";

export const deleteServer = (req: express.Request, res: express.Response) => {
  const array = Array.from(socketServers);
  array.sort(() => 0.5 - Math.random());

  if (!array.length) {
    res.send({
      message: "no servers to delete",
    });
  }

  const [serverId, server] = array[0];

  if (!serverId) {
    res.send({
      message: "no servers to delete",
    });

    return;
  }

  socketServers.delete(serverId);

  server.process.kill();

  debugLog(`killed server ${serverId}`);
  res.send({
    message: `killed server ${serverId}`,
  });
};
