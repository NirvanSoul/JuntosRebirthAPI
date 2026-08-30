/**
 * Frontera con el proveedor de correo. Todo el dominio habla con
 * `sendEmail`, de modo que sustituir Resend no toca ninguna otra capa.
 */
export type EmailConfig = {
  apiKey?: string;
  /** Remitente verificado, p. ej. `Juntoss <hola@juntoss.app>`. */
  from?: string;
  /** Base para los enlaces profundos que abren la app. */
  appUrl?: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailResult = {
  delivered: boolean;
  reason?: "not_configured" | "provider_error";
};

export type EmailSender = (
  config: EmailConfig,
  message: EmailMessage,
) => Promise<EmailResult>;

export const sendEmail: EmailSender = async (config, message) => {
  // Sin remitente no se envía. Antes había uno de reserva codificado a fuego
  // (`onboarding@resend.dev`), que devuelve 200 pero solo entrega al dueño de
  // la cuenta de Resend: parecía funcionar y no llegaba a nadie.
  if (!config.apiKey || !config.from) return { delivered: false, reason: "not_configured" };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    return response.ok
      ? { delivered: true }
      : { delivered: false, reason: "provider_error" };
  } catch {
    // El correo nunca debe tumbar la operación que lo dispara: quien invita
    // ya tiene su invitación creada aunque el proveedor falle.
    return { delivered: false, reason: "provider_error" };
  }
};

export type EmailConfigCheck = {
  ok: boolean;
  /** Motivo por el que el correo no se entregaría, o `null` si todo está bien. */
  problem: string | null;
  /** Dominio del remitente configurado. Nunca la clave. */
  senderDomain: string | null;
  verifiedDomains: string[];
};

function senderDomain(from: string | undefined): string | null {
  if (!from) return null;
  const match = /<([^>]+)>/.exec(from) ?? [null, from];
  const address = (match[1] ?? "").trim();
  const domain = address.split("@")[1];
  return domain ? domain.toLowerCase() : null;
}

/**
 * Comprueba que el correo saldría realmente, **sin enviar nada**: pregunta a
 * Resend qué dominios tiene verificados y confirma que el remitente
 * configurado es uno de ellos.
 *
 * Existe porque el remitente de pruebas `onboarding@resend.dev` acepta la
 * petición y devuelve 200, pero solo entrega al dueño de la cuenta: sin esta
 * comprobación un despliegue parece sano y nadie recibe sus invitaciones.
 */
export async function verifyEmailConfig(
  config: EmailConfig,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<EmailConfigCheck> {
  const domain = senderDomain(config.from);
  if (!config.apiKey) {
    return { ok: false, problem: "RESEND_API_KEY is not set", senderDomain: domain, verifiedDomains: [] };
  }
  if (!domain) {
    return { ok: false, problem: "RESEND_FROM is not set", senderDomain: null, verifiedDomains: [] };
  }

  let verified: string[] = [];
  try {
    const response = await fetcher("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) {
      return {
        ok: false,
        problem: `Resend rejected the API key (${response.status})`,
        senderDomain: domain,
        verifiedDomains: [],
      };
    }
    const payload = (await response.json()) as { data?: { name?: string; status?: string }[] };
    verified = (payload.data ?? [])
      .filter((entry) => entry.status === "verified")
      .map((entry) => String(entry.name).toLowerCase());
  } catch {
    return { ok: false, problem: "Resend is unreachable", senderDomain: domain, verifiedDomains: [] };
  }

  if (domain === "resend.dev") {
    return {
      ok: false,
      problem: "RESEND_FROM uses the Resend sandbox, which only delivers to the account owner",
      senderDomain: domain,
      verifiedDomains: verified,
    };
  }
  if (!verified.includes(domain)) {
    return {
      ok: false,
      problem: `RESEND_FROM domain "${domain}" is not verified in Resend`,
      senderDomain: domain,
      verifiedDomains: verified,
    };
  }

  return { ok: true, problem: null, senderDomain: domain, verifiedDomains: verified };
}
