import { spawnServer } from "../utils.ts";
import express from "express";
import { incrProvisionsThisSecond } from "../intervals.ts";
import { getLowestLoadServer, type Server } from "@chat/shared";
import { terminalUiRuntimeState } from "../state.ts";

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

  terminalUiRuntimeState.provisionCount++;
  terminalUiRuntimeState.lastProvisionedServer = server.id;
};
