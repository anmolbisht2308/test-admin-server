import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 20_000,
  },
});
