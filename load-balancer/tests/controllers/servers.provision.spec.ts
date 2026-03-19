import { describe, expect, it, vi } from "vitest";
import { app } from "@load-balancer/src/app.js";
import supertest from "supertest";
import { v4 } from "uuid";
import { serverBlacklist } from "@load-balancer/src/utils.ts";
import { serversClientCountKey } from "@packages/shared/src/index.ts";

const mockRedisClient = vi.hoisted(() => ({
  connect: vi.fn(),
  zRange: vi.fn(),
  hGet: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("redis", () => {
  return {
    createClient: vi.fn(() => mockRedisClient),
  };
});

const endpoint = "/servers/provision";
describe("servers.provision", () => {
  it("throws 404 if no server found", async () => {
    mockRedisClient.zRange = vi.fn(async () => [undefined, undefined]);
    const response = await supertest(app).get(endpoint).send();

    expect(mockRedisClient.zRange).toHaveBeenCalledTimes(5);
    expect(mockRedisClient.zRange).toHaveBeenCalledWith(
      serversClientCountKey,
      0,
      0,
    );
    expect(mockRedisClient.hGet).not.toHaveBeenCalled();

    expect(response.status).toEqual(404);
  });

  it("throws 404 if ID found but no URL found", async () => {
    const uuid = v4();
    mockRedisClient.zRange = vi.fn(async () => [uuid, 0]);

    const response = await supertest(app).get(endpoint).send();

    expect(mockRedisClient.zRange).toHaveBeenCalledTimes(5);
    expect(mockRedisClient.zRange).toHaveBeenCalledWith(
      serversClientCountKey,
      0,
      0,
    );
    expect(mockRedisClient.hGet).toHaveBeenCalledTimes(5);
    expect(mockRedisClient.hGet).toHaveBeenCalledWith(`server:${uuid}`, "url");

    expect(response.status).toEqual(404);
  });

  it("returns 200 if server found", async () => {
    const uuid = v4();
    const url = "ws://snickers.test:8080";
    mockRedisClient.zRange = vi.fn(() => [uuid, 0]);
    mockRedisClient.hGet = vi.fn(() => "ws://snickers.test:8080");

    const response = await supertest(app).get(endpoint).send();

    expect(mockRedisClient.zRange).toHaveBeenCalledOnce();
    expect(mockRedisClient.zRange).toHaveBeenCalledWith(
      serversClientCountKey,
      0,
      0,
    );
    expect(mockRedisClient.hGet).toHaveBeenCalledOnce();
    expect(mockRedisClient.hGet).toHaveBeenCalledWith(`server:${uuid}`, "url");

    expect(response.status).toEqual(200);
    expect(response.body).toEqual({
      id: uuid,
      url,
    });
  });

  it("skips existing servers that are in the blacklist", async () => {
    const blacklistedServerUuid = v4();
    mockRedisClient.zRange = vi.fn(() => [blacklistedServerUuid, 0]);
    mockRedisClient.hGet = vi.fn(() => "ws://snickers.test:8080");

    serverBlacklist.set(blacklistedServerUuid, 0);

    const response = await supertest(app).get(endpoint).send();

    expect(response.status).toBe(404);
  });
});
