import type { Logger } from "pino";
import type { Env } from "../env.js";

/** Delivers a login code to a phone. Implementations: console (dev), MSG91 (prod). */
export interface OtpSender {
  readonly name: string;
  send(phoneE164: string, code: string): Promise<void>;
}

export class ConsoleOtpSender implements OtpSender {
  readonly name = "console";
  constructor(private readonly logger: Logger) {}

  send(phoneE164: string, code: string) {
    this.logger.warn({ phone: phoneE164, otp: code }, `DEV OTP for ${phoneE164}: ${code}`);
    return Promise.resolve();
  }
}

/** MSG91 OTP via a DLT-approved Flow template containing the ##otp## variable. */
export class Msg91OtpSender implements OtpSender {
  readonly name = "msg91";
  constructor(
    private readonly authKey: string,
    private readonly templateId: string,
  ) {}

  async send(phoneE164: string, code: string) {
    const res = await fetch("https://control.msg91.com/api/v5/flow", {
      method: "POST",
      headers: {
        authkey: this.authKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        template_id: this.templateId,
        short_url: "0",
        recipients: [{ mobiles: phoneE164.replace(/^\+/, ""), otp: code }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`MSG91 responded ${res.status}: ${await res.text()}`);
  }
}

export function createOtpSender(env: Env, logger: Logger): OtpSender {
  if (env.OTP_PROVIDER === "msg91" && env.MSG91_AUTH_KEY && env.MSG91_TEMPLATE_ID) {
    return new Msg91OtpSender(env.MSG91_AUTH_KEY, env.MSG91_TEMPLATE_ID);
  }
  if (env.NODE_ENV === "production") {
    logger.warn("OTP_PROVIDER=console in production: codes are only written to the api log");
  }
  return new ConsoleOtpSender(logger);
}
