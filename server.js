
const express = require("express");

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const sessions = new Map();

const PERSONALITY = `
Você é Ema, uma inteligência artificial feminina que conversa em português brasileiro.

PERSONALIDADE:
- Natural, espontânea, inteligente e bem-humorada.
- Tem personalidade própria, não parece um robô de atendimento.
- É direta, descontraída e pode usar palavrões leves quando combinar com a conversa.
- Demonstra interesse pelo que o usuário está fazendo.
- Não é excessivamente formal nem artificialmente simpática.

REGRA MAIS IMPORTANTE: SEJA BREVE.
- Normalmente responda em 1 a 3 frases.
- Nunca faça textões sem que o usuário peça.
- Não explique o óbvio.
- Não repita informações.
- Não transforme perguntas simples em listas enormes.
- Se puder responder em uma frase, responda em uma frase.

COMPORTAMENTO:
- Lembre-se do contexto da conversa.
- Não invente informações.
- Admita quando não souber alguma coisa.
- Faça apenas uma pergunta por vez quando precisar esclarecer algo.
- Não diga que executou uma ação se não executou.
- Não afirme que pesquisou na internet se não tiver uma ferramenta de pesquisa.
- Não afirme que clicou ou controlou o celular se não tiver acesso a essas funções.

IDENTIDADE:
Seu nome é Ema.
Você é uma assistente de IA, não uma pessoa real.
`;

app.get("/", (req, res) => {
  res.send("Ema está funcionando!");
});

app.post("/chat", async (req, res) => {
  const { message, sessionId } = req.body;

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Mensagem inválida." });
  }

  if (message.length > 4000) {
    return res.status(400).json({ error: "Mensagem muito longa." });
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
    session = { messages: [], updated: now };
    sessions.set(id, session);
  }

  session.messages.push({
    role: "user",
    content: message.trim()
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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
              { role: "system", content: PERSONALITY },
              ...session.messages
            ],
            max_completion_tokens: 220,
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
      session.messages.pop();

      console.error(
        "Erro Groq:",
        response.status,
        data.error?.message || "Erro desconhecido"
      );

      return res.status(502).json({
        error: "A Ema não conseguiu responder agora."
      });
    }

    const reply = data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      session.messages.pop();

      return res.status(502).json({
        error: "A Ema não retornou uma resposta."
      });
    }

    session.messages.push({
      role: "assistant",
      content: reply
    });

    session.messages = session.messages.slice(-20);
    session.updated = Date.now();

    res.json({ reply });

  } catch (error) {
    session.messages.pop();

    console.error("Erro interno:", error.message);

    res.status(500).json({
      error: "Erro de conexão com a Ema."
    });
  }
});

app.post("/reset", (req, res) => {
  const id = req.body.sessionId || "default";
  sessions.delete(id);

  res.json({ success: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Ema está online!");
});
