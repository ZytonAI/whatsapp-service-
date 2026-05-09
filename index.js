require("dotenv").config();

// ─── Handlers PRIMERO — antes de cualquier otro código ───────
process.on("uncaughtException", (err) => {
  console.error("[WA] uncaughtException — proceso sigue en pie:", err.message);
  status = "disconnected";
});

process.on("unhandledRejection", (reason) => {
  console.error("[WA] unhandledRejection:", reason);
});

const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NEXTJS_WEBHOOK_URL = process.env.NEXTJS_WEBHOOK_URL;
const NEXTJS_WEBHOOK_SECRET = process.env.NEXTJS_WEBHOOK_SECRET;

// Supabase en try/catch — si las credenciales son inválidas no crashea el proceso
let supabase = null;
try {
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      realtime: { transport: ws },
    });
    console.log("[WA] Supabase inicializado");
  } else {
    console.warn("[WA] ADVERTENCIA: Supabase no configurado (faltan env vars)");
  }
} catch (err) {
  console.error("[WA] Error inicializando Supabase:", err.message);
}

// Estado en memoria
let qrBase64 = null;
let status = "disconnected";
let connectedPhone = null;

// ─── Cliente WhatsApp ────────────────────────────────────────
const puppeteerConfig = {
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--safebrowsing-disable-auto-update",
  ],
};

if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./wa_session" }),
  puppeteer: puppeteerConfig,
});

client.on("qr", async (qr) => {
  status = "connecting";
  qrBase64 = await qrcode.toDataURL(qr);
  console.log("[WA] QR generado");
  await syncSessionStatus(null, "connecting", null);
});

client.on("ready", async () => {
  status = "connected";
  qrBase64 = null;
  const info = client.info;
  connectedPhone = info.wid.user;
  console.log(`[WA] Conectado como ${connectedPhone}`);
  await syncSessionStatus(null, "connected", connectedPhone);
});

client.on("disconnected", async (reason) => {
  status = "disconnected";
  qrBase64 = null;
  connectedPhone = null;
  console.log("[WA] Desconectado:", reason);
  await syncSessionStatus(null, "disconnected", null);
});

client.on("message", async (msg) => {
  if (msg.fromMe) return;
  console.log(`[WA] Mensaje de ${msg.from}: ${msg.body}`);

  let contactName = null;
  try {
    const contact = await msg.getContact();
    contactName = contact.pushname || contact.name || null;
  } catch {}

  const payload = {
    wa_chat_id: msg.from,
    contact_phone: msg.from.split("@")[0],
    contact_name: contactName,
    wa_message_id: msg.id._serialized,
    body: msg.body,
    direction: "inbound",
    timestamp: new Date(msg.timestamp * 1000).toISOString(),
  };

  if (NEXTJS_WEBHOOK_URL) {
    try {
      await fetch(NEXTJS_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": NEXTJS_WEBHOOK_SECRET || "",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("[WA] Error enviando webhook:", err.message);
    }
  }
});

// ─── Auth middleware ─────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers["x-bridge-token"];
  if (!BRIDGE_TOKEN || token !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── Sincronizar estado de sesión en Supabase ─────────────────
async function syncSessionStatus(ownerId, newStatus, phone) {
  if (!supabase) return;
  try {
    if (!ownerId) {
      await supabase
        .from("wa_sessions")
        .update({ status: newStatus, phone, updated_at: new Date().toISOString() })
        .neq("id", "00000000-0000-0000-0000-000000000000");
      return;
    }
    await supabase.from("wa_sessions").upsert(
      { owner_id: ownerId, status: newStatus, phone, updated_at: new Date().toISOString() },
      { onConflict: "owner_id" }
    );
  } catch (err) {
    console.error("[WA] Error sincronizando Supabase:", err.message);
  }
}

// ─── Routes ──────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "zyton-whatsapp-service", status });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/status", auth, (_req, res) => {
  res.json({ status, qr: qrBase64, phone: connectedPhone });
});

app.post("/reconnect", auth, async (_req, res) => {
  if (status === "connected") {
    return res.json({ message: "Ya está conectado" });
  }
  try {
    await client.initialize();
    res.json({ message: "Reconectando..." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/disconnect", auth, async (_req, res) => {
  // Actualizar estado inmediatamente para que los polls no vean "connected"
  status = "disconnected";
  qrBase64 = null;
  connectedPhone = null;
  syncSessionStatus(null, "disconnected", null).catch(() => {});

  try {
    await client.logout();
  } catch (err) {
    console.error("[WA] Error en logout:", err.message);
  }

  res.json({ message: "Desconectado" });

  // Reinicializar para generar nuevo QR
  setTimeout(async () => {
    try {
      await client.initialize();
    } catch (err) {
      console.error("[WA] Error reinicializando tras logout:", err.message);
    }
  }, 2000);
});

app.post("/send", auth, async (req, res) => {
  const { to, body } = req.body;

  if (!to || !body) {
    return res.status(400).json({ error: "Faltan campos: to, body" });
  }
  if (status !== "connected") {
    return res.status(503).json({ error: "WhatsApp no está conectado" });
  }

  try {
    const chatId = to.includes("@") ? to : `${to}@c.us`;
    const msg = await client.sendMessage(chatId, body);
    res.json({ ok: true, wa_message_id: msg.id._serialized });
  } catch (err) {
    console.error("[WA] Error enviando mensaje:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Arrancar servidor PRIMERO, luego inicializar WA ─────────
app.listen(PORT, () => {
  console.log(`[WA] Servicio corriendo en puerto ${PORT}`);

  client.initialize().catch((err) => {
    console.error("[WA] Error al inicializar cliente:", err.message);
    status = "disconnected";
  });
});
