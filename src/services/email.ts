export type InvitationEmail = { to: string; token: string; spaceId: string };

export async function sendSpaceInvitation(apiKey: string | undefined, invitation: InvitationEmail) {
  if (!apiKey) return { delivered: false, reason: "not_configured" as const };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Juntoss <onboarding@resend.dev>",
      to: [invitation.to],
      subject: "Te invitaron a un espacio de Juntoss",
      text: `Abre Juntoss para aceptar la invitación. Código de invitación: ${invitation.token}`,
    }),
  });
  return { delivered: response.ok, reason: response.ok ? undefined : "provider_error" as const };
}
