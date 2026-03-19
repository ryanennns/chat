import { beforeEach, describe, expect, it, vi } from "vitest";
import { v4 } from "uuid";
import type express from "express";

const getLowestLoadServer = vi.hoisted(() => vi.fn());
const incrProvisionsThisSecond = vi.hoisted(() => vi.fn());
const runtimeState = vi.hoisted(() => ({
  lastProvisionedServer: null as string | null,
  provisionCount: 0,
}));

vi.mock("@chat/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@chat/shared")>("@chat/shared");

  return {
    ...actual,
    getLowestLoadServer,
  };
});

vi.mock("@load-balancer/src/intervals.ts", () => ({
  incrProvisionsThisSecond,
}));

vi.mock("@load-balancer/src/utils.ts", () => ({
  runtimeState,
}));

import { provisionServer } from "@load-balancer/src/controllers/servers.provision.ts";

describe("servers.provision", () => {
  beforeEach(() => {
    getLowestLoadServer.mockReset();
    incrProvisionsThisSecond.mockReset();
    runtimeState.lastProvisionedServer = null;
    runtimeState.provisionCount = 0;
  });

  const responseFactory = () => {
    const response = {
      json: vi.fn(),
      sendStatus: vi.fn(),
      status: vi.fn(),
    } as unknown as express.Response;
    vi.mocked(response.status).mockReturnValue(response);

    return response;
  };

  it("throws 404 if no server is found", async () => {
    getLowestLoadServer.mockResolvedValue(undefined);
    const response = responseFactory();

    await provisionServer({} as express.Request, response);

    expect(getLowestLoadServer).toHaveBeenCalledOnce();
    expect(incrProvisionsThisSecond).toHaveBeenCalledOnce();
    expect(response.sendStatus).toHaveBeenCalledOnce();
    expect(response.sendStatus).toHaveBeenCalledWith(404);
    expect(runtimeState.provisionCount).toBe(0);
  });

  it("returns 200 if a server is found", async () => {
    const server = {
      id: v4(),
      url: "ws://snickers.test:8080",
    };
    getLowestLoadServer.mockResolvedValue(server);
    const response = responseFactory();

    await provisionServer({} as express.Request, response);

    expect(getLowestLoadServer).toHaveBeenCalledOnce();
    expect(incrProvisionsThisSecond).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledOnce();
    expect(response.json).toHaveBeenCalledWith(server);
    expect(runtimeState.provisionCount).toBe(1);
    expect(runtimeState.lastProvisionedServer).toBe(server.id);
  });
});
