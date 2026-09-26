export {
  BrevoEmailSender,
  ConsoleEmailSender,
  createEmailSender,
  type EmailMessage,
  type EmailSender,
} from "@mockprep/core";
import type { EmailMessage } from "@mockprep/core";

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
