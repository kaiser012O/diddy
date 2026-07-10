// ─────────────────────────────────────────────────────────────────────────
// api/_lib/whatsapp.js
//
// Sends WhatsApp messages via Twilio's REST API.
//
// Required Vercel Environment Variables (Project Settings → Environment Variables):
//   TWILIO_ACCOUNT_SID       = (from Twilio Console homepage)
//   TWILIO_AUTH_TOKEN        = (from Twilio Console homepage)
//   TWILIO_WHATSAPP_NUMBER   = whatsapp:+14155238886   (Sandbox number while
//                              testing; replace with your own approved
//                              WhatsApp sender once you complete Twilio's
//                              WhatsApp Self Sign-up for production use)
//
// Uses plain fetch() against Twilio's REST API directly — no twilio npm
// package needed, keeping package.json unchanged.
// ─────────────────────────────────────────────────────────────────────────

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/**
 * Sends a WhatsApp message via Twilio.
 * @param {string} toPhone - recipient's phone number, any reasonable format
 *   (digits, spaces, dashes, with or without +). Normalized internally.
 * @param {string} body - the message text.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendWhatsAppMessage(toPhone, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error('[whatsapp] Twilio environment variables are not set — message not sent.');
    return { success: false, error: 'WhatsApp not configured' };
  }

  const normalizedTo = normalizePhoneForWhatsApp(toPhone);
  if (!normalizedTo) {
    console.error('[whatsapp] Invalid phone number, skipping send:', toPhone);
    return { success: false, error: 'Invalid phone number' };
  }

  const url = `${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const params = new URLSearchParams({
    From: fromNumber,
    To: `whatsapp:${normalizedTo}`,
    Body: body,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[whatsapp] Twilio API error:', errText);
      return { success: false, error: 'Twilio API error' };
    }

    return { success: true };
  } catch (err) {
    console.error('[whatsapp] Unexpected error sending message:', err);
    return { success: false, error: 'Unexpected error' };
  }
}

/**
 * Normalizes a phone number to E.164-ish format for WhatsApp (+countrycode...).
 * This is intentionally simple — it assumes numbers are already close to a
 * valid international format (as validated by PHONE_REGEX in booking-create.js).
 * Adjust the default country code below if most of your patients are in a
 * specific country and often type local numbers without a country code.
 */
function normalizePhoneForWhatsApp(phone) {
  if (!phone) return null;
  const digitsOnly = phone.replace(/[^\d+]/g, '');
  if (digitsOnly.startsWith('+')) return digitsOnly;
  if (digitsOnly.startsWith('00')) return `+${digitsOnly.slice(2)}`;
  // 🔧 EDIT HERE: default country code fallback for local numbers typed
  // without any prefix (e.g. "0555123456"). Change '+213' (Algeria) to
  // your own country's code if different.
  if (digitsOnly.startsWith('0')) return `+213${digitsOnly.slice(1)}`;
  return `+${digitsOnly}`;
}
