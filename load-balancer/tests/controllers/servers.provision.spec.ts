import { describe, expect, it, vi } from "vitest";
import { app } from "../../src/app.js";
import supertest from "supertest";

vi.mock("redis", () => ({
  createClient: vi.fn(() => ({
    connect: vi.fn(),
  })),
}));

describe("servers.provision", () => {
  it("throws 500 if no server found", async () => {
    const snickers = await supertest(app).get("/servers/provision").send();

    expect(snickers.status).toEqual(500);
  });
});
