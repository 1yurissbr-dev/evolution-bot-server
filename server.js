
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
app.use(express.json({ limit: "12mb" }));

const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";

const VISION_ACCESS_TOKEN = process.env.VISION_ACCESS_TOKEN;

const sessions = new Map();
const MAX_IMAGE_CHARS = 10 * 1024 * 1024;

const PERSONALITY = `
Você é Ema, uma inteligência artificial feminina que conversa em português brasileiro.

PERSONALIDADE:
- Natural, espontânea, inteligente e bem-humorada.
- Tem personalidade própria.
- É direta, descontraída e pode usar palavrões leves quando combinar.
- Demonstra interesse pelo que o usuário está fazendo.

REGRA MAIS IMPORTANTE: SEJA BREVE.
- Normalmente responda em 1 a 3 frases.
- Não faça textões sem que o usuário peça.
- Não explique o óbvio nem repita informações.

COMPORTAMENTO:
- Lembre-se do contexto da conversa.
- Não invente informações.
- Admita quando não souber.
- Faça apenas uma pergunta por vez.
- Não diga que executou uma ação se não executou.
- Não afirme que pesquisou na internet sem ter ferramenta de pesquisa.
- Não afirme que clicou ou controlou o celular sem ter executado a ação.

VISÃO:
- Quando receber uma imagem, analise o que realmente aparece nela.
- Considere textos, botões, ícones e elementos visíveis.
- Se algo estiver ilegível ou escondido, diga isso.
- Não invente elementos que não aparecem na imagem.

IDENTIDADE:
Seu nome é Ema.
Você é uma assistente de IA, não uma pessoa real.
`;

app.get("/", (req, res) => {
  res.send("Ema está funcionando!");
});

app.get("/health", (req, res) => {
  res.json({
    online: true,
    chat: !!GROQ_API_KEY,
    vision: !!GEMINI_API_KEY
  });
});

// ==============================
// CHAT GROQ
// ==============================

app.post("/chat", async (req, res) => {
  const { message, sessionId, image } = req.body;

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      error: "Mensagem inválida."
    });
  }

  if (message.length > 4000) {
    return res.status(400).json({
      error: "Mensagem muito longa."
    });
  }

  if (image !== undefined) {
    if (
      typeof image !== "string" ||
      image.length > MAX_IMAGE_CHARS ||
      !/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)
    ) {
      return res.status(400).json({
        error: "Imagem inválida ou muito grande."
      });
    }
  }

  if (!GROQ_API_KEY) {
    return res.status(500).json({
      error: "GROQ_API_KEY não foi configurada."
    });
  }

  const id =
    typeof sessionId === "string" &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)
      ? sessionId
      : "default";

  const now = Date.now();

  for (const [key, value] of sessions) {
    if (now - value.updated > 3 * 60 * 60 * 1000) {
      sessions.delete(key);
    }
  }

  let session = sessions.get(id);

  if (!session) {
    session = {
      messages: [],
      updated: now
    };

    sessions.set(id, session);
  }

  const userContent = image
    ? [
        {
          type: "text",
          text: message.trim()
        },
        {
          type: "image_url",
          image_url: {
            url: image
          }
        }
      ]
    : message.trim();

  try {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      60000
    );

    let response;

    try {
      response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
              {
                role: "system",
                content: PERSONALITY
              },
              ...session.messages,
              {
                role: "user",
                content: userContent
              }
            ],
            max_completion_tokens: 500,
            temperature: 0.7
          }),
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "Erro Groq:",
        response.status,
        data.error?.message || "Erro desconhecido"
      );

      return res.status(502).json({
        error: "A Ema não conseguiu responder agora."
      });
    }

    const reply =
      data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return res.status(502).json({
        error: "A Ema não retornou uma resposta."
      });
    }

    session.messages.push({
      role: "user",
      content: message.trim()
    });

    session.messages.push({
      role: "assistant",
      content: reply
    });

    session.messages = session.messages.slice(-20);
    session.updated = Date.now();

    res.json({ reply });

  } catch (error) {
    console.error("Erro interno Groq:", error.message);

    res.status(500).json({
      error: "Erro de conexão com a Ema."
    });
  }
});

// ==============================
// VISÃO GEMINI LIVE
// ==============================

const visionServer = new WebSocketServer({
  noServer: true,
  maxPayload: 2 * 1024 * 1024
});

