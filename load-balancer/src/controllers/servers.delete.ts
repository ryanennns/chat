import { childServerMap } from "../utils.ts";
import express from "express";

export const deleteServer = (req: express.Request, res: express.Response) => {
  const array = Array.from(childServerMap);
  array.sort(() => 0.5 - Math.random());

  const [serverId, process] = array[0];

  if (!serverId) {
    res.send({
      message: "no servers to delete",
    });

    return;
  }

  childServerMap.delete(serverId);

  process.kill();

  res.send({
    message: `killed server ${serverId}`,
  });
};
