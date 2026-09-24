import express from "express";
import { config, assertConfig } from "./config.js";
import { MaxApiClient, buildKeyboardFromList } from "./services/maxapi.js";
import {
  createLottery,
  getLottery,
  getActiveLottery,
  getLotteryByMessageId,
  closeLottery,
  bookNumber,
  getNumberByLotteryAndNumber,
  freeNumbers,
  bookedSummary,
  bookedCount,
  freeCount,
  paidCount,
  NUMBER_STATUS,
  LOTTERY_STATUS,
} from "./services/lottery.js";
import {
  createPayment,
  getPendingPaymentForUser,
  confirmPayment,
  PAYMENT_STATUS,
} from "./services/payment.js";

assertConfig();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const api = new MaxApiClient(config.botToken);

// Store bot info for reference
let botInfo = null;

// ==================== HELPER FUNCTIONS ====================

function formatCurrency(amount, currency = config.currency) {
  return `${amount} ${currency}`;
}

function buildNumberKeyboard(lotteryId, freeNumbers, columns = 5) {
  const rows = [];
  for (let i = 0; i < freeNumbers.length; i += columns) {
    const row = freeNumbers.slice(i, i + columns).map((n) => ({
      text: String(n.number),
      callback_data: `book_${lotteryId}_${n.number}`,
    }));
    rows.push(row);
  }
  // Add control buttons
  rows.push([
    { text: "🔄 Обновить", callback_data: `refresh_${lotteryId}` },
    { text: "❌ Закрыть розыгрыш", callback_data: `close_${lotteryId}` },
  ]);
  return rows;
}

function buildLotteryMessage(lottery) {
  const booked = bookedCount(lottery.id);
  const free = freeCount(lottery.id);
  const paid = paidCount(lottery.id);
  const total = lottery.total_numbers;

  let text = `🎰 <b>Розыгрыш #${lottery.id}</b>\n\n`;
  text += `💰 Цена номера: ${formatCurrency(lottery.price)}\n`;
  text += `📊 Всего номеров: ${total}\n`;
  text += `✅ Забронировано: ${booked}\n`;
  text += `💎 Оплачено: ${paid}\n`;
  text += `🆓 Свободно: ${free}\n\n`;

  if (booked > 0) {
    text += "<b>Забронированные номера:</b>\n";
    const summary = bookedSummary(lottery.id);
    for (const item of summary) {
      const statusIcon = item.status === NUMBER_STATUS.PAID ? "💎" : "📝";
      text += `${statusIcon} №${item.number} — ${item.booked_by_name}\n`;
    }
  } else {
    text += "Пока никто не забронировал номера. Будь первым! 🎉";
  }

  return text;
}

// ==================== COMMAND HANDLERS ====================

async function handleStart(chatId, user) {
  const text = `Привет, ${user.name || user.first_name || "участник"}! 👋\n\n` +
    `Я бот для проведения розыгрышей в чатах Max.\n\n` +
    `<b>Команды:</b>\n` +
    `/lottery <количество> <цена> — создать розыгрыш (только админы)\n` +
    `/status — статус активного розыгрыша\n` +
    `/close — закрыть розыгрыш (только админы)\n` +
    `/help — помощь\n\n` +
    `Нажми на свободный номер в розыгрыше, чтобы забронировать его, затем оплати по СБП.`;

  await api.sendMessage(chatId, text, { parse_mode: "HTML" });
}

async function handleHelp(chatId) {
  const text = `<b>📖 Помощь по боту</b>\n\n` +
    `<b>Создание розыгрыша (админы):</b>\n` +
    `<code>/lottery 100 500</code> — 100 номеров по 500 руб.\n\n` +
    `<b>Участие:</b>\n` +
    `1. Нажми на свободный номер (кнопка под сообщением)\n` +
    `2. Подтверди бронь\n` +
    `3. Оплати по СБП (ссылка придёт в чат)\n` +
    `4. После оплаты номер становится твоим навсегда 💎\n\n` +
    `<b>Команды:</b>\n` +
    `/status — текущий розыгрыш\n` +
    `/close — закрыть розыгрыш (админы)\n` +
    `/my — мои номера`;

  await api.sendMessage(chatId, text, { parse_mode: "HTML" });
}

