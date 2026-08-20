import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected. Service role
// bypasses RLS (with the 0002 grants) so the insert succeeds.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Reply links point at the STATIC FORM on FORM_BASE_URL (talks.digiful.io),
// NOT at any Supabase URL. Single source of truth for the link base — a domain
// switch is one secret change, no code edit.
const FORM_BASE_URL = Deno.env.get("FORM_BASE_URL")!; // e.g. https://talks.digiful.io (no trailing slash)
const REPLY_TTL_HOURS = 12; // matches send-message; < WhatsApp's 24h free-form window

Deno.serve(async (req) => {
  try {
    const form = await req.formData();
    const payload: Record<string, string> = {};
    for (const [key, value] of form.entries()) payload[key] = value.toString();

    const rawFrom = payload["From"] ?? "";
    const rawTo = payload["To"] ?? "";
    const channel = rawFrom.startsWith("whatsapp:") ? "whatsapp" : "sms";
    const fromNumber = rawFrom.replace(/^whatsapp:/, "");
    const toNumber = rawTo.replace(/^whatsapp:/, "");
    const body = payload["Body"] ?? "";

    // STORE RAW FIRST (Handoff §15/§16)
    const { error } = await supabase.from("raw_messages").insert({
      direction: "inbound",
      channel,
      from_number: fromNumber,
      to_number: toNumber,
      body,
      payload,
    });

    if (error) console.error("raw_messages insert failed:", error);

    // ── Mint a single-use reply link (Track 1B). Best-effort — a failure here
    //    must never break the webhook, so it's fully caught and returns null.
    //    The token prefills the send-form to reply free-form to this sender
    //    (their inbound just opened the 24h window).
    const replyLink = await mintReplyToken(fromNumber, channel);

    // ── Self-alert: email on every inbound. Best-effort — awaited but fully
    //    caught, so a mail failure NEVER breaks the webhook. Carries store
    //    status (a failed insert surfaces here too) and the reply link.
    await sendAlert({ fromNumber, channel, body, storeOk: !error, storeErr: error?.message, replyLink });

    // Receive silently — no auto-reply. Real replies go out-of-band.
    return twiml("");

  } catch (err) {
    console.error("webhook error:", err);
    return twiml("");
  }
});

// ── Reply-token mint (Track 1B). Writes an action_tokens row and returns a
//    send-form link on FORM_BASE_URL, or null on any failure. Same token shape
//    send-message validates; payload prefills recipient + free-form mode.
async function mintReplyToken(fromNumber: string, channel: string): Promise<string | null> {
  try {
    const token = randomToken();
    const expires_at = new Date(Date.now() + REPLY_TTL_HOURS * 3600_000).toISOString();
    const { error } = await supabase.from("action_tokens").insert({
      kind: "send_form",
      token,
      payload: { mode: "freeform", reply_to: fromNumber, channel },
      expires_at,
    });
    if (error) { console.error("reply token mint failed:", error); return null; }
    return `${FORM_BASE_URL}/?t=${token}`;
  } catch (e) {
    console.error("reply token threw:", e);
    return null;
  }
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ── Resend alert. onboarding@resend.dev needs no domain verification;
//    ALERT_EMAIL must be your Resend account email.
async function sendAlert(a: {
  fromNumber: string; channel: string; body: string;
  storeOk: boolean; storeErr?: string; replyLink?: string | null;
}): Promise<void> {
  const key = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("ALERT_EMAIL");
  if (!key || !to) {
    console.error("alert skipped: RESEND_API_KEY or ALERT_EMAIL not set");
    return;
  }

  const lines = [
    `From:     ${a.fromNumber}`,
    `Channel:  ${a.channel}`,
    `Received: ${new Date().toISOString()}`,
    `Stored:   ${a.storeOk ? "yes" : "NO — " + (a.storeErr ?? "unknown")}`,
    ``,
    `Message:`,
    a.body || "(empty)",
  ];
  if (a.replyLink) {
    lines.push(``, `— Reply (free-form, single-use, ${REPLY_TTL_HOURS}h) —`, a.replyLink);
  }
  const text = lines.join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Talk Coordination <onboarding@resend.dev>",
        to: [to],
        subject: `📩 Inbound (${a.channel}) from ${a.fromNumber}`,
        text,
      }),
    });
    if (!res.ok) console.error("resend alert failed:", res.status, await res.text());
  } catch (e) {
    console.error("resend alert threw:", e);
  }
}

function twiml(message: string): Response {
  const inner = message ? `<Message>${escapeXml(message)}</Message>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
  return new Response(xml, { headers: { "Content-Type": "text/xml" } });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
