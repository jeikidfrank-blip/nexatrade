/* ============================================================================
   NexaTrade — payment provider adapter ("plugin slot")
   ----------------------------------------------------------------------------
   This file deliberately CANNOT move money. It gives you one place to register
   a payment provider later, without wiring a live gateway into the trading
   code today.

   What exists here:
     - a provider registry
     - a mock provider that always declines
     - a configurable Megapay adapter (sandbox/test-ready) for checkout testing
     - the exact contract a real adapter has to satisfy

   Loading publishes `window.NexaTradePayments`. The app can use it to start a
   checkout (redirect/instructions) but must NEVER credit a balance from the
   browser, a redirect, or a client-side "success" callback.

   ---------------------------------------------------------------------------
   CONTRACT — a provider is a plain object:

     id    string, unique
     label string, shown to the user
     mode  "mock" | "sandbox" | "live"

     describe()                        -> { id, label, mode }
     createCheckout({ amount, currency, reference, metadata })
                                       -> { ok: true, redirectUrl?, reference, instructions?, raw? }
                                        | { ok: false, error }
     verifyWebhook({ headers, body })  -> { ok: true, reference, amount } | { ok: false, error }

   Register one with:
     NexaTradePayments.register({
       id: "example", label: "Example Pay", mode: "sandbox",
       describe() { ... }, createCheckout() { ... }, verifyWebhook() { ... }
     });

   ---------------------------------------------------------------------------
   MEGAPAY (TEST/SANDBOX)
   Configure via `window.NEXATRADE_MEGAPAY_CONFIG` (or pass to
   `createMegapayProvider`). Because "Megapay" integrations vary by provider,
   the adapter is endpoint-driven:
     - checkoutUrl: your server/Megapay checkout endpoint to POST to
     - merchantId/publicKey: identifiers sent with the request (if required)
     - currency: defaults to "KES"
     - localTest: if true (or if checkoutUrl is missing), returns a local test
       checkout response so you can exercise the UI without an external call
     - callbackUrl/webhookUrl: informational values forwarded as metadata

   Real payment confirmation must be handled on a trusted server/webhook that
   verifies the provider event and credits the ledger idempotently.

   ---------------------------------------------------------------------------
   BEFORE ENABLING A REAL ADAPTER — all four, none optional:

   1. Credit only from a verified server-side webhook. A browser can claim any
      payment succeeded. Never credit a balance from a redirect back to the
      site, and never from a client-side "success" callback.

   2. Idempotency. Providers retry webhooks. Store the provider's event id and
      refuse to credit the same event twice.

   3. Ledger first. Record the deposit as pending, credit on the verified
      webhook, and reconcile against the provider's settlement report.

   4. Licensing and segregation. Holding customer deposits is regulated
      (CBK / CMA in Kenya). A venue that generates its own prices and never
      routes an order to a real market must not collect real deposits — the
      prices a customer trades against would not be real market prices.
   ========================================================================== */

