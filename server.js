
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "12mb" }));

const PORT = process.env.PORT || 3000;
const GROQ = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
const GEMINI = process.env.GEMINI_API_KEY;
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
const TOKEN = process.env.VISION_ACCESS_TOKEN;

const sessions = new Map();
const personality = `Você é Ema, uma IA feminina que fala português brasileiro.
Seja natural, direta e breve. Normalmente responda em 1 a 3 frases.
Não invente informações nem diga que realizou ações que não executou.`;

app.get("/", (_, res) => res.send("Ema está funcionando!"));

app.post("/chat", async (req, res) => {
  const { message, sessionId = "default", image } = req.body;

  if (typeof message !== "string" || !message.trim() || message.length > 4000)
    return res.status(400).json({ error: "Mensagem inválida." });

  if (image && (typeof image !== "string" ||
      image.length > 10 * 1024 * 1024 ||
      !/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)))
    return res.status(400).json({ error: "Imagem inválida." });

  if (!GROQ) return res.status(500).json({ error: "GROQ_API_KEY ausente." });

  const id = /^[\w-]{1,80}$/.test(sessionId) ? sessionId : "default";
  const history = sessions.get(id) || [];
  const content = image
    ? [{ type: "text", text: message }, { type: "image_url", image_url: { url: image } }]
    : message;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: personality }, ...history, { role: "user", content }],
        max_completion_tokens: 500
      })
    });

    const data = await r.json();
    if (!r.ok) throw Error(data.error?.message || "Erro Groq");

    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw Error("Resposta vazia.");

    sessions.set(id, [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: reply }
    ].slice(-20));

    res.json({ reply });
  } catch (e) {
    console.error("Groq:", e.message);
    res.status(502).json({ error: "Ema não conseguiu responder." });
  }
});

app.post("/reset", (req, res) => {
  sessions.delete(req.body.sessionId || "default");
  res.json({ success: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/vision" });

wss.on("connection", (client, req) => {
  if (!TOKEN || req.headers["x-vision-token"] !== TOKEN || !GEMINI) {
    client.close(1008, "Acesso negado");
    return;
  }

  const gemini = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(GEMINI)}`
  );

  let ready = false;

  gemini.on("open", () => {
    gemini.send(JSON.stringify({
      setup: {
        model: `models/${LIVE_MODEL}`,
        generationConfig: { responseModalities: ["TEXT"] },
        systemInstruction: {
          parts: [{ text: personality + " Observe a tela enviada e explique o que está acontecendo quando solicitado." }]
        }
      }
    }));
  });

  gemini.on("message", raw => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }

    if (data.setupComplete) {
      ready = true;
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify({ type: "ready" }));
      return;
    }

    if (data.error) {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify({ type: "error", message: data.error.message || "Erro Gemini" }));
      return;
    }

    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify({ type: "gemini", data }));
  });

  client.on("message", raw => {
    if (!ready || gemini.readyState !== WebSocket.OPEN) return;

    try {
      const p = JSON.parse(raw.toString());

      if (p.type === "frame" &&
          typeof p.data === "string" &&
          p.data.length <= 2 * 1024 * 1024) {
        gemini.send(JSON.stringify({
          realtimeInput: {
            video: { data: p.data, mimeType: "image/jpeg" }
          }
        }));
      }

      if (p.type === "text" && typeof p.text === "string") {
        gemini.send(JSON.stringify({
          realtimeInput: { text: p.text.slice(0, 2000) }
        }));
      }
    } catch {}
  });

  client.on("close", () => gemini.close());
  gemini.on("close", () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });
  gemini.on("error", e => {
    console.error("Gemini:", e.message);
    if (client.readyState === WebSocket.OPEN) client.close();
  });
});

server.listen(PORT, "0.0.0.0", () => console.log("Ema online!"));
