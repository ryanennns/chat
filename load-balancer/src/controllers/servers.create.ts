import express from "express";
import { v4 } from "uuid";
import { childServerMap, websocketServerFactory } from "../utils.ts";

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

  childServerMap.set(serverId, factoryResponse.child);

  res.send(factoryResponse.server);

  return;
};