async function handleLotteryCommand(chatId, user, args) {
  // Check if user is admin (simplified - in real app check via Max API)
  // For now, allow anyone to create for testing
  if (args.length < 2) {
    await api.sendMessage(chatId, "Использование: <code>/lottery <количество> <цена></code>", { parse_mode: "HTML" });
    return;
  }

  const totalNumbers = parseInt(args[0], 10);
  const price = parseInt(args[1], 10);

  if (isNaN(totalNumbers) || isNaN(price) || totalNumbers <= 0 || price < 0) {
    await api.sendMessage(chatId, "Неверные параметры. Количество > 0, цена >= 0.");
    return;
  }

  // Check for existing active lottery
  const existing = getActiveLottery(chatId);
  if (existing) {
    await api.sendMessage(chatId, "В этом чате уже есть активный розыгрыш. Закройте его командой /close перед созданием нового.");
    return;
  }

  // Send initial message with keyboard
  const freeNumbers = Array.from({ length: totalNumbers }, (_, i) => ({ number: i + 1 }));
  const keyboard = buildNumberKeyboard(0, freeNumbers); // temporary lotteryId=0

  const sent = await api.sendKeyboard(chatId, "🎰 Создаю розыгрыш...", keyboard);

  // Create lottery in DB with message_id
  const lottery = createLottery(chatId, {
    totalNumbers,
    price,
    currency: config.currency,
    messageId: String(sent.message_id),
  });

  // Update message with real lottery ID and proper keyboard
  const realFreeNumbers = Array.from({ length: totalNumbers }, (_, i) => ({ number: i + 1 }));
  const realKeyboard = buildNumberKeyboard(lottery.id, realFreeNumbers);
  const messageText = buildLotteryMessage(lottery);

  await api.editMessage(sent.message_id, messageText, {
    keyboard: { type: "inline_keyboard", buttons: realKeyboard },
    parse_mode: "HTML",
  });
}

async function handleStatus(chatId) {
  const lottery = getActiveLottery(chatId);
  if (!lottery) {
    await api.sendMessage(chatId, "В этом чате нет активного розыгрыша. Создайте его командой /lottery");
    return;
  }

  const text = buildLotteryMessage(lottery);
  const freeNumbers = freeNumbers(lottery.id);
  const keyboard = buildNumberKeyboard(lottery.id, freeNumbers);

  await api.sendKeyboard(chatId, text, keyboard, { parse_mode: "HTML" });
}

async function handleClose(chatId, user) {
  const lottery = getActiveLottery(chatId);
  if (!lottery) {
    await api.sendMessage(chatId, "Нет активного розыгрыша для закрытия.");
    return;
  }

  closeLottery(lottery.id);
  await api.sendMessage(chatId, `✅ Розыгрыш #${lottery.id} закрыт. Больше нельзя бронировать номера.`);
}

async function handleMyNumbers(chatId, user) {
  const userId = String(user.user_id || user.userId || user.id);
  // This would need a DB query to get user's numbers across all lotteries
  await api.sendMessage(chatId, "Функция в разработке. Пока смотри активный розыгрыш через /status");
}

// ==================== CALLBACK QUERY HANDLERS ====================

async function handleCallbackQuery(update) {
  const { callback_query } = update;
  const { id: callbackId, data, message, from } = callback_query;
  const chatId = message.chat.chat_id;
  const messageId = message.message_id;
  const user = from;

  try {
    if (data.startsWith("book_")) {
      await handleBookNumber(callbackId, chatId, messageId, user, data);
    } else if (data.startsWith("pay_")) {
      await handlePayNumber(callbackId, chatId, messageId, user, data);
    } else if (data.startsWith("refresh_")) {
      await handleRefresh(callbackId, chatId, messageId, user, data);
    } else if (data.startsWith("close_")) {
      await handleCloseCallback(callbackId, chatId, messageId, user, data);
    } else {
      await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Неизвестное действие" });
    }
  } catch (error) {
    console.error("Callback error:", error);
    await api.post("/callbacks/answer", {
      callback_query_id: callbackId,
      text: `Ошибка: ${error.message}`,
      show_alert: true,
    });
  }
}

