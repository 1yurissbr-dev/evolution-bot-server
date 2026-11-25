
const express = require("express");

const app = express();
app.use(express.json({ limit: "20kb" }));

app.get("/", (req, res) => {
  res.send("Evolution Bot está funcionando!");
});

app.post("/chat", async (req, res) => {
  try {
    const message = req.body.message;

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

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "A chave da IA não foi configurada."
      });
    }

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-6.1-sol",
          input: message
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro na API:", response.status);

      return res.status(502).json({
        error: "Não foi possível consultar a IA."
      });
    }

    const reply = (data.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n");

    if (!reply) {
      return res.status(502).json({
        error: "A IA não retornou uma resposta."
      });
    }

    res.json({ reply });

  } catch (error) {
    console.error("Erro interno:", error.message);

    res.status(500).json({
      error: "Erro interno do servidor."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Evolution Bot está ativo!");
});
