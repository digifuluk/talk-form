import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ─────────────────────────────────────────────────────────────
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected. Service role
// bypasses RLS (with the 0002 grants) so action_tokens + raw_messages writes
// succeed. Deploy with verify_jwt OFF — the bookmark mint (GET) and the
// form's fetch calls carry no JWT.
//
// ARCHITECTURE NOTE: Supabase rewrites GET text/html → text/plain, so this
// function serves NO rendered HTML. It is a JSON API. The form itself is a
// static file on FORM_BASE_URL (talks.digiful.io) that calls this API.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ACCOUNT_SID      = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const AUTH_TOKEN       = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const MSG_SERVICE_SID  = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID")!;
const WHATSAPP_FROM    = Deno.env.get("TWILIO_WHATSAPP_FROM")!; // whatsapp:+447886066914
const MINT_GATE        = Deno.env.get("SEND_FORM_TOKEN")!;      // DEMOTED: gates MINT only
const FORM_BASE_URL    = Deno.env.get("FORM_BASE_URL")!;        // e.g. https://talks.digiful.io  (NO trailing slash)

// ContentSids are NOT secret — safe to hardcode. V1 has one approved template.
const TEMPLATE_INTRO_SID = "HXe2566bed95576313e896282a047e9d2c"; // {{1}} = name

const TOKEN_TTL_HOURS   = 12;   // housekeeping expiry; single-use is the real gate
const SEND_LIMIT_PER_HR = 30;   // blast-radius cap on outbound sends
const MINT_LIMIT_PER_HR = 30;   // protects Resend quota / stops mint spam

// CORS: the single-use token is the real gate; CORS just lets the browser on
// FORM_BASE_URL read our JSON responses. Scoped to the form's origin.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": FORM_BASE_URL,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// ── Router ─────────────────────────────────────────────────────────────
// OPTIONS       → CORS preflight
// GET  (no t)   → MINT     : gate on SEND_FORM_TOKEN, mint token, email link (plain-text reply)
// GET  (t)      → VALIDATE : check token, return {ok, payload} JSON for the form to prefill
// POST          → SEND     : validate token, send via Twilio, burn token, log; JSON result
Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const t = url.searchParams.get("t");

    if (req.method === "OPTIONS")   return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET" && !t) return await handleMint(url);
    if (req.method === "GET" && t)  return await handleValidate(t);
    if (req.method === "POST")      return await handleSend(req, t);

    return json({ ok: false, message: "Method not supported." }, 405);
  } catch (err) {
    console.error("send-message error:", err);
    return json({ ok: false, message: "Server error — check logs." }, 500);
  }
});

// ── MINT (initiation path) ─────────────────────────────────────────────
// Hit by the Home Screen bookmark. Returns PLAIN TEXT (a one-line
// confirmation) — no HTML needed, so the Supabase text/plain rewrite is a
// non-issue here. The emailed link points at the static form on FORM_BASE_URL.
async function handleMint(url: URL): Promise<Response> {
  if (url.searchParams.get("k") !== MINT_GATE) return text("Not authorised.", 403);

  if (await countSince("action_tokens", "created_at", { kind: "send_form" }) >= MINT_LIMIT_PER_HR) {
    return text("Mint rate limit reached — try again shortly.", 429);
  }
  const link = await mintToken({}); // empty payload → generic blank form
  if (!link) return text("Could not mint a link — check logs.", 500);

  const sent = await emailLink(link, "initiation");
  return text(sent
    ? "Send link emailed to you. Open it from your inbox to continue."
    : "Minted, but the email failed — check logs / Resend settings.");
}

// ── VALIDATE (form load) ───────────────────────────────────────────────
// The static form calls this on load to (a) confirm the token is live and
// (b) fetch prefill context. Does NOT burn the token. Returns 200 either way
// so the form can read the body cleanly; ok:false means the link is dead.
async function handleValidate(t: string): Promise<Response> {
  const tok = await validToken(t);
  if (!tok) return json({ ok: false, reason: "invalid" }, 200);
  const p = (tok.payload ?? {}) as Record<string, string>;
  return json({
    ok: true,
    payload: {
      mode: p.mode ?? null,
      reply_to: p.reply_to ?? null,
      channel: p.channel ?? null,
    },
  }, 200);
}

