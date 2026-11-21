window.NEXATRADE_SUPABASE_CONFIG = {
  url: "https://itqcevznvmqpewksipvo.supabase.co",
  publishableKey: "sb_publishable_UjuUEr1lSX0G9CYhaehyXg_vMYwfMPv",
};

// Megapay payment integration (STK push) via Supabase Edge Functions.
// Secrets (MEGAPAY_API_KEY, MEGAPAY_EMAIL) are read in Edge Functions from
// Supabase secrets via Deno.env.get() - never put them in frontend code.
// - simulate: true = local UI test only (no external request, no DB pending record).
// - simulate: false = call megapay-payment Edge Function (creates pending deposit,
//   initiates STK push). Credit happens only after verified server-side webhook/status.
// After deploying the functions for project ref itqcevznvmqpewksipvo, set simulate: false.
window.NEXATRADE_MEGAPAY_CONFIG = {
  id: "megapay",
  label: "Megapay (STK push)",
  simulate: false,
  mode: "live",
  currency: "KES",
  // Supabase Edge Functions (deploy with CLI - see deployment instructions):
  checkoutUrl: "https://itqcevznvmqpewksipvo.supabase.co/functions/v1/megapay-payment",
  // statusUrl is used by the UI "Check payment status" button. The megapay-webhook
  // function also handles POST status checks when called with {transaction_request_id,email}.
  statusUrl: "https://itqcevznvmqpewksipvo.supabase.co/functions/v1/megapay-webhook",
  // Public callback URL to register with MegaPay (if required) - webhook verifies via transaction status API:
  webhookUrl: "https://itqcevznvmqpewksipvo.supabase.co/functions/v1/megapay-webhook",
  merchantId: "",
  publicKey: "",          // not required for this STK push
  callbackUrl: ""         // optional
};
