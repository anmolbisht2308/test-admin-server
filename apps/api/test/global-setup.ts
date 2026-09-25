import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * Provides a MongoDB URI to tests. Uses TEST_MONGODB_URI when set (e.g. the docker compose
 * Mongo), otherwise starts an in-memory mongod via mongodb-memory-server.
 */
export default async function setup(project: TestProject) {
  const external = process.env.TEST_MONGODB_URI;
  if (external) {
    project.provide("mongoUri", external);
    return;
  }
  const { MongoMemoryServer } = await import("mongodb-memory-server-core");
  const mongod = await MongoMemoryServer.create();
  project.provide("mongoUri", mongod.getUri("mockprep-test"));
  return async () => {
    await mongod.stop();
  };
}
