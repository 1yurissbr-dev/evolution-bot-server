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
let connectionCount = 0;

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

  if (!GROQ)
    return res.status(500).json({ error: "GROQ_API_KEY ausente." });

  const id = /^[\w-]{1,80}$/.test(sessionId) ? sessionId : "default";
  const history = sessions.get(id) || [];

  const content = image
    ? [
        { type: "text", text: message },
        { type: "image_url", image_url: { url: image } }
      ]
    : message;

  try {
    const r = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GROQ}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: personality },
            ...history,
            { role: "user", content }
          ],
          max_completion_tokens: 500
        })
      }
    );

    const data = await r.json();

    if (!r.ok)
      throw Error(data.error?.message || "Erro Groq");

    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply)
      throw Error("Resposta vazia.");

    sessions.set(id, [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: reply }
    ].slice(-20));

    res.json({ reply });

  } catch (e) {
    console.error("[GROQ] Erro:", e.message);
    res.status(502).json({ error: "Ema não conseguiu responder." });
  }
});

app.post("/reset", (req, res) => {
  sessions.delete(req.body.sessionId || "default");
  res.json({ success: true });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: "/vision"
});

wss.on("connection", (client) => {
  const id = ++connectionCount;
  const log = (...args) => console.log(`[VISION #${id}]`, ...args);

  log("Cliente conectado.");

  if (!TOKEN) {
    log("ERRO: VISION_ACCESS_TOKEN não configurado.");
    client.close(1008, "Token ausente");
    return;
  }

  if (!GEMINI) {
    log("ERRO: GEMINI_API_KEY não configurada.");
    client.close(1008, "Gemini ausente");
    return;
  }

  let ready = false;
  let setupTimer;

  const sendError = (message) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "error",
        message: String(message).slice(0, 1000)
      }));
    }
  };

  if (client.upgradeReq?.headers?.["x-vision-token"]) {
    // Compatibilidade com versões antigas do ws.
  }

  const gemini = new WebSocket(
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    "?key=" + encodeURIComponent(GEMINI)
  );

  gemini.on("unexpected-response", (request, response) => {
    let body = "";

    response.on("data", chunk => {
      if (body.length < 4000)
        body += chunk.toString();
    });

    response.on("end", () => {
      log("FALHA HTTP DO GEMINI:", response.statusCode);
      log("Resposta:", body || "(sem conteúdo)");
      sendError(
        "Gemini recusou a conexão. HTTP " + response.statusCode
      );

      if (client.readyState === WebSocket.OPEN)
        client.close(1011, "Falha HTTP Gemini");
    });
  });

  gemini.on("open", () => {
    log("Conexão com Gemini aberta.");

    gemini.send(JSON.stringify({
      setup: {
        model: `models/${LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ["TEXT"]
        },
        systemInstruction: {
          parts: [{
            text: personality +
              " Observe a tela enviada e explique o que está acontecendo quando solicitado."
          }]
        }
      }
    }));

    log("Configuração enviada. Aguardando setupComplete...");

    setupTimer = setTimeout(() => {
      if (!ready) {
        log("TIMEOUT: Gemini não enviou setupComplete.");
        sendError("Gemini demorou para concluir a configuração.");
        gemini.close();
      }
    }, 20000);
  });

  gemini.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      log("Mensagem inválida recebida do Gemini:", e.message);
      return;
    }

    if (data.setupComplete) {
      ready = true;
      clearTimeout(setupTimer);

      log("Gemini pronto!");

      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "ready" }));
      }

      return;
    }

    if (data.error) {
      const detail = JSON.stringify(data.error);

      log("ERRO RETORNADO PELO GEMINI:", detail);
      sendError(data.error.message || detail);
      return;
    }

    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "gemini",
        data
      }));
    }
  });

  client.on("message", raw => {
    if (!ready || gemini.readyState !== WebSocket.OPEN)
      return;

    try {
      const p = JSON.parse(raw.toString());

      if (p.type === "frame") {
        if (typeof p.data !== "string" ||
            p.data.length > 2 * 1024 * 1024) {
          log("Frame ignorado: formato ou tamanho inválido.");
          return;
        }

        gemini.send(JSON.stringify({
          realtimeInput: {
            video: {
              data: p.data,
              mimeType: "image/jpeg"
            }
          }
        }));
      }

      if (p.type === "text" && typeof p.text === "string") {
        gemini.send(JSON.stringify({
          realtimeInput: {
            text: p.text.slice(0, 2000)
          }
        }));
      }

    } catch (e) {
      log("Erro ao processar mensagem do app:", e.message);
    }
  });

  gemini.on("error", e => {
    log("ERRO DE CONEXÃO GEMINI:", e.message);
    sendError("Falha na conexão Gemini: " + e.message);
  });

  gemini.on("close", (code, reason) => {
    clearTimeout(setupTimer);

    const explanation = reason.toString() || "(sem motivo informado)";
    log("GEMINI FECHOU:", "Código:", code, "| Motivo:", explanation);

    if (client.readyState === WebSocket.OPEN) {
      sendError("Gemini fechou a conexão. Código: " + code +
        ". Motivo: " + explanation);
      client.close(1011, "Gemini desconectado");
    }
  });

  client.on("close", (code, reason) => {
    clearTimeout(setupTimer);
    log("APP DESCONECTOU:", "Código:", code,
      "| Motivo:", reason.toString() || "(sem motivo)");

    if (gemini.readyState === WebSocket.OPEN)
      gemini.close();
    else if (gemini.readyState === WebSocket.CONNECTING)
      gemini.terminate();
  });

  client.on("error", e => {
    log("ERRO NO WEBSOCKET DO APP:", e.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Ema online!");
  console.log("Modelo Gemini Live:", LIVE_MODEL);
});
