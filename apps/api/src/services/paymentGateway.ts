import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Env } from "../env.js";
import { HttpError } from "../lib/httpError.js";

/**
 * The payment provider behind an interface. Razorpay is called over its REST API with fetch
 * (Basic auth) — the official SDK would add a dependency for three calls. The fake gateway signs
 * exactly like Razorpay, so verify and the webhook run the same code in dev, tests and production.
 */
export interface PaymentGateway {
  readonly name: "razorpay" | "fake";
  /** Public key id for Checkout (safe to send to the browser). */
  readonly keyId: string;
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ id: string }>;
  /** Full refund of a captured payment. */
  refund(input: {
    paymentId: string;
    amountPaise: number;
    notes: Record<string, string>;
  }): Promise<{ id: string; status: "pending" | "processed" | "failed" }>;
  /** Checkout's success signature: HMAC-SHA256(order_id|payment_id, key secret). */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  /** Webhook signature: HMAC-SHA256(raw body, webhook secret). */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

const hmac = (secret: string, data: string | Buffer) =>
  createHmac("sha256", secret).update(data).digest("hex");

function safeEqualHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

abstract class SigningGateway {
  constructor(
    protected readonly keySecret: string,
    protected readonly webhookSecret: string,
  ) {}

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
    return safeEqualHex(hmac(this.keySecret, `${orderId}|${paymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string) {
    return safeEqualHex(hmac(this.webhookSecret, rawBody), signature);
  }
}

export class RazorpayGateway extends SigningGateway implements PaymentGateway {
  readonly name = "razorpay";
  constructor(
    readonly keyId: string,
    keySecret: string,
    webhookSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super(keySecret, webhookSecret);
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.razorpay.com/v1${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { description?: string };
    } & T;
    if (!res.ok) {
      throw new HttpError(502, "The payment provider refused the request", {
        status: res.status,
        description: json.error?.description,
      });
    }
    return json;
  }

  async createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }) {
    const order = await this.call<{ id: string }>("/orders", {
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.receipt,
      notes: input.notes,
      payment_capture: 1,
    });
    return { id: order.id };
  }

  async refund(input: { paymentId: string; amountPaise: number; notes: Record<string, string> }) {
    const refund = await this.call<{ id: string; status: "pending" | "processed" | "failed" }>(
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      { amount: input.amountPaise, speed: "normal", notes: input.notes },
    );
    return { id: refund.id, status: refund.status };
  }
}

/** Local stand-in: no network. Secrets are fixed test values (fake is refused in production). */
export class FakeGateway extends SigningGateway implements PaymentGateway {
  readonly name = "fake";
  readonly keyId = "rzp_test_fake";
  static readonly KEY_SECRET = "fake_key_secret";
  static readonly WEBHOOK_SECRET = "fake_webhook_secret";

  constructor() {
    super(FakeGateway.KEY_SECRET, FakeGateway.WEBHOOK_SECRET);
  }

  createOrder() {
    return Promise.resolve({ id: `order_fake${randomBytes(7).toString("hex")}` });
  }

  refund() {
    return Promise.resolve({
      id: `rfnd_fake${randomBytes(7).toString("hex")}`,
      status: "processed" as const,
    });
  }

  newPaymentId() {
    return `pay_fake${randomBytes(7).toString("hex")}`;
  }

  signPayment(orderId: string, paymentId: string) {
    return hmac(this.keySecret, `${orderId}|${paymentId}`);
  }

  signWebhook(rawBody: string | Buffer) {
    return hmac(this.webhookSecret, rawBody);
  }
}

export function createPaymentGateway(env: Env): PaymentGateway | null {
  if (env.PAYMENTS_PROVIDER === "razorpay") {
    return new RazorpayGateway(
      env.RAZORPAY_KEY_ID ?? "",
      env.RAZORPAY_KEY_SECRET ?? "",
      env.RAZORPAY_WEBHOOK_SECRET ?? "",
    );
  }
  if (env.PAYMENTS_PROVIDER === "fake") return new FakeGateway();
  return null;
}
