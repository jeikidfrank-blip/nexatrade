// Shared helpers for MegaPay Edge Functions.
// Uses only documented MegaPay endpoints/parameters provided:
// - POST https://megapay.co.ke/backend/v1/initiatestk
//   body: { api_key, email, amount, msisdn, reference }
// - POST https://megapay.co.ke/backend/v1/transactionstatus
//   body: { api_key, email, transaction_request_id }
// No undocumented parameters or signature verification are invented.

import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function getEnv(name: string): string {
  return Deno.env.get(name) ?? "";
}

export function getMegapayCredentials() {
  const api_key = getEnv("MEGAPAY_API_KEY");
  const email = getEnv("MEGAPAY_EMAIL");
  return { api_key, email };
}

export function createServiceClient() {
  const url = getEnv("SUPABASE_URL");
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  }
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

export function createUserClient(req: Request) {
  const url = getEnv("SUPABASE_URL");
  const anonKey = getEnv("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.");
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  return createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
}

export async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return { user: null, error: "Missing Authorization header." };
  const supabase = createUserClient(req);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return { user: null, error: "Authentication required." };
  return { user: data.user, error: null };
}

export function normalizeMsisdn(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10 && digits.startsWith("0")) return digits;
  if (digits.length === 9 && digits.startsWith("7")) return "0" + digits;
  if (digits.length === 12 && digits.startsWith("254")) return "0" + digits.slice(3);
  return digits;
}

export function isValidMsisdn(msisdn: string): boolean {
  return /^0\d{9}$/.test(msisdn);
}

export function parseAmount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isFinite(n)) return null;
  // Match existing real_test_deposit rules: >= 100 KSh, max 2 decimal places.
  if (n < 100) return null;
  if (Math.round(n * 100) !== n * 100) return null;
  return n;
}

export function makeReference(prefix = "MP"): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

async function postJson(url: string, payload: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let raw: any = null;
  try { raw = text ? JSON.parse(text) : null; } catch { raw = { raw_text: text }; }
  return { ok: res.ok, status: res.status, raw };
}

export async function initiateStkPush(params: {
  amount: number;
  msisdn: string;
  reference: string;
  email?: string;
}) {
  const { api_key, email: envEmail } = getMegapayCredentials();
  if (!api_key) return { ok: false, error: "MEGAPAY_API_KEY is not configured." as string, raw: null };
  const email = params.email || envEmail;
  // Documented parameters only.
  const payload = {
    api_key,
    email,
    amount: String(params.amount),
    msisdn: params.msisdn,
    reference: params.reference,
  };
  const result = await postJson("https://megapay.co.ke/backend/v1/initiatestk", payload);
  return result;
}

export async function getTransactionStatus(params: {
  transaction_request_id: string;
  email?: string;
}) {
  const { api_key, email: envEmail } = getMegapayCredentials();
  if (!api_key) return { ok: false, error: "MEGAPAY_API_KEY is not configured." as string, raw: null };
  const email = params.email || envEmail;
  // Documented parameters only.
  const payload = {
    api_key,
    email,
    transaction_request_id: params.transaction_request_id,
  };
  const result = await postJson("https://megapay.co.ke/backend/v1/transactionstatus", payload);
  return result;
}

export function extractTransactionRequestId(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw.transaction_request_id ?? raw.transactionRequestId ?? raw.CheckoutRequestID ?? raw.checkoutRequestId ?? raw.MerchantRequestID ?? raw.requestId ?? raw.request_id ?? raw.id;
  return v == null || String(v).trim() === "" ? null : String(v).trim();
}

export function extractReference(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw.reference ?? raw.AccountReference ?? raw.account_reference ?? raw.merchant_reference;
  return v == null || String(v).trim() === "" ? null : String(v).trim();
}

export function extractProviderMessage(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw.CustomerMessage ?? raw.ResponseDescription ?? raw.message ?? raw.description ?? raw.ResultDesc ?? raw.error;
  return v == null ? null : String(v);
}

// Best-effort interpretation for control flow. Final crediting decisions must be
// based on verified transaction status API responses.

export function interpretStatus(
  raw: any,
): "completed" | "failed" | "pending" | "unknown" {
  if (!raw || typeof raw !== "object") return "unknown";

  // MegaPay's transaction status response
  const status = String(
    raw.TransactionStatus ??
    raw.transactionStatus ??
    raw.transaction_status ??
    raw.payment_status ??
    raw.status ??
    raw.state ??
    ""
  ).toLowerCase();

  if (/(success|complete|completed|paid|confirmed)/.test(status)) {
    return "completed";
  }

  if (/(fail|cancel|expired|rejected|declined)/.test(status)) {
    return "failed";
  }

  if (/(pending|processing|initiated|queued)/.test(status)) {
    return "pending";
  }

  // TransactionCode represents the actual transaction result.
  const transactionCode = raw.TransactionCode ?? raw.transactionCode;

  if (transactionCode != null) {
    return String(transactionCode).trim() === "0"
      ? "completed"
      : "failed";
  }

  // ResultCode 200 means the status request was accepted,
  // NOT that the customer's payment failed.
  return "unknown";
}


export function isInitiationFailure(raw: any): boolean {
  if (!raw || typeof raw !== "object") return false;
  if (raw.success === false) return true;
  if (raw.ok === false) return true;
  const s = String(raw.status ?? raw.state ?? "").toLowerCase();
  if (s === "failed" || s === "error") return true;
  if (raw.error || raw.errorCode || raw.error_code) return true;
  return false;
}
