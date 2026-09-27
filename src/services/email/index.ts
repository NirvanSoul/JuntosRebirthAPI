import { sendEmail, type EmailConfig, type EmailResult, type EmailSender } from "./provider";

export { verifyEmailConfig } from "./provider";
export type { EmailConfig, EmailConfigCheck, EmailResult } from "./provider";

/** Deep link que abre la app directamente en la pantalla de la invitación. */
function invitationLink(config: EmailConfig, token: string) {
  const base = config.appUrl?.replace(/\/$/, "") ?? "juntoss://";
  return base.includes("://") && !base.startsWith("http")
    ? `${base.replace(/\/$/, "")}/invitation?token=${token}`
    : `${base}/invitation?token=${token}`;
}

export async function sendSpaceInvitation(
  config: EmailConfig,
  invitation: { to: string; token: string; spaceName?: string },
  send: EmailSender = sendEmail,
): Promise<EmailResult> {
  const link = invitationLink(config, invitation.token);
  const space = invitation.spaceName ?? "un espacio";

  return send(config, {
    to: invitation.to,
    subject: "Te invitaron a un espacio de Juntoss",
    text: [
      `Te invitaron a ${space} en Juntoss.`,
      "",
      `Abre este enlace para aceptar la invitación: ${link}`,
      "",
      "Si no esperabas esta invitación, puedes ignorar este mensaje.",
    ].join("\n"),
  });
}

/**
 * Correo de un código de un solo uso. El código abre el asunto porque es lo
 * que muestra la notificación del teléfono: el usuario lo lee (o iOS lo
 * ofrece como autocompletado «Desde Mail») sin salir de la app.
 */
function otpMessage(
  to: string,
  otp: string,
  copy: { subject: string; intro: string; footer?: string },
) {
  const footer = copy.footer ?? "Si no lo pediste tú, ignora este mensaje.";
  return {
    to,
    subject: `${otp} ${copy.subject}`,
    text: [
      `${copy.intro}: ${otp}`,
      "",
      "Caduca en 10 minutos.",
      "",
      footer,
    ].join("\n"),
    html: [
      `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1a1a1a">`,
      `<p style="margin:0 0 16px;font-size:16px">${copy.intro}:</p>`,
      `<p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px">${otp}</p>`,
      `<p style="margin:0 0 24px;font-size:14px;color:#555">Caduca en 10 minutos.</p>`,
      `<p style="margin:0;font-size:12px;color:#888">${footer}</p>`,
      `</div>`,
    ].join(""),
  };
}

export async function sendVerificationOtp(
  config: EmailConfig,
  input: { to: string; otp: string },
  send: EmailSender = sendEmail,
): Promise<EmailResult> {
  return send(
    config,
    otpMessage(input.to, input.otp, {
      subject: "es tu código para confirmar tu correo en Juntoss",
      intro: "Tu código de verificación de Juntoss es",
    }),
  );
}

export async function sendPasswordResetOtp(
  config: EmailConfig,
  input: { to: string; otp: string },
  send: EmailSender = sendEmail,
): Promise<EmailResult> {
  return send(
    config,
    otpMessage(input.to, input.otp, {
      subject: "es tu código para restablecer tu contraseña de Juntoss",
      intro: "Tu código para restablecer la contraseña de Juntoss es",
      footer: "Si no pediste este cambio, ignora este mensaje: tu contraseña sigue intacta.",
    }),
  );
}

export async function sendSignInOtp(
  config: EmailConfig,
  input: { to: string; otp: string },
  send: EmailSender = sendEmail,
): Promise<EmailResult> {
  return send(
    config,
    otpMessage(input.to, input.otp, {
      subject: "es tu código de acceso a Juntoss",
      intro: "Tu código de acceso a Juntoss es",
    }),
  );
}
