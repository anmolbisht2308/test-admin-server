import {
  CouponModel,
  EntitlementModel,
  ExamTemplateModel,
  InvoiceModel,
  OrderModel,
  PlanModel,
  ProcessedEventModel,
  TestModel,
  UserModel,
  toTemplateSnapshot,
} from "@mockprep/core";
import {
  accessResponseSchema,
  orderCreateResponseSchema,
  purchaseListResponseSchema,
  revenueReportSchema,
} from "@mockprep/types";
import { createHmac } from "node:crypto";
import { Types } from "mongoose";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeGateway } from "../src/services/paymentGateway.js";
import { makeQuestion, seed } from "./factories.js";
import { accessTokenFor, buildTestApp, useTestDatabase } from "./helpers.js";

useTestDatabase();

type Auth = { Authorization: string };
const bearer = async (userId: string, role: "student" | "superadmin" | "content" = "student") => ({
  Authorization: `Bearer ${await accessTokenFor(userId, role)}`,
});

let invoicesQueued: string[];
const newApp = () =>
  buildTestApp({
    paymentGateway: new FakeGateway(),
    enqueueInvoice: (id) => {
      invoicesQueued.push(id);
      return Promise.resolve();
    },
  });

let app: ReturnType<typeof newApp>;
let studentId: string;
let student: Auth;
let admin: Auth;
let planId: string;
let paidTestId: string;

beforeEach(async () => {
  invoicesQueued = [];
  await seed();
  app = newApp();
  const user = await UserModel.create({
    role: "student",
    email: "buyer@example.com",
    name: "Asha",
  });
  studentId = user.id;
  student = await bearer(studentId);
  const adminUser = await UserModel.create({ role: "superadmin", email: "boss@example.com" });
  admin = await bearer(adminUser.id, "superadmin");
  const plan = await PlanModel.create({
    name: "SBI PO Series",
    kind: "series",
    examKeys: ["sbi-po"],
    pricePaise: 49900,
    validityDays: 365,
  });
  planId = plan.id;
  const template = await ExamTemplateModel.findOne({ key: "sbi-po-prelims" }).lean();
  if (!template) throw new Error("seed missing");
  const q = await makeQuestion({ section: "Quantitative Aptitude" });
  const test = await TestModel.create({
    title: "Paid mock",
    examKey: "sbi-po",
    type: "full",
    status: "published",
    publishedAt: new Date(),
    isFree: false,
    templateSnapshot: {
      ...toTemplateSnapshot(template),
      totalTimeSec: 600,
      sectionSwitching: "free",
      sections: [{ name: "Quantitative Aptitude", count: 1, aliases: [] }],
    },
    sections: [{ name: "Quantitative Aptitude", questionIds: [q.id] }],
  });
  paidTestId = test.id;
});

async function createOrder(body: Record<string, unknown> = { planId }) {
  const res = await request(app).post("/api/orders").set(student).send(body).expect(201);
  return orderCreateResponseSchema.parse(res.body);
}

function signedEvent(event: string, entity: Record<string, unknown>, key = "payment") {
  const raw = JSON.stringify({ entity: "event", event, payload: { [key]: { entity } } });
  const signature = createHmac("sha256", FakeGateway.WEBHOOK_SECRET).update(raw).digest("hex");
  return { raw, signature };
}

const postWebhook = (raw: string, signature: string, eventId: string) =>
  request(app)
    .post("/api/webhooks/razorpay")
    .set("content-type", "application/json")
    .set("x-razorpay-signature", signature)
    .set("x-razorpay-event-id", eventId)
    .send(raw);

const access = async () =>
  accessResponseSchema.parse(
    (await request(app).get("/api/me/access").set(student).expect(200)).body,
  );