function validToken(received) {
  if (
    typeof received !== "string" ||
    !VISION_ACCESS_TOKEN
  ) {
    return false;
  }

  const a = Buffer.from(received);
  const b = Buffer.from(VISION_ACCESS_TOKEN);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(
    req.url,
    "http://localhost"
  ).pathname;

  if (pathname !== "/vision") {
    socket.destroy();
    return;
  }

  if (!validToken(req.headers["x-vision-token"])) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  visionServer.handleUpgrade(
    req,
    socket,
    head,
    (ws) => {
      visionServer.emit("connection", ws, req);
    }
  );
});

visionServer.on("connection", async (client) => {
  if (!GEMINI_API_KEY) {
    client.send(JSON.stringify({
      type: "error",
      message: "GEMINI_API_KEY não configurada no Render."
    }));

    client.close();
    return;
  }

  let geminiSession = null;
  let closed = false;

  try {
    const { GoogleGenAI } = await import("@google/genai");

    if (closed) return;

    const ai = new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    });

    geminiSession = await ai.live.connect({
      model: GEMINI_MODEL,

      config: {
        responseModalities: ["TEXT"],

        systemInstruction: {
          parts: [{
            text: PERSONALITY + `
              
Você também está acompanhando a tela do usuário por vídeo.
Observe os quadros recebidos como uma sequência temporal.
Descreva o que está acontecendo de maneira breve e natural.
Não invente movimentos que não consegue confirmar.
Evite repetir a mesma descrição sem necessidade.
`
          }]
        }
      },

      callbacks: {
        onmessage(message) {
          if (closed || client.readyState !== WebSocket.OPEN) {
            return;
          }

          const parts =
            message.serverContent?.modelTurn?.parts || [];

          const text = parts
            .map(part => part.text || "")
            .join("")
            .trim();

          if (text) {
            client.send(JSON.stringify({
              type: "text",
              text
            }));
          }

          const transcription =
            message.serverContent?.outputTranscription?.text;

          if (transcription) {
            client.send(JSON.stringify({
              type: "text",
              text: transcription
            }));
          }
        },

        onerror(error) {
          console.error(
            "Erro Gemini Live:",
            error.message || error
          );

          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "error",
              message: "Erro na conexão com Gemini Live."
            }));
          }
        },

        onclose(event) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "closed",
              message: event.reason || "Sessão encerrada."
            }));
          }
        }
      }
    });

    if (closed) {
      geminiSession.close();
      return;
    }

    client.send(JSON.stringify({
      type: "ready",
      message: "Visão da Ema conectada."
    }));

    geminiSession.sendClientContent({
      turns: [{
        role: "user",
        parts: [{
          text: "Comece a observar a tela que vou transmitir. Acompanhe a sequência de imagens e comente brevemente o que for relevante."
        }]
      }],
      turnComplete: true
    });

    client.on("message", (raw) => {
      if (!geminiSession) return;

      try {
        const packet = JSON.parse(raw.toString());

        if (packet.type === "frame") {
          if (
            typeof packet.data !== "string" ||
            packet.data.length > 1500000 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.data)
          ) {
            return;
          }

          geminiSession.sendRealtimeInput({
            video: {
              data: packet.data,
              mimeType: "image/jpeg"
            }
          });
        }

        if (
          packet.type === "text" &&
          typeof packet.text === "string" &&
          packet.text.length <= 2000
        ) {
          geminiSession.sendRealtimeInput({
            text: packet.text
          });
        }

      } catch (error) {
        console.error(
          "Pacote de visão inválido:",
          error.message
        );
      }
    });

  } catch (error) {
    console.error(
      "Falha ao iniciar Gemini Live:",
      error.message
    );

    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "error",
        message: "Não foi possível iniciar o Gemini Live."
      }));

      client.close();
    }
  }

  client.on("close", () => {
    closed = true;

    try {
      geminiSession?.close();
    } catch (_) {}
  });

  client.on("error", () => {
    closed = true;

    try {
      geminiSession?.close();
    } catch (_) {}
  });
});

// ==============================
// RESET
// ==============================

app.post("/reset", (req, res) => {
  const id =
    typeof req.body.sessionId === "string"
      ? req.body.sessionId
      : "default";

  sessions.delete(id);

  res.json({ success: true });
});

// ==============================
// INICIAR SERVIDOR
// ==============================

server.listen(PORT, "0.0.0.0", () => {
  console.log("Ema está online!");
  console.log("Groq:", GROQ_MODEL);
  console.log("Gemini Live:", GEMINI_MODEL);
  console.log("Visão WebSocket: /vision");
});
