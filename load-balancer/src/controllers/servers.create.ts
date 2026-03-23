import express from "express";
import { v4 } from "uuid";
import { websocketServerFactory } from "../utils.ts";
import { debugLog } from "@chat/shared";
import { socketServers } from "../state.ts";

export const createServer = async (
  req: express.Request,
  res: express.Response,
) => {
  const serverId = v4();

  const factoryResponse = await websocketServerFactory(serverId);

  if (!factoryResponse) {
    res.send({
      error: "failed to start wss",
    });

    return;
  }
  debugLog(`created new server ${serverId}`);

  socketServers.set(serverId, factoryResponse);

  res.send(factoryResponse.server);

  return;
};
