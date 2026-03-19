import {
  redisServerKeyFactory,
  serversClientCountKey,
  serversRatioKey,
} from "@chat/shared";
import { redisClient, runtimeState, serverBlacklist } from "../utils.ts";
import express from "express";
import { incrementRequests } from "@load-balancer/src/intervals.ts";

export const provisionServer = async (
  req: express.Request,
  res: express.Response,
) => {
  let i = 0;
  let id: string | null = null;
  let url: string | null = null;
  while (i < 5) {
    id = (await redisClient.zRange(serversRatioKey, 0, 0))[0];

    if (!id || serverBlacklist.has(id)) {
      id = null;
      i++;
      continue;
    }

    url = await redisClient.hGet(redisServerKeyFactory(id), "url");

    if (!url) {
      id = null;
      i++;
      continue;
    }

    break;
  }

  if (!id || !url) {
    res.sendStatus(404);
    return;
  }

  incrementRequests();
  res.status(200).json({
    id,
    url,
  });

  runtimeState.provisionCount++;
  runtimeState.lastProvisionedServer = id;
};
