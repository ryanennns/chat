import { describe, expect, it, vi } from "vitest";
import { app } from "@load-balancer/src/app.js";
import supertest from "supertest";
import { v4 } from "uuid";

const mockRedisClient = vi.hoisted(() => ({
  connect: vi.fn(),
  zRange: vi.fn(),
  hGet: vi.fn(),
}));

vi.mock("redis", () => {
  return {
    createClient: vi.fn(() => mockRedisClient),
  };
});

describe("servers.provision", () => {
  it("throws 500 if no server found", async () => {
    const response = await supertest(app).get("/servers/provision").send();

    expect(mockRedisClient.zRange).toHaveBeenCalledOnce();
    expect(mockRedisClient.hGet).not.toHaveBeenCalled();

    expect(response.status).toEqual(500);
  });

  it("throws 404 if ID found but no URL found", async () => {
    mockRedisClient.zRange = vi.fn(() => v4());

    const response = await supertest(app).get("/servers/provision").send();

    expect(mockRedisClient.zRange).toHaveBeenCalledOnce();
    expect(mockRedisClient.hGet).toHaveBeenCalledOnce();

    expect(response.status).toEqual(404);
  });

  it("returns 200 if server found", async () => {
    const uuid = v4();
    mockRedisClient.zRange = vi.fn(() => uuid);
    mockRedisClient.hGet = vi.fn(() => "ws://snickers.test:8080");

    const response = await supertest(app).get("/servers/provision").send();

    expect(mockRedisClient.zRange).toHaveBeenCalledOnce();
    expect(mockRedisClient.hGet).toHaveBeenCalledOnce();

    expect(response.status).toEqual(200);
  });
});
