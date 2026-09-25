import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditLogModel } from "../src/models/auditLog.js";
import { accessTokenFor, buildTestApp, useTestDatabase } from "./helpers.js";

useTestDatabase();

let auth: { Authorization: string };
beforeEach(async () => {
  auth = {
    Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000aa", "superadmin")}`,
  };
});

describe("taxonomy tree", () => {
  it("derives levels and materialised paths from the parent", async () => {
    const app = buildTestApp();
    const post = (body: object) => request(app).post("/api/admin/taxonomy").set(auth).send(body);

    const subject = (
      await post({ examFamily: "banking", name: "Quantitative Aptitude" }).expect(201)
    ).body.node;
    const topic = (
      await post({ examFamily: "banking", parentId: subject.id, name: "Arithmetic" }).expect(201)
    ).body.node;
    const sub = (
      await post({ examFamily: "banking", parentId: topic.id, name: "Percentage" }).expect(201)
    ).body.node;

    expect([subject.level, topic.level, sub.level]).toEqual(["subject", "topic", "subtopic"]);
    expect(sub.path).toBe(`/${subject.id}/${topic.id}/${sub.id}/`);

    const tooDeep = await post({
      examFamily: "banking",
      parentId: sub.id,
      name: "Too deep",
    }).expect(400);
    expect(tooDeep.body.error).toMatch(/Subtopics/);
    await post({ examFamily: "ssc", parentId: subject.id, name: "Wrong family" }).expect(400);
    // Sibling names are unique per parent, case-insensitively.
    await post({ examFamily: "banking", parentId: subject.id, name: "arithmetic" }).expect(409);

    const list = await request(app)
      .get("/api/admin/taxonomy?examFamily=banking")
      .set(auth)
      .expect(200);
    expect(list.body.nodes).toHaveLength(3);
    expect(
      (await request(app).get("/api/admin/taxonomy?examFamily=ssc").set(auth).expect(200)).body
        .nodes,
    ).toEqual([]);
  });

  it("renames with an audit diff and refuses to delete nodes with children", async () => {
    const app = buildTestApp();
    const subject = (
      await request(app)
        .post("/api/admin/taxonomy")
        .set(auth)
        .send({ examFamily: "ssc", name: "Reasoning" })
        .expect(201)
    ).body.node;
    await request(app)
      .post("/api/admin/taxonomy")
      .set(auth)
      .send({ examFamily: "ssc", parentId: subject.id, name: "Series" })
      .expect(201);

    await request(app)
      .patch(`/api/admin/taxonomy/${subject.id}`)
      .set(auth)
      .send({ name: "General Intelligence" })
      .expect(200);
    const log = await AuditLogModel.findOne({ entity: "taxonomy", action: "update" }).lean();
    expect(log?.diff).toEqual({ name: { from: "Reasoning", to: "General Intelligence" } });

    await request(app).delete(`/api/admin/taxonomy/${subject.id}`).set(auth).expect(409);
  });
});