// ── SEND (form submit) ─────────────────────────────────────────────────
async function handleSend(req: Request, tFromUrl: string | null): Promise<Response> {
  const form = await req.formData();
  const t = tFromUrl ?? (form.get("t")?.toString() ?? "");

  const tok = await validToken(t);
  if (!tok) return json({ ok: false, message: "Link invalid, used, or expired. Mint a fresh one." }, 410);

  if (await countSince("raw_messages", "received_at", { direction: "outbound" }) >= SEND_LIMIT_PER_HR) {
    return json({ ok: false, message: "Send rate limit reached — try again in a bit." }, 429);
  }

  const mode      = (form.get("mode")?.toString() ?? "template").trim(); // template | freeform
  const toRaw     = (form.get("to")?.toString() ?? "").trim();           // +44...
  const name      = (form.get("name")?.toString() ?? "").trim();
  const bodyText  = (form.get("body")?.toString() ?? "").trim();
  const sendAtUtc = (form.get("send_at_utc")?.toString() ?? "").trim();  // already UTC (client-converted)

  if (!toRaw.startsWith("+")) {
    return json({ ok: false, message: "Recipient must be E.164, e.g. +447…" }, 400);
  }
  const to = `whatsapp:${toRaw}`;

  // Decision #4: MessagingServiceSid ALWAYS — one code path, no From/MG branch.
  const params = new URLSearchParams();
  params.set("To", to);
  params.set("MessagingServiceSid", MSG_SERVICE_SID);

  let logBody = "";
  if (mode === "template") {
    if (!name) return json({ ok: false, message: "Template needs a name for {{1}}." }, 400);
    params.set("ContentSid", TEMPLATE_INTRO_SID);
    params.set("ContentVariables", JSON.stringify({ "1": name }));
    logBody = `[template intro] name=${name}`;
  } else {
    if (!bodyText) return json({ ok: false, message: "Free-form needs a message body." }, 400);
    params.set("Body", bodyText);
    logBody = bodyText;
  }

  // Decision #3: local→UTC conversion happened in the browser; we only validate.
  let scheduled = false;
  if (sendAtUtc) {
    const when = new Date(sendAtUtc).getTime();
    if (isNaN(when)) return json({ ok: false, message: "Bad scheduled time." }, 400);
    const mins = (when - Date.now()) / 60000;
    if (mins < 15 || mins > 7 * 24 * 60) {
      return json({ ok: false, message: "Scheduled time must be 15 min–7 days ahead." }, 400);
    }
    params.set("ScheduleType", "fixed");
    params.set("SendAt", new Date(when).toISOString());
    scheduled = true;
  }

  // ── Send via Twilio REST ──
  const twRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );
  const twJson = await twRes.json().catch(() => ({} as Record<string, unknown>));

  if (!twRes.ok) {
    const code = (twJson as { code?: number }).code;
    const msg = (twJson as { message?: string }).message ?? "send failed";
    // 63016 = free-form outside the 24h window → send the template first.
    const hint = code === 63016 ? " (24h window closed — send the template first to reopen it.)" : "";
    return json({ ok: false, message: `Twilio error ${code ?? twRes.status}: ${msg}${hint}` }, 502);
  }

  // ── Success: burn token (single-use) then log outbound (Decision #2 + #5) ──
  await supabase.from("action_tokens")
    .update({ used: true, used_at: new Date().toISOString() })
    .eq("id", tok.id).eq("used", false);

  const channel = to.startsWith("whatsapp:") ? "whatsapp" : "sms";
  const sid = (twJson as { sid?: string }).sid ?? null;
  const status = (twJson as { status?: string }).status ?? "sent";

  const { error: logErr } = await supabase.from("raw_messages").insert({
    direction: "outbound",
    channel,
    from_number: WHATSAPP_FROM.replace(/^whatsapp:/, ""),
    to_number: toRaw,
    body: logBody,
    payload: {
      twilio_sid: sid,
      twilio_status: status,
      mode,
      scheduled,
      content_sid: mode === "template" ? TEMPLATE_INTRO_SID : null,
      send_at_utc: scheduled ? params.get("SendAt") : null,
    },
  });
  if (logErr) console.error("outbound log insert failed:", logErr);

  return json({
    ok: true,
    message: `${scheduled ? "Scheduled" : "Sent"} — status: ${status}\nSID: ${sid ?? "(none)"}`,
  });
}

// ── Token helpers ──────────────────────────────────────────────────────
async function mintToken(payload: Record<string, unknown>): Promise<string | null> {
  const token = randomToken();
  const expires_at = new Date(Date.now() + TOKEN_TTL_HOURS * 3600_000).toISOString();
  const { error } = await supabase.from("action_tokens").insert({
    kind: "send_form", token, payload, expires_at,
  });
  if (error) { console.error("mintToken insert failed:", error); return null; }
  // Link points at the STATIC FORM on FORM_BASE_URL, not this function.
  return `${FORM_BASE_URL}/?t=${token}`;
}

// deno-lint-ignore no-explicit-any
async function validToken(t: string): Promise<any | null> {
  if (!t) return null;
  const { data, error } = await supabase.from("action_tokens")
    .select("*").eq("token", t).eq("kind", "send_form").maybeSingle();
  if (error) { console.error("validToken query failed:", error); return null; }
  if (!data || data.used) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return data;
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Rate-limit counter. Fails OPEN (returns 0) if the count query errors — the
// limit is a backstop, not a hard gate, and shouldn't block a real send.
async function countSince(
  table: string, tsCol: string, eq: Record<string, string>,
): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  let q = supabase.from(table).select("*", { count: "exact", head: true }).gte(tsCol, since);
  for (const [k, v] of Object.entries(eq)) q = q.eq(k, v);
  const { count, error } = await q;
  if (error) { console.error("countSince failed:", error); return 0; }
  return count ?? 0;
}

// ── Resend email (link delivery) ───────────────────────────────────────
async function emailLink(link: string, kind: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("ALERT_EMAIL");
  if (!key || !to) { console.error("emailLink skipped: RESEND_API_KEY or ALERT_EMAIL not set"); return false; }

  const body = [
    `Talk Coordination — send link (${kind}):`,
    ``,
    link,
    ``,
    `Single use. Expires in ${TOKEN_TTL_HOURS} hours.`,
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Talk Coordination <onboarding@resend.dev>",
        to: [to], subject: "🔗 Talk Coordination — send link", text: body,
      }),
    });
    if (!res.ok) { console.error("emailLink failed:", res.status, await res.text()); return false; }
    return true;
  } catch (e) { console.error("emailLink threw:", e); return false; }
}

// ── Responses ──────────────────────────────────────────────────────────
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Plain text for the bookmark mint confirmation (top-level navigation, not a
// cross-origin fetch, so no CORS needed).
function text(msg: string, status = 200): Response {
  return new Response(msg, {
    status, headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