describe("paywall", () => {
  it("locks paid tests until an entitlement covers the exam", async () => {
    const res = await request(app)
      .post("/api/attempts")
      .set(student)
      .send({ testId: paidTestId })
      .expect(403);
    expect(res.body.details).toEqual({ reason: "locked", examKey: "sbi-po" });

    // An entitlement for another exam doesn't help; an expired one neither.
    await EntitlementModel.create({
      userId: studentId,
      examKeys: ["ssc-cgl"],
      expiresAt: new Date(Date.now() + 86_400_000),
      source: "manual",
    });
    await EntitlementModel.create({
      userId: studentId,
      examKeys: ["sbi-po"],
      expiresAt: new Date(Date.now() - 1000),
      source: "manual",
    });
    await request(app).post("/api/attempts").set(student).send({ testId: paidTestId }).expect(403);

    await EntitlementModel.create({
      userId: studentId,
      all: true,
      expiresAt: new Date(Date.now() + 86_400_000),
      source: "manual",
    });
    await request(app).post("/api/attempts").set(student).send({ testId: paidTestId }).expect(201);
  });
});

describe("checkout", () => {
  it("rejects a client-sent amount (price tampering) and prices on the server", async () => {
    const tampered = await request(app)
      .post("/api/orders")
      .set(student)
      .send({ planId, amountPaise: 100 })
      .expect(400);
    expect(tampered.body.error).toBeTruthy();
    await request(app)
      .post("/api/orders/quote")
      .set(student)
      .send({ planId, pricePaise: 1 })
      .expect(400);
    expect(await OrderModel.countDocuments()).toBe(0);

    const order = await createOrder();
    expect(order.amountPaise).toBe(49900);
    expect(order.provider).toBe("fake");
    expect(order.razorpayOrderId).toMatch(/^order_fake/);
    expect(order.prefill.email).toBe("buyer@example.com");
  });

  it("never grants access when the captured amount differs from the order", async () => {
    const order = await createOrder();
    const { raw, signature } = signedEvent("payment.captured", {
      id: "pay_x1",
      order_id: order.razorpayOrderId,
      amount: 100,
    });
    const res = await postWebhook(raw, signature, "evt_amount").expect(200);
    expect(res.body.outcome).toBe("ignored");
    expect((await OrderModel.findById(order.orderId))?.status).toBe("created");
    expect((await access()).examKeys).toEqual([]);
  });

  it("verify: bad signature 400, good signature unlocks instantly with an invoice", async () => {
    const order = await createOrder();
    await request(app)
      .post("/api/payments/verify")
      .set(student)
      .send({
        orderId: order.orderId,
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: "pay_forged",
        razorpaySignature: "a".repeat(64),
      })
      .expect(400);

    const paid = await request(app)
      .post("/api/payments/fake/complete")
      .set(student)
      .send({ orderId: order.orderId, outcome: "success", webhook: false })
      .expect(200);
    const verify = await request(app)
      .post("/api/payments/verify")
      .set(student)
      .send({ orderId: order.orderId, ...paid.body })
      .expect(200);
    expect(verify.body.status).toBe("paid");
    expect(verify.body.access.examKeys).toEqual(["sbi-po"]);
    await request(app).post("/api/attempts").set(student).send({ testId: paidTestId }).expect(201);

    const invoice = await InvoiceModel.findOne({ orderId: order.orderId, kind: "invoice" });
    expect(invoice?.number).toMatch(/^MP\/\d{4}-\d{2}\/000001$/);
    expect(invoice?.cgstPaise).toBe(3806);
    expect((invoice?.taxablePaise ?? 0) + (invoice?.cgstPaise ?? 0) * 2).toBe(49900);
    expect(invoicesQueued).toEqual([invoice?.id]);

    // The later webhook for the same payment changes nothing.
    const { raw, signature } = signedEvent("payment.captured", {
      id: paid.body.razorpayPaymentId,
      order_id: order.razorpayOrderId,
      amount: 49900,
    });
    expect((await postWebhook(raw, signature, "evt_late").expect(200)).body.outcome).toBe(
      "ignored",
    );
    expect(await EntitlementModel.countDocuments({ orderId: order.orderId })).toBe(1);
    expect(await InvoiceModel.countDocuments()).toBe(1);
  });

  it("webhook alone grants access (browser closed after paying)", async () => {
    const order = await createOrder();
    await request(app)
      .post("/api/payments/fake/complete")
      .set(student)
      .send({ orderId: order.orderId, outcome: "success" })
      .expect(200);
    // No /verify call.
    expect((await access()).examKeys).toEqual(["sbi-po"]);
    const status = await request(app).get(`/api/orders/${order.orderId}`).set(student).expect(200);
    expect(status.body.status).toBe("paid");
  });

  it("replayed webhooks do nothing twice", async () => {
    const order = await createOrder();
    const { raw, signature } = signedEvent("payment.captured", {
      id: "pay_replay",
      order_id: order.razorpayOrderId,
      amount: 49900,
    });
    const first = await postWebhook(raw, signature, "evt_1").expect(200);
    expect(first.body.outcome).toBe("processed");
    for (let i = 0; i < 3; i++) {
      const again = await postWebhook(raw, signature, "evt_1").expect(200);
      expect(again.body.outcome).toBe("duplicate");
    }
    expect(await EntitlementModel.countDocuments()).toBe(1);
    expect(await InvoiceModel.countDocuments()).toBe(1);
    expect(await ProcessedEventModel.countDocuments()).toBe(1);
    expect(invoicesQueued).toHaveLength(1);
  });

  it("rejects webhooks with a bad signature", async () => {
    const order = await createOrder();
    const { raw } = signedEvent("payment.captured", {
      id: "pay_evil",
      order_id: order.razorpayOrderId,
      amount: 49900,
    });
    await postWebhook(raw, "0".repeat(64), "evt_evil").expect(400);
    expect((await access()).all).toBe(false);
  });

  it("payment.failed marks the order failed; a retry can still pay it", async () => {
    const order = await createOrder();
    await request(app)
      .post("/api/payments/fake/complete")
      .set(student)
      .send({ orderId: order.orderId, outcome: "failure" })
      .expect(200);
    expect((await OrderModel.findById(order.orderId))?.status).toBe("failed");
    await request(app)
      .post("/api/payments/fake/complete")
      .set(student)
      .send({ orderId: order.orderId, outcome: "success" })
      .expect(200);
    expect((await OrderModel.findById(order.orderId))?.status).toBe("paid");
  });

  it("applies coupons, enforces per-user limits, and 100 % coupons are free", async () => {
    await CouponModel.create({ code: "SAVE20", kind: "percent", percent: 20 });
    await CouponModel.create({ code: "FREEBIE", kind: "percent", percent: 100 });
    await request(app)
      .post("/api/orders/quote")
      .set(student)
      .send({ planId, couponCode: "nope" })
      .expect(400);
    const quote = await request(app)
      .post("/api/orders/quote")
      .set(student)
      .send({ planId, couponCode: "save20" })
      .expect(200);
    expect(quote.body).toMatchObject({ amountPaise: 39920, discountPaise: 9980 });

    const free = await createOrder({ planId, couponCode: "FREEBIE" });
    expect(free.provider).toBe("free");
    expect((await access()).examKeys).toEqual(["sbi-po"]);
    expect((await CouponModel.findOne({ code: "FREEBIE" }))?.uses).toBe(1);
    const again = await request(app)
      .post("/api/orders")
      .set(student)
      .send({ planId, couponCode: "FREEBIE" })
      .expect(400);
    expect(again.body.error).toMatch(/already used/);
  });
});

