import type { Logger } from "pino";
import type { Env } from "../env.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends transactional email. Implementations: console (dev), Brevo (free tier). SES later. */
export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export class ConsoleEmailSender implements EmailSender {
  readonly name = "console";
  constructor(private readonly logger: Logger) {}

  send(message: EmailMessage) {
    this.logger.warn(
      { to: message.to, subject: message.subject },
      `DEV EMAIL to ${message.to}: ${message.text}`,
    );
    return Promise.resolve();
  }
}

/** Brevo transactional email API (free plan: ~300 emails/day, verified sender address). */
export class BrevoEmailSender implements EmailSender {
  readonly name = "brevo";
  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string,
    private readonly fromName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage) {
    const res = await this.fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: this.fromEmail, name: this.fromName },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Brevo responded ${res.status}: ${await res.text()}`);
  }
}

export function createEmailSender(env: Env, logger: Logger): EmailSender {
  if (env.EMAIL_PROVIDER === "brevo" && env.BREVO_API_KEY && env.EMAIL_FROM) {
    return new BrevoEmailSender(env.BREVO_API_KEY, env.EMAIL_FROM, env.EMAIL_FROM_NAME);
  }
  if (env.NODE_ENV === "production") {
    logger.warn("EMAIL_PROVIDER=console in production: emails are only written to the api log");
  }
  return new ConsoleEmailSender(logger);
}

/** The sign-in code email. Plain, fast to load, readable in any mail app. */
export function otpEmail(code: string, ttlMinutes: number): Omit<EmailMessage, "to"> {
  return {
    subject: `${code} is your mockprep sign-in code`,
    text: `Your mockprep sign-in code is ${code}. It expires in ${ttlMinutes} minutes. If you didn't ask for it, ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5;color:#111">
<p>Your mockprep sign-in code is</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>
<p>It expires in ${ttlMinutes} minutes. If you didn't ask for it, ignore this email.</p>
</div>`,
  };
}
