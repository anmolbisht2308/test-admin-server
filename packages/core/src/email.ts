import type { Logger } from "pino";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Files to attach (e.g. invoice PDFs). */
  attachments?: { name: string; content: Uint8Array }[];
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
      {
        to: message.to,
        subject: message.subject,
        attachments: message.attachments?.map((a) => a.name),
      },
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
        ...(message.attachments?.length
          ? {
              attachment: message.attachments.map((a) => ({
                name: a.name,
                content: Buffer.from(a.content).toString("base64"),
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Brevo responded ${res.status}: ${await res.text()}`);
  }
}

export interface EmailConfig {
  NODE_ENV: string;
  EMAIL_PROVIDER: "console" | "brevo";
  BREVO_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
  EMAIL_FROM_NAME: string;
}

export function createEmailSender(env: EmailConfig, logger: Logger): EmailSender {
  if (env.EMAIL_PROVIDER === "brevo" && env.BREVO_API_KEY && env.EMAIL_FROM) {
    return new BrevoEmailSender(env.BREVO_API_KEY, env.EMAIL_FROM, env.EMAIL_FROM_NAME);
  }
  if (env.NODE_ENV === "production") {
    logger.warn("EMAIL_PROVIDER=console in production: emails are only written to the log");
  }
  return new ConsoleEmailSender(logger);
}
