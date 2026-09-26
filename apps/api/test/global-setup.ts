import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * Provides a MongoDB URI to tests. Uses TEST_MONGODB_URI when set (e.g. the docker compose
 * Mongo), otherwise starts an in-memory single-node replica set via mongodb-memory-server.
 */
export default async function setup(project: TestProject) {
  const external = process.env.TEST_MONGODB_URI;
  if (external) {
    project.provide("mongoUri", external);
    return;
  }
  // A replica set: payments use transactions, which standalone mongod doesn't support.
  const { MongoMemoryReplSet } = await import("mongodb-memory-server-core");
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  project.provide("mongoUri", mongod.getUri("mockprep-test"));
  return async () => {
    await mongod.stop();
  };
}
