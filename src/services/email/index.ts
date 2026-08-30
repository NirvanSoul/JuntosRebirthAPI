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

export async function sendVerificationOtp(
  config: EmailConfig,
  input: { to: string; otp: string },
  send: EmailSender = sendEmail,
): Promise<EmailResult> {
  return send(config, {
    to: input.to,
    subject: "Confirma tu correo en Juntoss",
    text: `Tu código de verificación es ${input.otp}. Caduca en 10 minutos.`,
  });
}

export async function sendPasswordResetOtp(
  config: EmailConfig,
  input: { to: string; otp: string },
  send: EmailSender = sendEmail,
): Promise<EmailResult> {
  return send(config, {
    to: input.to,
    subject: "Restablece tu contraseña de Juntoss",
    text: [
      `Tu código para restablecer la contraseña es ${input.otp}. Caduca en 10 minutos.`,
      "",
      "Si no pediste este cambio, ignora este mensaje: tu contraseña sigue intacta.",
    ].join("\n"),
  });
}

export async function sendSignInOtp(
  config: EmailConfig,
  input: { to: string; otp: string },
  send: EmailSender = sendEmail,
): Promise<EmailResult> {
  return send(config, {
    to: input.to,
    subject: "Tu código de acceso a Juntoss",
    text: `Tu código de acceso es ${input.otp}. Caduca en 10 minutos.`,
  });
}
