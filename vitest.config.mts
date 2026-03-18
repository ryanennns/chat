import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@chat-client": fileURLToPath(new URL("./chat-client", import.meta.url)),
      "@chat-server": fileURLToPath(new URL("./chat-server", import.meta.url)),
      "@load-balancer": fileURLToPath(
        new URL("./load-balancer", import.meta.url),
      ),
      "@packages": fileURLToPath(new URL("./packages", import.meta.url)),
      "@shared": fileURLToPath(new URL("./packages/shared", import.meta.url)),
    },
  },
  test: {
    root: rootDir,
    environment: "node",
  },
});