describe("refunds", () => {
  it("admin refund revokes access and records a credit note (once)", async () => {
    const order = await createOrder();
    await request(app)
      .post("/api/payments/fake/complete")
      .set(student)
      .send({ orderId: order.orderId, outcome: "success" })
      .expect(200);
    await request(app)
      .post(`/api/admin/orders/${order.orderId}/refund`)
      .set(admin)
      .send({})
      .expect(400);
    const res = await request(app)
      .post(`/api/admin/orders/${order.orderId}/refund`)
      .set(admin)
      .send({ reason: "Bought by mistake" })
      .expect(200);
    expect(res.body.status).toBe("refunded");
    expect((await access()).examKeys).toEqual([]);
    await request(app).post("/api/attempts").set(student).send({ testId: paidTestId }).expect(403);
    const note = await InvoiceModel.findOne({ orderId: order.orderId, kind: "credit_note" });
    expect(note?.number).toMatch(/^MP\/CN\/\d{4}-\d{2}\/000001$/);

    // Double click / the refund.processed webhook afterwards: nothing more happens.
    await request(app)
      .post(`/api/admin/orders/${order.orderId}/refund`)
      .set(admin)
      .send({ reason: "again" })
      .expect(409);
    const paid = await OrderModel.findById(order.orderId).lean();
    const { raw, signature } = signedEvent(
      "refund.processed",
      { id: "rfnd_x", payment_id: paid?.razorpayPaymentId, amount: 49900 },
      "refund",
    );
    expect((await postWebhook(raw, signature, "evt_refund").expect(200)).body.outcome).toBe(
      "ignored",
    );
    expect(await InvoiceModel.countDocuments({ kind: "credit_note" })).toBe(1);

    const purchases = purchaseListResponseSchema.parse(
      (await request(app).get("/api/me/purchases").set(student).expect(200)).body,
    );
    expect(purchases.purchases[0]).toMatchObject({ status: "refunded", active: false });
    expect(purchases.purchases[0]?.creditNote?.kind).toBe("credit_note");

    const pdf = await request(app)
      .get(`/api/me/purchases/${order.orderId}/invoice?kind=credit_note`)
      .set(student)
      .expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
  });

  it("a refund.processed webhook (dashboard refund) revokes access", async () => {
    const order = await createOrder();
    await request(app)
      .post("/api/payments/fake/complete")
      .set(student)
      .send({ orderId: order.orderId, outcome: "success" })
      .expect(200);
    const paid = await OrderModel.findById(order.orderId).lean();
    const { raw, signature } = signedEvent(
      "refund.processed",
      { id: "rfnd_dash", payment_id: paid?.razorpayPaymentId, amount: 49900 },
      "refund",
    );
    expect((await postWebhook(raw, signature, "evt_r1").expect(200)).body.outcome).toBe(
      "processed",
    );
    expect((await access()).examKeys).toEqual([]);
    expect(await InvoiceModel.countDocuments({ kind: "credit_note" })).toBe(1);
  });

  it("only finance roles can refund", async () => {
    const content = await bearer(new Types.ObjectId().toString(), "content");
    await request(app)
      .post(`/api/admin/orders/${new Types.ObjectId().toString()}/refund`)
      .set(content)
      .send({ reason: "nope" })
      .expect(403);
  });
});

