import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  botToken: process.env.BOT_TOKEN || "",
  webhookUrl: process.env.WEBHOOK_URL || "",
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "0.0.0.0",
  sbp: {
    provider: process.env.SBP_PROVIDER || "stub",
    apiKey: process.env.SBP_API_KEY || "",
    shopId: process.env.SBP_SHOP_ID || "",
    secret: process.env.SBP_SECRET || "",
    baseUrl: process.env.SBP_BASE_URL || "https://api.yookassa.ru/v3",
    returnUrl: process.env.SBP_RETURN_URL || "",
  },
  currency: process.env.LOTTERY_CURRENCY || "RUB",
  dbPath: resolve(process.env.DB_PATH || "./data/lottery.db"),
  appUrl: resolve(__dirname, ".."),
};

export function assertConfig() {
  const missing = [];
  if (!config.botToken) missing.push("BOT_TOKEN");
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}
