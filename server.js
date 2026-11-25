
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
    memory: process.memoryUsage().rss,
    sessions: sessions.size
  });
});

app.post("/chat", async (req, res) => {
  const { message, sessionId = "default", image } = req.body;

  if (typeof message !== "string" || !message.trim() || message.length > 4000) {
    return res.status(400).json({ error: "Mensagem inválida." });
  }

  if (!GROQ) {
    return res.status(500).json({ error: "GROQ_API_KEY ausente." });
  }

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

    if (!r.ok) {
      throw Error(data.error?.message || "Erro Groq");
    }

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
  const id = req.body?.sessionId || "default";
  sessions.delete(id);
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
    log("Acesso negado: token ausente ou incorreto.");
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
  let setupTimer = null;
  let framesReceived = 0;
  let framesSent = 0;
  let bytesReceived = 0;
  let lastFrameAt = 0;
  let lastTranscript = "";

  const sendApp = data => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  };

  const sendError = message => {
    log("ERRO:", message);
    sendApp({
      type: "error",
      message: String(message).slice(0, 1000)
    });
  };

  const sendTranscript = text => {
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
    log("Conexão Gemini aberta. Enviando configuração...");

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
              ` Você está conectado à tela do usuário.
Observe as imagens recebidas continuamente.
Use o conteúdo visual para responder às perguntas sobre a tela.
Se não receber imagens, diga claramente que não está vendo a tela.
Responda em português brasileiro.`
          }]
        }
      }
    }));

    setupTimer = setTimeout(() => {
      if (!ready) {
        log("Tempo esgotado aguardando configuração Gemini.");
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
      log("Resposta Gemini inválida:", e.message);
      return;
    }

    if (data.setupComplete) {
      ready = true;
      clearTimeout(setupTimer);

      log("Gemini pronto para receber imagens.");
      sendApp({ type: "ready" });
      return;
    }

    if (data.error) {
      log("ERRO GEMINI:", JSON.stringify(data.error));
      sendError(data.error.message || "Erro Gemini");
      return;
    }

    const content = data.serverContent || {};

    // A transcrição fica dentro de serverContent.
    const transcription =
      content.outputTranscription ||
      data.outputTranscription;

    if (transcription?.text) {
      let text = transcription.text.trim();

      // Evita reenviar o mesmo texto acumulado.
      if (text.startsWith(lastTranscript)) {
        text = text.slice(lastTranscript.length);
      } else if (lastTranscript.startsWith(text)) {
        text = "";
      }

      if (text) {
        log("Texto recebido do Gemini:", text.slice(0, 150));
        sendTranscript(text);
      }

      lastTranscript = transcription.text;
    }

    // Alternativa caso o Gemini envie texto diretamente.
    const parts = content.modelTurn?.parts || [];

    for (const part of parts) {
      if (typeof part.text === "string" && part.text.trim()) {
        log("Texto direto recebido do Gemini.");
        sendTranscript(part.text);
      }
    }

    if (content.turnComplete) {
      lastTranscript = "";
      log("Resposta do Gemini concluída.");
    }
  });

  client.on("message", (raw, isBinary) => {
    if (isBinary) {
      log("Mensagem binária ignorada.");
      return;
    }

    let p;

    try {
      p = JSON.parse(raw.toString());
    } catch (e) {
      log("Mensagem inválida do aplicativo:", e.message);
      return;
    }

    if (!ready || gemini.readyState !== WebSocket.OPEN) {
      log("Mensagem recebida antes do Gemini ficar pronto.");
      return;
    }

    if (p.type === "frame") {
      if (typeof p.data !== "string" || !p.data.length) {
        log("Frame inválido recebido.");
        return;
      }

      if (p.data.length > 8 * 1024 * 1024) {
        log("Frame recusado: tamanho excessivo.");
        return;
      }

      try {
        const frame = {
          realtimeInput: {
            video: {
              mimeType: "image/jpeg",
              data: p.data
            }
          }
        };

        gemini.send(JSON.stringify(frame), err => {
          if (err) {
            log("Falha ao enviar imagem:", err.message);
            return;
          }

          framesSent++;

          if (framesSent === 1 || framesSent % 10 === 0) {
            log(
              "IMAGEM ENVIADA AO GEMINI:",
              framesSent,
              "| tamanho:",
              p.data.length
            );
          }
        });

        framesReceived++;
        bytesReceived += p.data.length;
        lastFrameAt = Date.now();

        if (framesReceived === 1 || framesReceived % 10 === 0) {
          log(
            "IMAGEM RECEBIDA DO ANDROID:",
            framesReceived,
            "| bytes acumulados:",
            bytesReceived
          );
        }
      } catch (e) {
        log("Erro processando imagem:", e.message);
      }

      return;
    }

    if (p.type === "text" && typeof p.text === "string") {
      const text = p.text.slice(0, 2000);

      log("Texto enviado ao Gemini:", text.slice(0, 150));

      gemini.send(JSON.stringify({
        realtimeInput: { text }
      }), err => {
        if (err) log("Falha enviando texto:", err.message);
      });

      return;
    }

    log("Tipo de mensagem desconhecido:", p.type);
  });

  const statsTimer = setInterval(() => {
    if (closed) return;

    if (ready) {
      const age = lastFrameAt
        ? Math.floor((Date.now() - lastFrameAt) / 1000)
        : null;

      log(
        "STATUS | imagens recebidas:",
        framesReceived,
        "| enviadas:",
        framesSent,
        "| última imagem há:",
        age === null ? "nenhuma" : age + "s"
      );
    }
  }, 15000);

  const cleanup = () => {
    if (closed) return;
    closed = true;

    clearTimeout(setupTimer);
    clearInterval(statsTimer);
  };

  gemini.on("error", e => {
    log("ERRO DE CONEXÃO GEMINI:", e.message);
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

  client.on("close", (code, reason) => {
    cleanup();

    log("APLICATIVO DESCONECTOU:", code, reason.toString());

    if (gemini.readyState === WebSocket.OPEN) {
      gemini.close();
    } else if (gemini.readyState === WebSocket.CONNECTING) {
      gemini.terminate();
    }
  });

  client.on("error", e => {
    log("ERRO DO APLICATIVO:", e.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("EMA ONLINE");
  console.log("Porta:", PORT);
  console.log("Groq:", MODEL);
  console.log("Gemini Live:", LIVE_MODEL);
  console.log("Chave Groq:", !!GROQ);
  console.log("Chave Gemini:", !!GEMINI);
  console.log("Token de visão:", !!TOKEN);
  console.log("WebSocket: /vision");
  console.log("================================");
});
    
