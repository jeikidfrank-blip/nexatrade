import webPush from "npm:web-push@3.6.7";
import { createServiceClient, jsonResponse } from "../_shared/megapay.ts";

function isSupportedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (host === "fcm.googleapis.com"
        || host.endsWith(".push.services.mozilla.com")
        || host === "web.push.apple.com"
        || host.endsWith(".push.apple.com"));
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
  }

  const expectedSecret = Deno.env.get("WITHDRAWAL_PUSH_WEBHOOK_SECRET") ?? "";
  if (!expectedSecret) {
    console.error("WITHDRAWAL_PUSH_WEBHOOK_SECRET is not configured.");
    return jsonResponse({ ok: false, error: "Push notifications are not configured." }, 500);
  }
  if (req.headers.get("x-webhook-secret") !== expectedSecret) {
    return jsonResponse({ ok: false, error: "Unauthorized." }, 401);
  }

  try {
    const payload = await req.json();
    const message = payload?.record;
    if (payload?.type !== "INSERT"
      || payload?.table !== "nexatrade_withdrawal_messages"
      || payload?.schema !== "public"
      || typeof message?.user_id !== "string"
      || typeof message?.id !== "string") {
      return jsonResponse({ ok: true, skipped: true });
    }

    const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
    const privateKey = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
    const subject = Deno.env.get("VAPID_SUBJECT") ?? "";
    if (!publicKey || !privateKey || !subject) {
      console.error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must be configured.");
      return jsonResponse({ ok: false, error: "Push notifications are not configured." }, 500);
    }

    const service = createServiceClient();
    const { data: subscriptions, error } = await service
      .from("nexatrade_push_subscriptions")
      .select("endpoint, subscription")
      .eq("user_id", message.user_id);
    if (error) throw error;

    if (!subscriptions?.length) {
      return jsonResponse({ ok: true, sent: 0 });
    }

    webPush.setVapidDetails(subject, publicKey, privateKey);
    const notification = JSON.stringify({
      title: "New MPESA message",
      body: String(message.body || "A withdrawal message has arrived.").slice(0, 180),
      tag: `withdrawal-${message.id}`,
      url: "./messages.html?thread=MPESA"
    });

    const results = await Promise.all(subscriptions.map(async (row) => {
      if (row.subscription?.endpoint !== row.endpoint || !isSupportedPushEndpoint(row.endpoint)) {
        console.error("Skipping unsupported Web Push endpoint.");
        return "skipped";
      }

      try {
        await webPush.sendNotification(row.subscription, notification);
        return "sent";
      } catch (sendError) {
        const statusCode = Number((sendError as { statusCode?: number })?.statusCode);
        if (statusCode === 404 || statusCode === 410) {
          const { error: deleteError } = await service
            .from("nexatrade_push_subscriptions")
            .delete()
            .eq("endpoint", row.endpoint);
          if (deleteError) console.error("Could not remove expired push subscription:", deleteError);
          return "skipped";
        }
        console.error("Could not deliver a withdrawal push notification:", sendError);
        return "failed";
      }
    }));

    const sent = results.filter((result) => result === "sent").length;
    const failures = results.filter((result) => result === "failed").length;
    if (failures) {
      return jsonResponse({ ok: false, sent, failures }, 502);
    }
    return jsonResponse({ ok: true, sent });
  } catch (error) {
    console.error("withdrawal-push error:", error);
    return jsonResponse({ ok: false, error: "Could not send withdrawal notifications." }, 500);
  }
});
