/* ============================================================================
   NexaTrade — payment provider adapter ("plugin slot")
   ----------------------------------------------------------------------------
   This file deliberately CANNOT move money. It gives you one place to register
   a payment provider later, without wiring a live gateway into the trading
   code today.

   What exists here:
     - a provider registry
     - a mock provider that always declines
     - the exact contract a real adapter has to satisfy

   Nothing in app.js calls this yet. Loading it only publishes the global
   `window.NexaTradePayments`; the deposit flow still uses real_test_deposit.

   ---------------------------------------------------------------------------
   CONTRACT — a provider is a plain object:

     id    string, unique
     label string, shown to the user
     mode  "mock" | "sandbox" | "live"

     describe()                        -> { id, label, mode }
     createCheckout({ amount, currency, reference })
                                       -> { ok: true, redirectUrl } | { ok: false, error }
     verifyWebhook({ headers, body })  -> { ok: true, reference, amount } | { ok: false, error }

   Register one with:
     NexaTradePayments.register({
       id: "example", label: "Example Pay", mode: "sandbox",
       describe() { ... }, createCheckout() { ... }, verifyWebhook() { ... }
     });

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
      return [...providers.values()].map((provider) => provider.describe());
    },

    get(id) {
      return providers.get(id) || null;
    },

    /** True when at least one real (non-mock) provider is registered. */
    get configured() {
      return [...providers.keys()].some((id) => id !== "mock");
    },

    /** Start a checkout with a registered provider. Does not credit anything. */
    async createCheckout(id, options) {
      const provider = providers.get(id);
      if (!provider) return { ok: false, error: "Unknown provider: " + id };

      const amount = Number(options && options.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: "A positive amount is required." };
      }

      return provider.createCheckout({ ...options, amount });
    },
  };

  global.NexaTradePayments = api;
})(window);
