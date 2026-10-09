import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { stripeRequest, verifyStripeSignature } from "@/lib/stripe";

export const runtime = "nodejs";

type StripeMetadata = Record<string, string | undefined>;

type StripeObject = {
  id?: string;
  type?: string;
  customer?: string | null;
  subscription?: string | null;
  client_reference_id?: string | null;
  metadata?: StripeMetadata;
  status?: string;
  current_period_end?: number | string | null;
  cancel_at_period_end?: boolean;
  data?: {
    object?: StripeObject;
  };
  [key: string]: unknown;
};

async function userIdForCustomer(customerId?: string | null) {
  if (!customerId) return null;
  const supabase = getAdminSupabase();
  const { data } = await supabase
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.user_id ?? null;
}

async function syncSubscription(subscription: StripeObject, fallbackUserId?: string | null) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : null;
  const userId =
    subscription.metadata?.user_id ??
    fallbackUserId ??
    (await userIdForCustomer(customerId));
  if (!userId) {
    console.warn("Stripe subscription has no matching user", subscription.id);
    return;
  }

  const status = String(subscription.status ?? "inactive");
  const plan = status === "active" || status === "trialing" ? "pro" : "free";
  // Since Stripe API 2025-03-31 (this app pins 2026-08-26.dahlia) the period end
  // lives on subscription items, not on the subscription itself.
  const items = subscription.items && typeof subscription.items === "object"
    ? (subscription.items as { data?: Array<{ current_period_end?: number | string | null }> }).data ?? []
    : [];
  const rawPeriodEnd = subscription.current_period_end
    ?? items.map((item) => Number(item.current_period_end)).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => b - a)[0]
    ?? null;
  const periodEnd = rawPeriodEnd
    ? new Date(Number(rawPeriodEnd) * 1000).toISOString()
    : null;

  const supabase = getAdminSupabase();
  const { error } = await supabase.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: customerId,
      plan,
      status,
      current_period_end: periodEnd,
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_subscription_id" },
  );
  if (error) throw error;

  if (customerId) {
    const { error: customerError } = await supabase.from("billing_customers").upsert(
      { user_id: userId, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (customerError) throw customerError;
  }
}

async function handleEvent(event: StripeObject) {
  const object = event.data?.object as StripeObject | undefined;
  if (!object) return;

  switch (event.type) {
    case "checkout.session.completed": {
      const userId = object.metadata?.user_id ?? object.client_reference_id;
      const customerId = typeof object.customer === "string" ? object.customer : null;
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
      const supabase = getAdminSupabase();

      if (userId && customerId) {
        const { error } = await supabase.from("billing_customers").upsert(
          { user_id: userId, stripe_customer_id: customerId, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        );
        if (error) throw error;
      }

      if (subscriptionId) {
        const subscription = await stripeRequest<StripeObject>(`subscriptions/${subscriptionId}`, { method: "GET" });
        await syncSubscription(subscription, userId);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // Webhooks can arrive out of order (an old "active" after "canceled").
      // Sync the current state from Stripe instead of the event snapshot; if
      // Stripe is unreachable the handler fails and Stripe retries the event.
      const current = object.id
        ? await stripeRequest<StripeObject>(`subscriptions/${encodeURIComponent(String(object.id))}`, { method: "GET" })
        : object;
      await syncSubscription({ ...current, metadata: current.metadata ?? object.metadata });
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const customerId = typeof object.customer === "string" ? object.customer : null;
      const userId = await userIdForCustomer(customerId);
      if (userId) {
        const supabase = getAdminSupabase();
        await supabase.from("usage_events").insert({
          user_id: userId,
          event_type: event.type === "invoice.paid" ? "billing_paid" : "billing_payment_failed",
          units: 1,
          metadata: { invoice_id: object.id, customer_id: customerId },
        });
      }
      break;
    }
    default:
      break;
  }
}

export async function POST(request: Request) {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !secret || !verifyStripeSignature(payload, signature, secret)) {
    return NextResponse.json({ error: "Invalid Stripe signature" }, { status: 400 });
  }

  try {
    const event = JSON.parse(payload) as StripeObject;
    const eventId = typeof event.id === "string" ? event.id : null;
    const eventType = typeof event.type === "string" ? event.type : null;

    if (!eventId || !eventType) {
      return NextResponse.json({ error: "Invalid Stripe event" }, { status: 400 });
    }

    const supabase = getAdminSupabase();
    const { data: inserted, error: insertError } = await supabase
      .from("stripe_webhook_events")
      .insert({
        event_id: eventId,
        event_type: eventType,
        status: "processing",
        payload: event,
      })
      .select("event_id")
      .maybeSingle();

    // A redelivery hits the event_id primary key (23505) rather than returning
    // no row; treat it as "already seen" so failed events can be retried.
    if (insertError && insertError.code !== "23505") throw insertError;

    if (!inserted) {
      const { data: existing, error: existingError } = await supabase
        .from("stripe_webhook_events")
        .select("status,received_at")
        .eq("event_id", eventId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing) throw new Error("Stripe webhook event row could not be loaded");

      if (existing.status === "processed") {
        return NextResponse.json({ received: true, reused: true });
      }

      const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
      if (existing.status === "processing") {
        const receivedAt = Date.parse(String(existing.received_at ?? ""));
        // A concurrent delivery must not execute a non-idempotent side effect
        // (for example, adding a billing usage event) while the first request
        // is still handling the same Stripe event.
        if (!Number.isFinite(receivedAt) || receivedAt >= Date.parse(staleBefore)) {
          return NextResponse.json({ received: true, inProgress: true });
        }
      }

      // Failed events may be retried immediately. Stale processing rows may be
      // reclaimed after five minutes. The status + timestamp filters are a
      // compare-and-swap so only one duplicate delivery can claim the event.
      let claim = supabase
        .from("stripe_webhook_events")
        .update({
          status: "processing",
          received_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("event_id", eventId);
      if (existing.status === "failed") {
        claim = claim.eq("status", "failed");
      } else if (existing.status === "processing") {
        claim = claim.eq("status", "processing").lt("received_at", staleBefore);
      } else {
        return NextResponse.json({ received: true, inProgress: true });
      }
      const { data: claimed, error: claimError } = await claim.select("event_id").maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) return NextResponse.json({ received: true, inProgress: true });
    }

    try {
      await handleEvent(event);
      const { error: markError } = await supabase
        .from("stripe_webhook_events")
        .update({
          status: "processed",
          processed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq("event_id", eventId);
      if (markError) throw markError;
      return NextResponse.json({ received: true });
    } catch (error) {
      await supabase
        .from("stripe_webhook_events")
        .update({
          status: "failed",
          error_message: error instanceof Error ? error.message : "Webhook processing failed",
        })
        .eq("event_id", eventId);
      throw error;
    }
  } catch (error) {
    console.error("stripe webhook error", error);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}
