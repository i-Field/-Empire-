import { Bot, webhookCallback, InlineKeyboard } from "grammy";

// Инициализация бота (токен из секрета)
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// ── 1. Валидация initData (HMAC-SHA256) ─────────────────────────
async function validateInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
  const validationKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", validationKey, encoder.encode(dataCheckString));
  const hexSignature = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hexSignature === hash;
}

// ── 2. Создание инвойса (XTR) ───────────────────────────────────
async function createInvoiceLink(productId) {
  const products = {
    boost: { title: "Зоряний Буст", description: "+200💰 ×2 виробництво 60 сек", price: 50 }
  };
  const product = products[productId];
  if (!product) throw new Error("Product not found");

  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: product.title,
      description: product.description,
      payload: `${productId}:${Date.now()}`, // уникальный payload
      currency: "XTR",
      prices: [{ label: product.title, amount: product.price }],
      provider_token: "" // пустой для Stars[reference:4]
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
  return data.result; // ссылка для openInvoice
}

// ── 3. Обработка pre_checkout_query (обязательно) ──────────────
bot.on("pre_checkout_query", async (ctx) => {
  // Проверяем, что payload корректен и цена совпадает
  const payload = ctx.preCheckoutQuery.invoice_payload;
  if (!payload.startsWith("boost:")) {
    return ctx.answerPreCheckoutQuery(false, { error_message: "Невідомий товар" });
  }
  // Можно добавить проверку суммы: ctx.preCheckoutQuery.total_amount === 50
  await ctx.answerPreCheckoutQuery(true); // ответить нужно < 10 сек[reference:5]
});

// ── 4. Обработка успешного платежа ─────────────────────────────
bot.on("message:successful_payment", async (ctx) => {
  const payment = ctx.message.successful_payment;
  const userId = ctx.from.id;
  // Здесь можно записать в D1/Cloudflare KV, что пользователь купил буст
  // Например: await env.DB.prepare("UPDATE users SET boost_until = ? WHERE id = ?").bind(Date.now() + 60000, userId).run();
  await ctx.reply("⭐ Буст активовано! Твій хутір процвітає 🌿");
});

// ── 5. HTTP-обработчик Worker ──────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // Эндпоинт создания инвойса
    if (url.pathname === "/api/create-invoice" && request.method === "POST") {
      try {
        const { productId } = await request.json();
        const initData = request.headers.get("X-Telegram-Init-Data");
        if (!initData || !(await validateInitData(initData, env.TELEGRAM_BOT_TOKEN))) {
          return new Response(JSON.stringify({ error: "Invalid initData" }), { status: 401, headers: corsHeaders });
        }
        const link = await createInvoiceLink(productId);
        return new Response(JSON.stringify({ link }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Вебхук для Telegram
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      return webhookCallback(bot, "cloudflare-mod")(request, env, {});
    }

    return new Response("Not Found", { status: 404 });
  }
};
