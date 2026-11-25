
const express = require("express");

const app = express();
app.use(express.json({ limit: "12mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

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

  if (!API_KEY) {
    return res.status(500).json({
      error: "A chave GROQ_API_KEY não foi configurada."
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
            "Authorization": `Bearer ${API_KEY}`
          },
          body: JSON.stringify({
            model: MODEL,
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

    // Guarda somente texto no histórico.
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
    console.error("Erro interno:", error.message);

    res.status(500).json({
      error: "Erro de conexão com a Ema."
    });
  }
});

app.post("/reset", (req, res) => {
  const id =
    typeof req.body.sessionId === "string"
      ? req.body.sessionId
      : "default";

  sessions.delete(id);

  res.json({ success: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Ema está online!");
  console.log("Modelo:", MODEL);
});
