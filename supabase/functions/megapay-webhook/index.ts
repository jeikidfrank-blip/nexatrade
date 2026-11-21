
import {
  corsHeaders,
  jsonResponse,
  createServiceClient,
  getTransactionStatus,
  extractTransactionRequestId,
  extractReference,
  extractProviderMessage,
  interpretStatus,
} from "../_shared/megapay.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "megapay-webhook endpoint",
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({
      ok: false,
      error: "Method not allowed.",
    }, 405);
  }

  try {
    const requestText = await req.text();

    let payload: any = null;

    try {
      payload = requestText ? JSON.parse(requestText) : null;
    } catch {
      payload = null;
    }

    const url = new URL(req.url);

    const isManualStatusCheck =
      payload?.action === "status" ||
      url.searchParams.get("action") === "status";

    const transactionRequestId =
      extractTransactionRequestId(payload) ||
      extractTransactionRequestId(payload?.data) ||
      extractTransactionRequestId(payload?.Body?.stkCallback) ||
      url.searchParams.get("transaction_request_id") ||
      url.searchParams.get("transactionRequestId") ||
      url.searchParams.get("CheckoutRequestID");

    const reference =
      extractReference(payload) ||
      extractReference(payload?.data) ||
      extractReference(payload?.Body?.stkCallback) ||
      url.searchParams.get("reference");

    const service = createServiceClient();

    // Find the existing deposit using its transaction ID or reference.
    let deposit: any = null;

    if (transactionRequestId) {
      const { data, error } = await service
        .from("megapay_deposits")
        .select("*")
        .eq("transaction_request_id", transactionRequestId)
        .maybeSingle();

      if (error) throw error;

      deposit = data;
    }

    if (!deposit && reference) {
      const { data, error } = await service
        .from("megapay_deposits")
        .select("*")
        .eq("reference", reference)
        .maybeSingle();

      if (error) throw error;

      deposit = data;
    }

    if (!deposit) {
      console.warn("MegaPay deposit not found", {
        transactionRequestId,
        reference,
      });

      if (isManualStatusCheck) {
        return jsonResponse({
          ok: false,
          error: "Payment record not found.",
        }, 404);
      }

      return jsonResponse({
        ok: true,
        received: true,
        matched: false,
      });
    }

    // Never credit a deposit that has already been completed.
    if (deposit.status === "completed") {
      return jsonResponse({
        ok: true,
        verified: true,
        credited: false,
        already_credited: true,
        reference: deposit.reference,
        transactionRequestId: deposit.transaction_request_id,
      });
    }

    const txId =
      deposit.transaction_request_id || transactionRequestId;

    if (!txId) {
      const { error } = await service
        .from("megapay_deposits")
        .update({
          provider_response: payload,
          last_status_check_at: new Date().toISOString(),
        })
        .eq("id", deposit.id);

      if (error) throw error;

      return jsonResponse({
        ok: false,
        matched: true,
        verified: false,
        reason: "missing_transaction_request_id",
      }, 400);
    }

    // Verify directly with MegaPay.
    // The helper uses the MEGAPAY_EMAIL and MEGAPAY_API_KEY secrets.
    const statusRes = await getTransactionStatus({
      transaction_request_id: txId,
    });

    const statusRaw = statusRes.raw ?? null;
    const interpretation = interpretStatus(statusRaw);

    const providerStatus =
      extractProviderMessage(statusRaw) ||
      (statusRaw
        ? JSON.stringify(statusRaw).slice(0, 500)
        : null);

    // MegaPay status request failed. Do not credit.
    if (!statusRes.ok) {
      const { error } = await service
        .from("megapay_deposits")
        .update({
          status: deposit.status === "pending"
            ? "processing"
            : deposit.status,
          provider_status: "status_check_failed",
          status_response: statusRaw,
          last_status_check_at: new Date().toISOString(),
        })
        .eq("id", deposit.id);

      if (error) throw error;

      return jsonResponse({
        ok: false,
        matched: true,
        verified: false,
        error: "Could not verify transaction status with MegaPay.",
      }, 502);
    }

    // Only a confirmed successful payment can be credited.
    if (interpretation === "completed") {
      const { data: creditResult, error: creditError } =
        await service.rpc("megapay_credit_real_test_deposit", {
          p_reference: deposit.reference,
          p_transaction_request_id: txId,
          p_provider_status: providerStatus,
          p_status_response: statusRaw,
        });

      if (creditError) {
        console.error("MegaPay credit error:", creditError);

        return jsonResponse({
          ok: false,
          matched: true,
          verified: true,
          credited: false,
          error: "Payment verified but wallet crediting failed.",
        }, 500);
      }

      const alreadyCredited =
        !!(creditResult && creditResult.already_credited);

      return jsonResponse({
        ok: true,
        matched: true,
        verified: true,
        credited: !alreadyCredited,
        already_credited: alreadyCredited,
        status: "completed",
        reference: deposit.reference,
        transactionRequestId: txId,
        result: creditResult,
      });
    }

    // A confirmed failed payment must never be credited.
    if (interpretation === "failed") {
      const { error } = await service.rpc(
        "megapay_set_deposit_status",
        {
          p_reference: deposit.reference,
          p_status: "failed",
          p_transaction_request_id: txId,
          p_provider_status: providerStatus,
          p_status_response: statusRaw,
        },
      );

      if (error) {
        console.error("MegaPay failed-status update error:", error);
        throw error;
      }

      return jsonResponse({
        ok: true,
        matched: true,
        verified: true,
        credited: false,
        status: "failed",
        reference: deposit.reference,
        transactionRequestId: txId,
      });
    }

    // Pending or unknown status: record the response, but do not credit.
    const { error: updateError } = await service
      .from("megapay_deposits")
      .update({
        status: "processing",
        provider_status: providerStatus || "pending",
        status_response: statusRaw,
        transaction_request_id: txId,
        last_status_check_at: new Date().toISOString(),
      })
      .eq("id", deposit.id);

    if (updateError) throw updateError;

    return jsonResponse({
      ok: true,
      matched: true,
      verified: true,
      credited: false,
      status: interpretation || "pending",
      reference: deposit.reference,
      transactionRequestId: txId,
      message: "Payment is not confirmed as completed. No funds credited.",
    });

  } catch (err) {
    console.error("megapay-webhook error:", err);

    return jsonResponse({
      ok: false,
      error: "Processing error.",
    }, 500);
  }
});
