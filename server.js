
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

const PERSONALITY = `Você é Ema, uma IA feminina que fala português brasileiro.
Seja natural, espontânea, direta e breve. Normalmente use 1 a 3 frases.
Não invente informações nem diga que realizou ações que não executou.
Seu nome é Ema. Você é uma IA, não uma pessoa real.`;

app.get("/", (_, res) => res.send("Ema está funcionando!"));

app.post("/chat", async (req, res) => {
  const { message, sessionId = "default", image } = req.body;
  if (typeof message !== "string" || !message.trim() || message.length > 4000)
    return res.status(400).json({ error: "Mensagem inválida." });
  if (!GROQ) return res.status(500).json({ error: "GROQ_API_KEY ausente." });

  const id = /^[\w-]{1,80}$/.test(sessionId) ? sessionId : "default";
  let history = sessions.get(id) || [];
  const content = image
    ? [{ type: "text", text: message }, { type: "image_url", image_url: { url: image } }]
    : message;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: PERSONALITY }, ...history, { role: "user", content }],
        max_completion_tokens: 500
      })
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error?.message || "Erro Groq");

    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw Error("Resposta vazia.");

    sessions.set(id, [...history, { role: "user", content: message }, { role: "assistant", content: reply }].slice(-20));
    res.json({ reply });
  } catch (e) {
    console.error(e.message);
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
  if (!TOKEN || req.headers["x-vision-token"] !== TOKEN || !GEMINI)
    return client.close(1008);

  const gemini = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(GEMINI)}`
  );

  gemini.on("open", () => gemini.send(JSON.stringify({
    setup: {
      model: `models/${LIVE_MODEL}`,
      responseModalities: ["TEXT"],
      systemInstruction: { parts: [{ text: PERSONALITY + " Observe a tela e descreva o que está acontecendo." }] }
    }
  })));

  client.on("message", raw => {
    if (gemini.readyState !== WebSocket.OPEN) return;
    try {
      const p = JSON.parse(raw);
      if (p.type === "frame" && typeof p.data === "string")
        gemini.send(JSON.stringify({ realtimeInput: { video: { data: p.data, mimeType: "image/jpeg" } } }));
      if (p.type === "text" && typeof p.text === "string")
        gemini.send(JSON.stringify({ realtimeInput: { text: p.text } }));
    } catch {}
  });

  gemini.on("message", data => {
    if (client.readyState === WebSocket.OPEN) client.send(data.toString());
  });

  client.on("close", () => gemini.close());
  gemini.on("close", () => client.close());
  gemini.on("error", () => client.close());
});

server.listen(PORT, "0.0.0.0", () => console.log("Ema online!"));
