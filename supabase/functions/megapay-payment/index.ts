import {
  corsHeaders,
  jsonResponse,
  requireUser,
  createServiceClient,
  normalizeMsisdn,
  isValidMsisdn,
  parseAmount,
  makeReference,
  initiateStkPush,
  extractTransactionRequestId,
  extractProviderMessage,
  isInitiationFailure,
} from "../_shared/megapay.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed. Use POST." }, 405);
  }

  try {
    const { user, error: authError } = await requireUser(req);
    if (!user) {
      return jsonResponse({ ok: false, error: authError || "Authentication required." }, 401);
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
    }

    const amount = parseAmount(body?.amount);
    if (amount == null) {
      return jsonResponse(
        { ok: false, error: "Enter a valid amount of at least KSh 100 with no more than two decimal places." },
        400,
      );
    }

    const msisdn = normalizeMsisdn(body?.msisdn);
    if (!isValidMsisdn(msisdn)) {
      return jsonResponse({ ok: false, error: "A valid M-Pesa phone number is required (e.g. 0712345678)." }, 400);
    }

    const email = body?.email != null && String(body.email).trim() !== ""
      ? String(body.email).trim()
      : (user.email ?? "");
    const requestedRef = body?.reference != null ? String(body.reference).trim() : "";
    const reference = requestedRef || makeReference("MP");

    const service = createServiceClient();

    // Save pending transaction before calling MegaPay (existing Supabase DB).
    // Unique reference prevents duplicate intent creation for the same request.
    const { data: deposit, error: insertError } = await service
      .from("megapay_deposits")
      .insert({
        user_id: user.id,
        amount,
        currency: "KES",
        msisdn,
        email: email || null,
        reference,
        status: "pending",
      })
      .select("id, reference, status")
      .single();

    if (insertError || !deposit) {
      // If client retried with same reference, return existing non-completed intent.
      if (insertError?.code === "23505" && requestedRef) {
        const { data: existing } = await service
          .from("megapay_deposits")
          .select("id, user_id, reference, status, transaction_request_id")
          .eq("reference", requestedRef)
          .maybeSingle();
        if (existing && existing.user_id === user.id && existing.status !== "completed") {
          return jsonResponse({
            ok: true,
            reference: existing.reference,
            transactionRequestId: existing.transaction_request_id,
            status: existing.status,
            instructions: "Payment request already exists. Check your phone or use status check.",
          });
        }
      }
      console.error("megapay_deposits insert error", insertError);
      return jsonResponse({ ok: false, error: "Could not create a pending payment record." }, 500);
    }

    const init = await initiateStkPush({ amount, msisdn, reference });// Initiate STK push using documented MegaPay API (secrets from env).

    const raw = init.raw ?? null;
    const transactionRequestId = extractTransactionRequestId(raw);
    const providerMessage = extractProviderMessage(raw);
    const initiationFailed = !init.ok || isInitiationFailure(raw);

    await service
      .from("megapay_deposits")
      .update({
        transaction_request_id: transactionRequestId,
        provider_response: raw,
        status: initiationFailed ? "failed" : "pending",
        provider_status: initiationFailed ? "initiation_failed" : "initiated",
      })
      .eq("id", deposit.id);

    if (initiationFailed) {
      return jsonResponse({
        ok: false,
        error: providerMessage || (init as any).error || "MegaPay could not initiate the STK push.",
        reference,
        transactionRequestId,
        raw,
      }, init.ok ? 400 : 502);
    }

    return jsonResponse({
      ok: true,
      reference,
      transactionRequestId,
      instructions: "STK push request sent. Check your phone to enter your PIN. Balance will be credited only after verified server-side confirmation (webhook/status).",
      message: providerMessage,
      raw,
    });
  } catch (err) {
    console.error("megapay-payment error", err);
    return jsonResponse({ ok: false, error: "Unexpected server error while initiating payment." }, 500);
  }
});