async function handleBookNumber(callbackId, chatId, messageId, user, data) {
  // data format: book_<lotteryId>_<number>
  const [, lotteryIdStr, numberStr] = data.split("_");
  const lotteryId = parseInt(lotteryIdStr, 10);
  const number = parseInt(numberStr, 10);

  const lottery = getLottery(lotteryId);
  if (!lottery) {
    await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Розыгрыш не найден", show_alert: true });
    return;
  }
  if (lottery.status !== LOTTERY_STATUS.OPEN) {
    await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Розыгрыш закрыт", show_alert: true });
    return;
  }

  const numberRow = getNumberByLotteryAndNumber(lotteryId, number);
  if (!numberRow || numberRow.status !== NUMBER_STATUS.FREE) {
    await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Номер уже занят", show_alert: true });
    return;
  }

  // Book the number
  bookNumber(lotteryId, number, user);

  // Check for existing pending payment
  const userId = String(user.user_id || user.userId || user.id);
  let pendingPayment = getPendingPaymentForUser(userId, lotteryId);

  if (!pendingPayment) {
    // Create new payment
    const successUrl = `${config.webhookUrl.replace("/webhook", "")}/sbp/return?lottery=${lotteryId}&number=${number}`;
    pendingPayment = await createPayment({
      lotteryId,
      numberId: numberRow.id,
      userId,
      amount: lottery.price,
      currency: lottery.currency,
      successUrl,
    });
  }

  // Send payment link
  const payKeyboard = [[
    { text: `💳 Оплатить ${formatCurrency(lottery.price)}`, url: pendingPayment.sbpUrl },
    { text: "✅ Я оплатил", callback_data: `pay_${lotteryId}_${number}` },
  ]];

  await api.sendKeyboard(chatId, `📝 Номер <b>№${number}</b> забронирован за тобой!\n\nОплати по СБП, чтобы закрепить за собой номер:`, payKeyboard, { parse_mode: "HTML" });

  // Update the main lottery message
  await refreshLotteryMessage(chatId, lotteryId);

  await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Номер забронирован! Оплати по ссылке выше." });
}

async function handlePayNumber(callbackId, chatId, messageId, user, data) {
  // data format: pay_<lotteryId>_<number>
  const [, lotteryIdStr, numberStr] = data.split("_");
  const lotteryId = parseInt(lotteryIdStr, 10);
  const number = parseInt(numberStr, 10);

  const userId = String(user.user_id || user.userId || user.id);
  const pendingPayment = getPendingPaymentForUser(userId, lotteryId);

  if (!pendingPayment) {
    await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Платёж не найден. Забронируй номер заново.", show_alert: true });
    return;
  }

  // In stub mode, simulate payment success
  if (config.sbp.provider === "stub") {
    confirmPayment(`stub_${pendingPayment.id}`);
    await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "✅ Оплата подтверждена (тестовый режим)!", show_alert: true });
    await refreshLotteryMessage(chatId, lotteryId);
    await api.sendMessage(chatId, `🎉 Поздравляем! Номер <b>№${number}</b> теперь твой навсегда! 💎`, { parse_mode: "HTML" });
    return;
  }

  // For real providers, just show the payment link again
  await api.post("/callbacks/answer", {
    callback_query_id: callbackId,
    text: "Перейди по ссылке выше для оплаты. После оплаты вернись и нажми «Я оплатил» снова.",
    show_alert: true,
  });
}

async function handleRefresh(callbackId, chatId, messageId, user, data) {
  const [, lotteryIdStr] = data.split("_");
  const lotteryId = parseInt(lotteryIdStr, 10);
  await refreshLotteryMessage(chatId, lotteryId);
  await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Обновлено" });
}

async function handleCloseCallback(callbackId, chatId, messageId, user, data) {
  const [, lotteryIdStr] = data.split("_");
  const lotteryId = parseInt(lotteryIdStr, 10);

  const lottery = getLottery(lotteryId);
  if (!lottery) {
    await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Розыгрыш не найден", show_alert: true });
    return;
  }

  closeLottery(lotteryId);
  await refreshLotteryMessage(chatId, lotteryId);
  await api.post("/callbacks/answer", { callback_query_id: callbackId, text: "Розыгрыш закрыт" });
}

