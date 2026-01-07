const path = require("path");
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const OpenAI = require("openai");
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Main debate endpoint
app.post("/ask", async (req, res) => {
  try {
    const { topic, stance, difficulty, userText } = req.body || {};

    if (!userText) {
      return res.status(400).json({ error: "Missing userText" });
    }

    const systemPrompt = `
You are a debate sparring partner and debate coach.
Your role:
- Challenge the user intelligently.
- If the user is PRO, argue CON. If CON, argue PRO.
- Be concise (2–6 sentences).
- Ask exactly ONE sharp follow-up question.
- Match the difficulty level.

Topic: ${topic || "General debate"}
User stance: ${stance || "PRO"}
Difficulty: ${difficulty || "Medium"}
    `.trim();

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    });

    const reply =
      response.output_text ||
      "I couldn’t generate a response. Try again.";

    res.json({ reply });
  } catch (err) {
    console.error("❌ OpenAI error:", err);
    res.status(500).json({
      error: "AI request failed",
      details: err.message,
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});