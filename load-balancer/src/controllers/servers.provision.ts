import express from "express";
import { incrProvisionsThisSecond, socketServers } from "../state.ts";

export const provisionServer = async (
  req: express.Request,
  res: express.Response,
) => {
  incrProvisionsThisSecond();
  let servers = [...socketServers.values()]
    .map((s) => ({
      server: s.server,
      state: s.state,
    }))
    .sort(
      (a, b) =>
        a.state.socketWrites.deltas().lastN(3).average() -
        b.state.socketWrites.deltas().lastN(3).average(),
    );

  let server = servers[0]!.server;

  console.log(
    servers.map((s) => s.state.socketWrites.deltas().lastN(3).average()),
  );

  if (!server) {
    res.sendStatus(404);
    return;
  }

  res.status(200).json({
    id: server.id,
    url: server.url,
  });
};
