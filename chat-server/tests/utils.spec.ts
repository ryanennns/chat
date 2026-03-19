import { beforeEach, describe, expect, it, vi } from "vitest";

const getLowestLoadServer = vi.hoisted(() => vi.fn());

vi.mock("@chat/shared", async () => {
  const actual =
    await vi.importActual<typeof import("@chat/shared")>("@chat/shared");

  return {
    ...actual,
    getLowestLoadServer,
  };
});

import {
  ClientSocket,
  flushRoom,
  redistributeBy,
  Room,
  setRedistributeBy,
} from "@chat-server/src/utils.js";

describe("flushRoom", () => {
  const flushTicks = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  const mockClientSocket = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  };

  const set = new Set<ClientSocket>();
  set.add(mockClientSocket as unknown as ClientSocket);

  beforeEach(() => {
    mockClientSocket.send = vi.fn();
    getLowestLoadServer.mockReset();
    getLowestLoadServer.mockResolvedValue(undefined);
  });

  it("flushes messages from the queue", () => {
    const messageQueue = ["1"];

    const room: Room = {
      clients: set,
      queue: [...messageQueue],
      running: true,
    };

    flushRoom(room);

    expect(mockClientSocket.send).toHaveBeenCalledTimes(messageQueue.length);
    messageQueue.forEach((message) =>
      expect(mockClientSocket.send).toHaveBeenCalledWith(message),
    );
  });

  it("sends redistribute payload instead of message if redistributeBy > 0", async () => {
    setRedistributeBy(1);

    const messageQueue = ["1"];

    const room: Room = {
      clients: set,
      queue: [...messageQueue],
      running: false,
    };

    flushRoom(room);
    await flushTicks();

    expect(mockClientSocket.send).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        type: "redistribute",
        payload: {
          reason: "new-wss",
          redirect: undefined,
        },
      }),
    );
    expect(redistributeBy).toEqual(0);
  });
});
