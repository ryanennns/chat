import express from "express";

export const createServer = async (
  req: express.Request,
  res: express.Response,
) => {
  res.sendStatus(500);
};
