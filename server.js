const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// 🔹 Topic suggestions
app.get("/topics", async (_req, res) => {
  try {
    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "Return ONLY a JSON array of 10 debate topics for high-school English debate club in Israel. Short, clear, appropriate.",
        },
      ],
    });

    let topics = [];
    try {
      topics = JSON.parse(r.output_text || "[]");
    } catch {
      topics = (r.output_text || "")
        .split("\n")
        .map((s) => s.replace(/^\d+[\).\s-]+/, "").trim())
        .filter(Boolean)
        .slice(0, 10);
    }

    res.json({ topics });
  } catch (err) {
    console.error("❌ /topics:", err);
    res.status(500).json({ error: "Failed to generate topics", details: err.message });
  }
});

// 🔹 Prep chat (before debate)
app.post("/prep", async (req, res) => {
  try {
    const { topic, stance, difficulty, messages, userText } = req.body || {};
    const chat = Array.isArray(messages) ? messages : [];
    if (!userText && chat.length === 0) {
      return res.status(400).json({ error: "Missing userText/messages" });
    }

    const systemPrompt = `
You are a friendly debate partner and coach.
This is PREP mode (before the debate starts).
- Give structured bullets, examples, and phrasing the student can say out loud.
- Ask 1 short question to clarify what they need next.
Topic: ${topic || "General"}
Student stance: ${stance || "PRO"}
Difficulty: ${difficulty || "Medium"}
`.trim();

    const input = [
      { role: "system", content: systemPrompt },
      ...chat.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || ""),
      })),
      ...(userText ? [{ role: "user", content: userText }] : []),
    ];

    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input,
    });

    res.json({ reply: r.output_text || "" });
  } catch (err) {
    console.error("❌ /prep:", err);
    res.status(500).json({ error: "Prep failed", details: err.message });
  }
});

// 🔹 Live debate turn
app.post("/ask", async (req, res) => {
  try {
    const { topic, stance, difficulty, userText } = req.body || {};
    if (!userText) return res.status(400).json({ error: "Missing userText" });

    const systemPrompt = `
You are a debate sparring partner.
- If the user is PRO, argue CON. If CON, argue PRO.
- Be concise (2–6 sentences).
- Ask exactly ONE sharp follow-up question.
Topic: ${topic || "General"}
User stance: ${stance || "PRO"}
Difficulty: ${difficulty || "Medium"}
`.trim();

    const r = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });

    res.json({ reply: r.output_text || "" });
  } catch (err) {
    console.error("❌ /ask:", err);
    res.status(500).json({ error: "AI request failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
