import db from "../db/database.js";
import { config } from "../config.js";

export const NUMBER_STATUS = {
  FREE: "free",
  BOOKED: "booked",
  PAID: "paid",
};

export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELED: "canceled",
};

export const LOTTERY_STATUS = {
  OPEN: "open",
  CLOSED: "closed",
};

/**
 * Create a new lottery in a chat with N numbers.
 * Returns the lottery object.
 */
export function createLottery(chatId, { totalNumbers, price, currency: currencyParam, messageId }) {
  const currency = (currencyParam || config.currency).toUpperCase();
  const total = Number(totalNumbers);
  const priceNum = Number(price);

  if (!Number.isInteger(total) || total <= 0 || total > 1000) {
    throw new Error("totalNumbers must be an integer between 1 and 1000");
  }
  if (!Number.isInteger(priceNum) || priceNum < 0) {
    throw new Error("price must be a non-negative integer (in smallest currency unit)");
  }

  const insert = db.prepare(
    `INSERT INTO lotteries (chat_id, message_id, total_numbers, price, currency, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const result = insert.run(chatId, messageId || null, total, priceNum, currency, LOTTERY_STATUS.OPEN);

  const lotteryId = result.lastInsertRowid;

  const insertNumber = db.prepare(
    `INSERT INTO numbers (lottery_id, number, status) VALUES (?, ?, ?)`
  );
  const insertMany = db.transaction((rows) => {
    for (const n of rows) {
      insertNumber.run(lotteryId, n, NUMBER_STATUS.FREE);
    }
  });
  insertMany(Array.from({ length: total }, (_, i) => i + 1));

  return getLottery(lotteryId);
}

export function getLottery(id) {
  return db.prepare(`SELECT * FROM lotteries WHERE id = ?`).get(id);
}

export function getActiveLottery(chatId) {
  return db.prepare(
    `SELECT * FROM lotteries WHERE chat_id = ? AND status = ? ORDER BY id DESC LIMIT 1`
  ).get(chatId, LOTTERY_STATUS.OPEN);
}

export function getLotteryByMessageId(chatId, messageId) {
  return db.prepare(
    `SELECT * FROM lotteries WHERE chat_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1`
  ).get(chatId, messageId);
}

export function closeLottery(id) {
  db.prepare(`UPDATE lotteries SET status = ? WHERE id = ?`).run(LOTTERY_STATUS.CLOSED, id);
}

/**
 * Free numbers available for booking.
 */
export function freeNumbers(lotteryId) {
  return db.prepare(
    `SELECT number FROM numbers WHERE lottery_id = ? AND status = ? ORDER BY number ASC`
  ).all(lotteryId, NUMBER_STATUS.FREE);
}

/**
 * Book a number for a user. Prevents double booking.
 * Returns the number row or throws if already taken.
 */
export function bookNumber(lotteryId, number, user) {
  const lottery = getLottery(lotteryId);
  if (!lottery) throw new Error("Lottery not found");
  if (lottery.status !== LOTTERY_STATUS.OPEN) throw new Error("Lottery is closed");

  const row = db.prepare(
    `SELECT * FROM numbers WHERE lottery_id = ? AND number = ?`
  ).get(lotteryId, number);

  if (!row) throw new Error("Number does not exist");
  if (row.status !== NUMBER_STATUS.FREE) throw new Error("Number already taken");

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE numbers SET status = ?, booked_by = ?, booked_by_name = ?, booked_at = ?
     WHERE id = ?`
  ).run(
    NUMBER_STATUS.BOOKED,
    String(user.user_id || user.userId || user.id),
    user.name || user.first_name || "Participant",
    now,
    row.id
  );

  return { ...row, status: NUMBER_STATUS.BOOKED, booked_by: String(user.user_id), booked_at: now };
}

/**
 * Mark a number as paid after successful SBP payment.
 */
export function markPaid(numberId, { providerPaymentId }) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE numbers SET status = ?, payment_id = ?, paid_at = ? WHERE id = ?`
  ).run(NUMBER_STATUS.PAID, providerPaymentId, now, numberId);
}

export function getNumberRow(numberId) {
  return db.prepare(`SELECT * FROM numbers WHERE id = ?`).get(numberId);
}

export function getNumberByLotteryAndNumber(lotteryId, number) {
  return db.prepare(
    `SELECT * FROM numbers WHERE lottery_id = ? AND number = ?`
  ).get(lotteryId, number);
}

/**
 * Summary of booked numbers for the chat table.
 */
export function bookedSummary(lotteryId) {
  return db.prepare(
    `SELECT number, booked_by, booked_by_name, status, paid_at
     FROM numbers WHERE lottery_id = ? AND status != ?
     ORDER BY number ASC`
  ).all(lotteryId, NUMBER_STATUS.FREE);
}

export function bookedCount(lotteryId) {
  const row = db.prepare(
    `SELECT COUNT(*) as c FROM numbers WHERE lottery_id = ? AND status != ?`
  ).get(lotteryId, NUMBER_STATUS.FREE);
  return row.c;
}

export function freeCount(lotteryId) {
  const row = db.prepare(
    `SELECT COUNT(*) as c FROM numbers WHERE lottery_id = ? AND status = ?`
  ).get(lotteryId, NUMBER_STATUS.FREE);
  return row.c;
}

export function paidCount(lotteryId) {
  const row = db.prepare(
    `SELECT COUNT(*) as c FROM numbers WHERE lottery_id = ? AND status = ?`
  ).get(lotteryId, NUMBER_STATUS.PAID);
  return row.c;
}