async function refreshLotteryMessage(chatId, lotteryId) {
  const lottery = getLottery(lotteryId);
  if (!lottery || !lottery.message_id) return;

  const text = buildLotteryMessage(lottery);
  const freeNums = freeNumbers(lotteryId);
  const keyboard = buildNumberKeyboard(lotteryId, freeNums);

  try {
    await api.editMessage(lottery.message_id, text, {
      keyboard: { type: "inline_keyboard", buttons: keyboard },
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Failed to refresh lottery message:", error);
  }
}

// ==================== WEBHOOK HANDLERS ====================

// Max messenger webhook
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    console.log("Received update:", JSON.stringify(update, null, 2));

    if (update.message) {
      const { message } = update;
      const chatId = message.chat.chat_id;
      const user = message.from || {};
      const text = message.text || "";

      if (text.startsWith("/start")) {
        await handleStart(chatId, user);
      } else if (text.startsWith("/help")) {
        await handleHelp(chatId);
      } else if (text.startsWith("/lottery")) {
        const args = text.split(" ").slice(1);
        await handleLotteryCommand(chatId, user, args);
      } else if (text.startsWith("/status")) {
        await handleStatus(chatId);
      } else if (text.startsWith("/close")) {
        await handleClose(chatId, user);
      } else if (text.startsWith("/my")) {
        await handleMyNumbers(chatId, user);
      }
    } else if (update.callback_query) {
      await handleCallbackQuery(update);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Payment provider webhook (YooKassa / CloudPayments)
app.post("/sbp/webhook", async (req, res) => {
  try {
    const provider = config.sbp.provider;
    let providerPaymentId = null;

    if (provider === "yookassa") {
      // YooKassa sends event in body.object
      const event = req.body;
      if (event.event === "payment.succeeded") {
        providerPaymentId = event.object.id;
      }
    } else if (provider === "cloudpayments") {
      // CloudPayments sends data in body
      if (req.body.Status === "Completed" || req.body.Status === "Success") {
        providerPaymentId = String(req.body.Id || req.body.id);
      }
    }

    if (providerPaymentId) {
      const result = confirmPayment(providerPaymentId);
      if (result.ok && !result.already) {
        console.log(`Payment ${providerPaymentId} confirmed for lottery ${result.payment?.lottery_id}`);
        // Could notify user here via bot
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Payment webhook error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Payment return URL (user comes back after payment)
app.get("/sbp/return", async (req, res) => {
  const { lottery, number } = req.query;
  const text = `
    <html>
      <head><title>Оплата</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>✅ Спасибо за оплату!</h1>
        <p>Если оплата прошла успешно, номер <b>№${number}</b> в розыгрыше #${lottery} будет закреплён за вами.</p>
        <p>Вернитесь в чат Max и нажмите кнопку «Я оплатил» под сообщением с бронью.</p>
        <p><a href="https://max.ru" target="_blank">Открыть Max</a></p>
      </body>
    </html>
  `;
  res.send(text);
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, bot: botInfo?.username || "unknown" });
});

// ==================== STARTUP ====================

async function start() {
  try {
    // Try to get bot info (non-blocking)
    try {
      botInfo = await api.getMe();
      console.log("Bot info:", botInfo);
    } catch (apiError) {
      console.warn("Could not connect to Max API (using test token or offline):", apiError.message);
      botInfo = { username: "test_bot", id: "test" };
    }

    // Set webhook if URL configured
    if (config.webhookUrl) {
      // Note: Max API may have a setWebhook method, for now we assume webhook is set externally
      console.log(`Webhook should be set to: ${config.webhookUrl}`);
    }

    app.listen(config.port, config.host, () => {
      console.log(`🚀 Bot server running on http://${config.host}:${config.port}`);
      console.log(`📡 Webhook endpoint: ${config.webhookUrl || "not configured"}`);
      console.log(`💳 Payment webhook: ${config.webhookUrl?.replace("/webhook", "")}/sbp/webhook`);
      console.log(`🔗 Payment return: ${config.webhookUrl?.replace("/webhook", "")}/sbp/return`);
    });
  } catch (error) {
    console.error("Failed to start:", error);
    process.exit(1);
  }
}

start();