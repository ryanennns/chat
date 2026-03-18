import { redisServerKeyFactory, serversLoadKey } from "@chat/shared";
import { redisClient, runtimeState, serverBlacklist } from "../utils.ts";
import express from "express";

export const provisionServer = async (
  req: express.Request,
  res: express.Response,
) => {
  let i = 0;
  let id: string | null = null;

  while (i < 5) {
    id = (await redisClient.zRange(serversLoadKey, 0, 0))[0];

    if (!id || serverBlacklist.has(id)) {
      i++;
      continue;
    }

    break;
  }

  if (!id) {
    res.sendStatus(500);
    return;
  }

  let url = await redisClient.hGet(redisServerKeyFactory(id), "url");

  if (!id || !url) {
    res.sendStatus(404);
    return;
  }

  res.send(
    JSON.stringify({
      id,
      url,
    }),
  );

  runtimeState.provisionCount++;
  runtimeState.lastProvisionedServer = id;
};