describe("referrals", () => {
  it("rewards the referrer once, after the friend's first paid order", async () => {
    const referrer = await UserModel.create({ role: "student", email: "ref@example.com" });
    const refAuth = await bearer(referrer.id);
    const { body } = await request(app).get("/api/me/referral").set(refAuth).expect(200);
    expect(body.code).toMatch(/^[A-Z0-9]{8}$/);
    await request(app)
      .post("/api/me/referral/apply")
      .set(refAuth)
      .send({ code: body.code })
      .expect(400);

    await request(app)
      .post("/api/me/referral/apply")
      .set(student)
      .send({ code: body.code })
      .expect(204);
    await request(app)
      .post("/api/me/referral/apply")
      .set(student)
      .send({ code: body.code })
      .expect(409);

    for (let i = 0; i < 2; i++) {
      const order = await createOrder();
      await request(app)
        .post("/api/payments/fake/complete")
        .set(student)
        .send({ orderId: order.orderId, outcome: "success" })
        .expect(200);
    }
    const after = await request(app).get("/api/me/referral").set(refAuth).expect(200);
    expect(after.body.rewarded).toBe(1);
    expect(after.body.coupons).toHaveLength(1);
    expect(after.body.coupons[0]).toMatchObject({ kind: "percent", percent: 20 });

    // The credit coupon only works for the referrer.
    await request(app)
      .post("/api/orders/quote")
      .set(student)
      .send({ planId, couponCode: after.body.coupons[0].code })
      .expect(400);
    await request(app)
      .post("/api/orders/quote")
      .set(refAuth)
      .send({ planId, couponCode: after.body.coupons[0].code })
      .expect(200);
  });
});

