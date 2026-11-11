export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
// ── 0. Автоматическая установка Webhook ──
    if (url.pathname === "/api/set-webhook" && request.method === "GET") {
      const webhookUrl = `https://${url.hostname}/api/webhook`;
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      const data = await res.json();
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }
    // ── 1. Валидация Telegram initData ──
    const validateInitData = async (initData, botToken) => {
      const params = new URLSearchParams(initData);
      const hash = params.get("hash");
      if (!hash) return null;
      params.delete("hash");
      const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
      const enc = new TextEncoder();
      const sk = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const secret = await crypto.subtle.sign("HMAC", sk, enc.encode(botToken));
      const vk = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", vk, enc.encode(sorted));
      const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
      if (hex !== hash) return null;
      return JSON.parse(params.get("user") || "{}");
    };

    // ── 2. Создать инвойс (Оплата Stars) ──
    if (url.pathname === "/api/create-invoice" && request.method === "POST") {
      try {
        const body = await request.json();
        const initData = request.headers.get("X-Telegram-Init-Data") || "";
        const user = await validateInitData(initData, env.BOT_TOKEN);
        if (!user || !user.id) return json({ error: "auth failed" }, 401, cors);

        const products = {
          boost: { title: "Зоряний Буст", desc: "+200💰 ×2 виробництво 60с", price: 50 }
        };
        const p = products[body.productId];
        if (!p) return json({ error: "no product" }, 400, cors);

        const inv = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createInvoiceLink`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: p.title,
            description: p.desc,
            payload: `${body.productId}:${user.id}:${Date.now()}`,
            provider_token: "",
            currency: "XTR",
            prices: [{ label: p.title, amount: p.price }]
          })
        });
        const data = await inv.json();
        if (!data.ok) return json({ error: data.description }, 500, cors);
        return json({ link: data.result }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    // ── 3. Сохранить прогресс ──
    if (url.pathname === "/api/save" && request.method === "POST") {
      try {
        const initData = request.headers.get("X-Telegram-Init-Data") || "";
        const user = await validateInitData(initData, env.BOT_TOKEN);
        if (!user || !user.id) return json({ error: "auth failed" }, 401, cors);

        const saveData = await request.json();
        await env.empire_DB.put(`user:${user.id}`, JSON.stringify(saveData));
        return json({ ok: true }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    // ── 4. Загрузить прогресс ──
    if (url.pathname === "/api/load" && request.method === "GET") {
      try {
        const initData = request.headers.get("X-Telegram-Init-Data") || "";
        const user = await validateInitData(initData, env.BOT_TOKEN);
        if (!user || !user.id) return json({ error: "auth failed" }, 401, cors);

        const saved = await env.empire_DB.get(`user:${user.id}`);
        if (!saved) return json({ found: false }, 200, cors);
        return json({ found: true, data: JSON.parse(saved) }, 200, cors);
      } catch (e) {
        return json({ error: e.message }, 500, cors);
      }
    }

    // ── 5. Webhook для Telegram (подтверждение оплаты) ──
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      const update = await request.json();

      if (update.pre_checkout_query) {
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerPreCheckoutQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
        });
      }

      if (update.message?.successful_payment) {
        const userId = update.message.from.id;
        // Записываем в базу, что юзер купил буст на 60 сек
        await env.empire_DB.put(`boost:${userId}`, String(Date.now() + 60000), { expirationTtl: 300 });
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: userId, text: "⭐ Буст активовано! Твій хутір процвітає 🌿" })
        });
      }

      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  }
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
