
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

app.get("/", (_, res) => {
  res.json({
    status: "online",
    bot: "Ema",
    chat: !!GROQ,
    vision: !!GEMINI && !!TOKEN,
    model: LIVE_MODEL
  });
});

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    sessions: sessions.size
  });
});

app.post("/chat", async (req, res) => {
  const { message, sessionId = "default", image } = req.body;

  if (typeof message !== "string" || !message.trim() || message.length > 4000)
    return res.status(400).json({ error: "Mensagem inválida." });

  if (!GROQ)
    return res.status(500).json({ error: "GROQ_API_KEY ausente." });

  const id = typeof sessionId === "string" &&
    /^[\w-]{1,80}$/.test(sessionId) ? sessionId : "default";

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
    console.error("[GROQ]", e.message);
    res.status(502).json({ error: e.message });
  }
});

app.post("/reset", (req, res) => {
  sessions.delete(req.body?.sessionId || "default");
  res.json({ success: true });
});

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  path: "/vision",
  maxPayload: 12 * 1024 * 1024
});

wss.on("connection", (client, req) => {
  const id = ++connectionCount;
  const log = (...args) => console.log(`[VISION #${id}]`, ...args);

  log("Aplicativo conectado.");

  if (!TOKEN || req.headers["x-vision-token"] !== TOKEN) {
    log("Token inválido.");
    client.close(1008, "Token inválido");
    return;
  }

  if (!GEMINI) {
    log("GEMINI_API_KEY ausente.");
    client.close(1008, "Gemini ausente");
    return;
  }

  let ready = false;
  let closed = false;
  let busy = false;
  let setupTimer;
  let sendTimer;

  let latestFrame = null;
  let pendingPrompt =
    "Observe esta captura de tela e descreva o que está acontecendo. Responda em português brasileiro.";

  let lastSend = 0;
  let frameCount = 0;
  let sentCount = 0;
  let responseText = "";

  const MIN_INTERVAL = 6000;

  const sendApp = data => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  };

  const sendError = message => {
    log("ERRO:", message);
    sendApp({ type: "error", message: String(message).slice(0, 1000) });
  };

  const sendText = text => {
    if (!text || !text.trim()) return;

    sendApp({
      type: "gemini",
      data: {
        serverContent: {
          modelTurn: {
            parts: [{ text }]
          }
        }
      }
    });
  };

  const gemini = new WebSocket(
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    "?key=" + encodeURIComponent(GEMINI)
  );

  function pump() {
    if (closed || !ready || busy || !latestFrame) return;

    const wait = MIN_INTERVAL - (Date.now() - lastSend);

    if (wait > 0) {
      if (!sendTimer) {
        sendTimer = setTimeout(() => {
          sendTimer = null;
          pump();
        }, wait);
      }
      return;
    }

    const frame = latestFrame;
    latestFrame = null;

    busy = true;
    responseText = "";
    lastSend = Date.now();

    log("Solicitando análise visual:", ++sentCount);

    const request = {
      clientContent: {
        turns: [{
          role: "user",
          parts: [
            {
              text: pendingPrompt +
                "\nAnalise a imagem anexada. Diga o que realmente aparece nela. Não diga que não recebeu imagem se ela está anexada."
            },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: frame
              }
            }
          ]
        }],
        turnComplete: true
      }
    };

    gemini.send(JSON.stringify(request), error => {
      if (error) {
        busy = false;
        log("Falha ao enviar análise:", error.message);
        sendError("Não foi possível enviar a imagem ao Gemini.");
        pump();
      } else {
        log("Imagem e instrução enviadas como turno visual.");
      }
    });
  }

  gemini.on("unexpected-response", (request, response) => {
    let body = "";

    response.on("data", chunk => {
      if (body.length < 4000) body += chunk.toString();
    });

    response.on("end", () => {
      log("HTTP GEMINI:", response.statusCode, body);
      sendError("Erro HTTP Gemini: " + response.statusCode);
      client.close(1011, "Falha Gemini");
    });
  });

  gemini.on("open", () => {
    log("Gemini conectado. Configurando...");

    gemini.send(JSON.stringify({
      setup: {
        model: `models/${LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"]
        },
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [{
            text: personality +
              " Você recebe capturas de tela como imagens anexadas a mensagens. Analise visualmente cada imagem e responda com base no que realmente vê. Nunca afirme que não recebeu imagem quando recebeu uma. Não invente elementos da tela."
          }]
        }
      }
    }));

    setupTimer = setTimeout(() => {
      if (!ready) {
        log("Timeout na configuração.");
        sendError("Gemini não concluiu a configuração.");
        gemini.close();
      }
    }, 20000);
  });

  gemini.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      log("JSON inválido:", e.message);
      return;
    }

    if (data.setupComplete) {
      ready = true;
      clearTimeout(setupTimer);
      log("Gemini pronto para análises visuais.");
      sendApp({ type: "ready" });
      pump();
      return;
    }

    if (data.error) {
      log("ERRO GEMINI:", JSON.stringify(data.error));
      sendError(data.error.message || "Erro Gemini");
      busy = false;
      pump();
      return;
    }

    const content = data.serverContent || {};
    const transcription =
      content.outputTranscription || data.outputTranscription;

    if (transcription?.text) {
      const chunk = transcription.text;

      if (chunk.trim()) {
        responseText += chunk;
        log("Resposta visual:", chunk.slice(0, 150));
        sendText(chunk);
      }
    } else {
      const parts = content.modelTurn?.parts || [];

      for (const part of parts) {
        if (typeof part.text === "string" && part.text.trim()) {
          responseText += part.text;
          log("Texto do Gemini:", part.text.slice(0, 150));
          sendText(part.text);
        }
      }
    }

    if (content.turnComplete || content.generationComplete) {
      log(
        "Análise concluída.",
        responseText ? "Resposta recebida." : "Sem transcrição."
      );

      busy = false;
      pump();
    }
  });

  client.on("message", (raw, isBinary) => {
    if (isBinary) return;

    let p;

    try {
      p = JSON.parse(raw.toString());
    } catch (e) {
      log("Mensagem inválida do app:", e.message);
      return;
    }

    if (!ready || gemini.readyState !== WebSocket.OPEN) return;

    if (p.type === "frame") {
      if (typeof p.data !== "string" || !p.data.length) return;

      if (p.data.length > 8 * 1024 * 1024) {
        log("Imagem recusada: tamanho excessivo.");
        return;
      }

      latestFrame = p.data;
      frameCount++;

      if (frameCount === 1 || frameCount % 10 === 0) {
        log("Captura recebida:", frameCount);
      }

      pump();
      return;
    }

    if (p.type === "text" && typeof p.text === "string") {
      pendingPrompt = p.text.slice(0, 2000);

      log("Instrução atualizada:", pendingPrompt.slice(0, 150));

      pump();
    }
  });

  gemini.on("error", e => {
    log("ERRO GEMINI:", e.message);
    sendError("Falha Gemini: " + e.message);
  });

  gemini.on("close", (code, reason) => {
    cleanup();
    log("GEMINI DESCONECTOU:", code, reason.toString());

    if (client.readyState === WebSocket.OPEN) {
      sendError("Gemini desconectou: " + code);
      client.close(1011, "Gemini desconectado");
    }
  });

  function cleanup() {
    if (closed) return;
    closed = true;

    clearTimeout(setupTimer);
    clearTimeout(sendTimer);
  }

  client.on("close", (code, reason) => {
    cleanup();

    log("APP DESCONECTOU:", code, reason.toString());

    if (gemini.readyState === WebSocket.OPEN) {
      gemini.close();
    } else if (gemini.readyState === WebSocket.CONNECTING) {
      gemini.terminate();
    }
  });

  client.on("error", e => {
    log("ERRO APP:", e.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("EMA ONLINE");
  console.log("Groq:", MODEL);
  console.log("Gemini Live:", LIVE_MODEL);
  console.log("Groq configurado:", !!GROQ);
  console.log("Gemini configurado:", !!GEMINI);
  console.log("Token configurado:", !!TOKEN);
  console.log("Visão: /vision");
  console.log("================================");
});
