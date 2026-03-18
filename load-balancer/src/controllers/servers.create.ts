import express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { v4 } from "uuid";
import { childServerMap, subscriptionClient } from "../utils.ts";
import { redisServerKeyFactory } from "@chat/shared";

export const createServer = async (
  req: express.Request,
  res: express.Response,
) => {
  const serverId = v4();
  let foundNewServer = false;
  let url: string | undefined = undefined;
  console.log("making ", serverId);
  await subscriptionClient.subscribe(
    redisServerKeyFactory(serverId),
    (newUrl: string) => {
      console.log(newUrl);
      foundNewServer = true;
      url = newUrl;
    },
  );

  const child = spawn(process.execPath, [
    path.resolve("../chat-server/dist/chat-server/index.js"),
    `--id=${serverId}`,
  ]);

  child.on("error", () => {
    res.send({
      error: "failed to start wss",
    });

    childServerMap.delete(serverId);

    return;
  });

  const poll = async () => {
    while (!foundNewServer) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  await poll();

  childServerMap.set(serverId, child);

  if (serverId && url) {
    res.send({
      id: serverId,
      url,
    });

    return;
  }

  res.sendStatus(500);

  return;
};
