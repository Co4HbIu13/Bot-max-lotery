import db from "../db/database.js";
import { config } from "../config.js";
import { markPaid, NUMBER_STATUS } from "./lottery.js";

export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELED: "canceled",
};

/**
 * Create a payment record and return a payment URL (SBP link).
 * Supports YooKassa, CloudPayments, or a stub for local testing.
 */
export async function createPayment({ lotteryId, numberId, userId, amount, currency, description, successUrl }) {
  const provider = config.sbp.provider;
  const payment = {
    lottery_id: lotteryId,
    number_id: numberId,
    user_id: String(userId),
    provider,
    amount,
    currency: (currency || config.currency).toUpperCase(),
    description: description || `Lottery #${lotteryId} number booking`,
    status: PAYMENT_STATUS.PENDING,
  };

  const insert = db.prepare(
    `INSERT INTO payments (lottery_id, number_id, user_id, provider, amount, currency, description, status, sbp_url, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let sbpUrl = "";
  let metadata = {};

  if (provider === "yookassa") {
    const result = await createYooKassa(payment, successUrl);
    sbpUrl = result.sbpUrl;
    metadata = result.metadata;
  } else if (provider === "cloudpayments") {
    const result = await createCloudPayments(payment, successUrl);
    sbpUrl = result.sbpUrl;
    metadata = result.metadata;
  } else {
    // stub: local testing without a real provider
    sbpUrl = `${successUrl || "https://example.com/success"}?payment=stub_${Date.now()}`;
    metadata = { stub: true };
  }

  const result = insert.run(
    payment.lottery_id,
    payment.number_id,
    payment.user_id,
    payment.provider,
    payment.amount,
    payment.currency,
    payment.description,
    payment.status,
    sbpUrl,
    JSON.stringify(metadata)
  );

  return {
    id: result.lastInsertRowid,
    ...payment,
    sbpUrl,
    metadata,
  };
}

export function getPayment(id) {
  return db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id);
}

export function getPaymentByProviderId(providerPaymentId) {
  return db.prepare(
    `SELECT * FROM payments WHERE provider_payment_id = ?`
  ).get(providerPaymentId);
}

export function getPendingPaymentForUser(userId, lotteryId) {
  return db.prepare(
    `SELECT p.*, n.number, n.id as number_id
     FROM payments p
     JOIN numbers n ON n.id = p.number_id
     WHERE p.user_id = ? AND p.lottery_id = ? AND p.status = ?
     ORDER BY p.id DESC LIMIT 1`
  ).get(String(userId), lotteryId, PAYMENT_STATUS.PENDING);
}

export function updatePaymentStatus(paymentId, status, { providerPaymentId, metadata } = {}) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE payments SET status = ?, provider_payment_id = ?, metadata = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    status,
    providerPaymentId || null,
    metadata ? JSON.stringify(metadata) : null,
    now,
    paymentId
  );
}

/**
 * Handle successful payment confirmation from provider webhook.
 */
export function confirmPayment(providerPaymentId) {
  const payment = getPaymentByProviderId(providerPaymentId);
  if (!payment) return { ok: false, reason: "payment_not_found" };
  if (payment.status === PAYMENT_STATUS.SUCCEEDED) {
    return { ok: true, already: true, payment };
  }
  updatePaymentStatus(payment.id, PAYMENT_STATUS.SUCCEEDED, { providerPaymentId });
  markPaid(payment.number_id, { providerPaymentId });
  return { ok: true, payment: { ...payment, status: PAYMENT_STATUS.SUCCEEDED } };
}

/**
 * YooKassa integration (https://yookassa.ru/developers).
 * Creates a payment and returns the confirmation URL.
 */
async function createYooKassa(payment, successUrl) {
  const { shopId, apiKey, secret, baseUrl, apiUrl } = config.sbp;
  if (!shopId || !apiKey) {
    throw new Error("YooKassa credentials not configured (SBP_SHOP_ID, SBP_API_KEY)");
  }

  const idempotenceKey = `lottery_${payment.lottery_id}_${payment.number_id}_${Date.now()}`;
  const body = {
    amount: { value: String(payment.amount), currency: payment.currency },
    confirmation: { type: "redirect", return_url: successUrl || config.sbp.returnUrl },
    description: payment.description,
    metadata: { lottery_id: payment.lottery_id, number_id: payment.number_id },
  };

  const auth = Buffer.from(`${shopId}:${apiKey}`).toString("base64");
  const resp = await fetch(`${apiUrl}/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
      "Idempotence-Key": idempotenceKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`YooKassa error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const confirmation = data.confirmation || {};
  return {
    sbpUrl: confirmation.confirmation_url || "",
    metadata: {
      provider_payment_id: data.id,
      idempotence_key: idempotenceKey,
      status: data.status,
    },
  };
}

/**
 * CloudPayments integration (https://cloudpayments.ru).
 */
async function createCloudPayments(payment, successUrl) {
  const { shopId, apiKey, apiUrl } = config.sbp;
  if (!shopId || !apiKey) {
    throw new Error("CloudPayments credentials not configured (SBP_SHOP_ID, SBP_API_KEY)");
  }

  const body = {
    Amount: payment.amount,
    Currency: payment.currency,
    Description: payment.description,
    Metadata: { lottery_id: payment.lottery_id, number_id: payment.number_id },
    SuccessUrl: successUrl || config.sbp.returnUrl,
  };

  const auth = Buffer.from(`${shopId}:${apiKey}`).toString("base64");
  const resp = await fetch(`${apiUrl}/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`CloudPayments error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return {
    sbpUrl: data.url || "",
    metadata: {
      provider_payment_id: data.Id || data.id,
      status: data.Status,
    },
  };
}
