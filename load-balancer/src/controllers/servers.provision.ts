import express from "express";
import { getLowestLoadServer } from "@chat/shared";
import { incrProvisionsThisSecond } from "../state.ts";

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
};