describe("admin", () => {
  it("plans and coupons CRUD (audited), grants, orders list and revenue", async () => {
    const plan = await request(app)
      .post("/api/admin/plans")
      .set(admin)
      .send({ name: "All Pass", kind: "pass", pricePaise: 99900, validityDays: 180 })
      .expect(201);
    await request(app)
      .post("/api/admin/plans")
      .set(admin)
      .send({ name: "Bad", kind: "series", pricePaise: 99900, validityDays: 180 })
      .expect(400);
    await request(app)
      .put(`/api/admin/plans/${plan.body.id}`)
      .set(admin)
      .send({ name: "All Pass", kind: "pass", pricePaise: 89900, validityDays: 180 })
      .expect(200);
    const content = await bearer(new Types.ObjectId().toString(), "content");
    await request(app)
      .post("/api/admin/plans")
      .set(content)
      .send({ name: "X", kind: "pass", pricePaise: 100, validityDays: 1 })
      .expect(403);
    const publicPlans = await request(app).get("/api/plans").expect(200);
    expect(publicPlans.body.plans).toHaveLength(2);

    await request(app)
      .post("/api/admin/coupons")
      .set(admin)
      .send({ code: "diwali-50", kind: "flat", flatPaise: 5000, maxUses: 100 })
      .expect(201);
    await request(app)
      .post("/api/admin/coupons")
      .set(admin)
      .send({ code: "DIWALI-50", kind: "percent", percent: 10 })
      .expect(409);

    const grant = await request(app)
      .post("/api/admin/entitlements")
      .set(admin)
      .send({
        identifier: "BUYER@example.com",
        examKeys: ["sbi-po"],
        validityDays: 30,
        note: "Support ticket 42",
      })
      .expect(201);
    expect(grant.body.user.email).toBe("buyer@example.com");
    expect((await access()).examKeys).toEqual(["sbi-po"]);
    await request(app).delete(`/api/admin/entitlements/${grant.body.id}`).set(admin).expect(204);
    expect((await access()).examKeys).toEqual([]);

    const order = await createOrder({ planId, couponCode: "DIWALI-50" });
    await request(app)
      .post("/api/payments/fake/complete")
      .set(student)
      .send({ orderId: order.orderId, outcome: "success" })
      .expect(200);
    const list = await request(app).get("/api/admin/orders?q=buyer").set(admin).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.orders[0]).toMatchObject({ status: "paid", amountPaise: 44900 });
    expect(list.body.orders[0].invoiceNumber).toMatch(/^MP\//);

    const revenue = revenueReportSchema.parse(
      (await request(app).get("/api/admin/revenue").set(admin).expect(200)).body,
    );
    expect(revenue.totals).toMatchObject({ grossPaise: 44900, paidOrders: 1, netPaise: 44900 });
    expect(revenue.daily).toHaveLength(1);
    expect(revenue.coupons).toEqual([{ code: "DIWALI-50", orders: 1, discountPaise: 5000 }]);

    await request(app).delete(`/api/admin/plans/${planId}`).set(admin).expect(409);
  });
});

describe("payments off", () => {
  it("503 when no provider is configured (free orders still work)", async () => {
    app = buildTestApp({ paymentGateway: null, enqueueInvoice: () => Promise.resolve() });
    await request(app).post("/api/orders").set(student).send({ planId }).expect(503);
  });
});