(function (global) {
  "use strict";

  /** Every registered provider, keyed by id. */
  const providers = new Map();

  function createReference(prefix) {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return (prefix || "PAY") + "-" + stamp + "-" + rand;
  }

  /** Default provider: always refuses, so no deposit path opens by accident. */
  const mockProvider = {
    id: "mock",
    label: "Mock provider (always declines)",
    mode: "mock",
    describe() {
      return { id: this.id, label: this.label, mode: this.mode };
    },
    async createCheckout() {
      return { ok: false, error: "No payment provider is configured." };
    },
    async verifyWebhook() {
      return { ok: false, error: "No payment provider is configured." };
    },
  };

  providers.set(mockProvider.id, mockProvider);

  function assertProvider(provider) {
    if (!provider || typeof provider !== "object") {
      throw new TypeError("Provider must be an object.");
    }

    for (const key of ["id", "label", "mode"]) {
      if (typeof provider[key] !== "string" || !provider[key]) {
        throw new TypeError("Provider." + key + " must be a non-empty string.");
      }
    }

    if (!["mock", "sandbox", "live"].includes(provider.mode)) {
      throw new TypeError('Provider.mode must be "mock", "sandbox" or "live".');
    }

    if (typeof provider.createCheckout !== "function") {
      throw new TypeError("Provider.createCheckout must be a function.");
    }

    if (typeof provider.verifyWebhook !== "function") {
      throw new TypeError("Provider.verifyWebhook must be a function.");
    }
  }

  function createMegapayProvider(config) {
    const cfg = config || {};
    const mode = cfg.mode === "live" ? "live" : "sandbox";

    return {
      id: cfg.id || "megapay",
      label: cfg.label || "M-Pesa" + (mode === "sandbox" ? " (test)" : ""),
      mode: mode,

      describe() {
        return { id: this.id, label: this.label, mode: this.mode };
      },

      async createCheckout(options) {
        const opts = options || {};
        const amount = Number(opts.amount);
        const currency = String(opts.currency || cfg.currency || "KES").toUpperCase();
        const reference = String(opts.reference || createReference("MP"));
        const msisdn = opts.msisdn != null ? String(opts.msisdn).trim() : "";
        const email = opts.email != null ? String(opts.email).trim() : "";
        const localTest = cfg.localTest === true || !cfg.checkoutUrl;

        const payload = {
          amount: amount,
          currency: currency,
          reference: reference,
          msisdn: msisdn || null,
          email: email || null,
          merchantId: cfg.merchantId || null,
          publicKey: cfg.publicKey || null,
          callbackUrl: cfg.callbackUrl || null,
          webhookUrl: cfg.webhookUrl || null,
          metadata: opts.metadata || null,
        };

        if (localTest) {
          return {
            ok: true,
            localTest: true,
            reference: reference,
            transactionRequestId: "TX-" + reference,
            checkoutUrl: cfg.testCheckoutUrl || null,
            instructions:
              "M-Pesa STK push test. Reference: " + reference
              + (msisdn ? ", phone: " + msisdn : "")
              + ". No external request was sent. Set `checkoutUrl` in "
              + "`window.NEXATRADE_MEGAPAY_CONFIG` to your server endpoint that calls "
              + "https://megapay.co.ke/backend/v1/initiatestk with your secret api_key. "
              + "Balance must be credited only from a verified server-side webhook/callback.",
            payload: payload,
          };
        }

        try {
          const headers = { "Content-Type": "application/json" };
          if (cfg.publicKey) headers["X-Megapay-Public-Key"] = String(cfg.publicKey);
          if (cfg.merchantId) headers["X-Megapay-Merchant-Id"] = String(cfg.merchantId);
          // For Supabase Edge Functions or other authenticated server endpoints.
          if (opts && opts.accessToken) headers["Authorization"] = "Bearer " + String(opts.accessToken);
          const anonKey = opts && opts.apikey
            ? String(opts.apikey)
            : (global.NEXATRADE_SUPABASE_CONFIG && global.NEXATRADE_SUPABASE_CONFIG.publishableKey ? String(global.NEXATRADE_SUPABASE_CONFIG.publishableKey) : "");
          if (anonKey && !headers["apikey"]) headers["apikey"] = anonKey;

          const response = await fetch(String(cfg.checkoutUrl), {
            method: cfg.method || "POST",
            headers: headers,
            body: JSON.stringify(payload),
          });

          const raw = await response.json().catch(async function () {
            try { return { message: await response.text() }; } catch (_) { return null; }
          });

          if (!response.ok) {
            const message = (raw && (raw.error || raw.message || raw.ResponseDescription || raw.description))
              || ("M-Pesa request failed (" + response.status + ").");
            return { ok: false, error: String(message), raw: raw };
          }

          const failed = raw && (raw.success === false || raw.status === "failed" || raw.status === "error" || raw.errorCode || raw.error);
          if (failed) {
            const message = (raw && (raw.error || raw.message || raw.ResponseDescription || raw.description)) || "M-Pesa request was not successful.";
            return { ok: false, error: String(message), raw: raw };
          }

          const checkoutUrl = raw && (raw.checkoutUrl || raw.redirectUrl || raw.url || raw.payment_url || raw.authorization_url || null);
          const transactionRequestId = (raw && (raw.transaction_request_id || raw.transactionRequestId || raw.CheckoutRequestID || raw.checkoutRequestId || raw.MerchantRequestID || raw.requestId || raw.request_id || raw.id)) || null;
          const providerRef = (raw && (raw.reference || raw.transactionReference)) || transactionRequestId || reference;
          return {
            ok: true,
            localTest: false,
            reference: providerRef,
            transactionRequestId: transactionRequestId,
            checkoutUrl: checkoutUrl || null,
            instructions: checkoutUrl
              ? "STK/checkout request created. Complete payment; balance updates only after verified server-side webhook/callback confirmation."
              : "STK push request sent. Check your phone to enter your PIN and complete payment. Balance updates only after verified server-side webhook/callback confirmation.",
            raw: raw,
          };
        } catch (error) {
          return { ok: false, error: error && error.message ? error.message : "M-Pesa checkout request failed." };
        }
      },

      async checkStatus(options) {
        const opts = options || {};
        const transactionRequestId = String(opts.transactionRequestId || opts.transaction_request_id || opts.reference || "").trim();
        const email = opts.email != null ? String(opts.email).trim() : "";
        if (!transactionRequestId) {
          return { ok: false, error: "A transaction request ID is required to check status." };
        }

        const localTest = cfg.localTest === true || !cfg.statusUrl;
        if (localTest) {
          return {
            ok: true,
            localTest: true,
            transactionRequestId: transactionRequestId,
            status: "pending",
            message: "Status check: no request sent. Set `statusUrl` in `window.NEXATRADE_MEGAPAY_CONFIG` to your server endpoint that calls https://megapay.co.ke/backend/v1/transactionstatus with your secret api_key.",
          };
        }

        try {
          const headers = { "Content-Type": "application/json" };
          if (opts && opts.accessToken) headers["Authorization"] = "Bearer " + String(opts.accessToken);
          const anonKey = opts && opts.apikey
            ? String(opts.apikey)
            : (global.NEXATRADE_SUPABASE_CONFIG && global.NEXATRADE_SUPABASE_CONFIG.publishableKey ? String(global.NEXATRADE_SUPABASE_CONFIG.publishableKey) : "");
          if (anonKey) headers["apikey"] = anonKey;

          const response = await fetch(String(cfg.statusUrl), {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ action: "status", transaction_request_id: transactionRequestId, email: email || null, reference: opts.reference || null }),
          });

          const raw = await response.json().catch(async function () {
            try { return { message: await response.text() }; } catch (_) { return null; }
          });

          if (!response.ok) {
            const message = (raw && (raw.error || raw.message || raw.ResponseDescription || raw.description))
              || ("M-Pesa status request failed (" + response.status + ").");
            return { ok: false, error: String(message), raw: raw };
          }

          return { ok: true, localTest: false, transactionRequestId: transactionRequestId, raw: raw };
        } catch (error) {
          return { ok: false, error: error && error.message ? error.message : "M-Pesa status request failed." };
        }
      },

      async verifyWebhook(event) {
        // Webhook verification must run on a trusted server with the provider
        // secret/signature rules. The browser cannot safely verify or credit.
        return {
          ok: false,
          error: "Webhook verification must be performed on a trusted server. Do not credit deposits from the browser.",
          received: !!event,
        };
      },
    };
  }

  const api = {
    /** Register a provider. Returns the API for chaining. */
    register(provider) {
      assertProvider(provider);

      if (provider.mode === "live") {
        console.warn(
          "[payments] A LIVE provider was registered. Deposits must be credited "
          + "from a verified server-side webhook, never from the browser.",
        );
      }

      providers.set(provider.id, provider);
      return api;
    },

    unregister(id) {
      providers.delete(id);
      return api;
    },

    /** Describe every registered provider. */
    list() {
      return [...providers.values()].map(function (provider) { return provider.describe(); });
    },

    get(id) {
      return providers.get(id) || null;
    },

    /** True when at least one real (non-mock) provider is registered. */
    get configured() {
      return Array.from(providers.keys()).some(function (id) { return id !== "mock"; });
    },

    /** Providers that can be offered in the UI (excludes the always-declining mock). */
    getDepositProviders() {
      return Array.from(providers.values())
        .filter(function (provider) { return provider.id !== "mock"; })
        .map(function (provider) { return provider.describe(); });
    },

    createReference: createReference,
    createMegapayProvider: createMegapayProvider,

    /** Start a checkout with a registered provider. Does not credit anything. */
    async createCheckout(id, options) {
      const provider = providers.get(id);
      if (!provider) return { ok: false, error: "Unknown provider: " + id };

      const amount = Number(options && options.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: "A positive amount is required." };
      }

      return provider.createCheckout(Object.assign({}, options, { amount: amount }));
    },

    /** Check payment/transaction status via the provider (if supported). Does not credit anything. */
    async checkStatus(id, options) {
      const provider = providers.get(id);
      if (!provider) return { ok: false, error: "Unknown provider: " + id };
      if (typeof provider.checkStatus !== "function") {
        return { ok: false, error: "This provider does not support status checks." };
      }
      return provider.checkStatus(options || {});
    },
  };

  global.NexaTradePayments = api;

  // Auto-register a Megapay adapter for testing. Configure with:
  // window.NEXATRADE_MEGAPAY_CONFIG = { checkoutUrl, merchantId, publicKey, currency, mode, localTest, callbackUrl, webhookUrl }
  // Define the config before loading payments.js, or call
  // NexaTradePayments.register(NexaTradePayments.createMegapayProvider({...})) after.
  try {
    const megapayConfig = global.NEXATRADE_MEGAPAY_CONFIG || { mode: "sandbox", localTest: true };
    api.register(api.createMegapayProvider(megapayConfig));
  } catch (error) {
    console.warn("[payments] Could not auto-register M-Pesa provider.", error);
  }
})(window);
