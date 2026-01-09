// server.js (CommonJS) — DebateCoach backend + /stt (AI dictation)
// Requires: npm i express cors dotenv openai multer
// Run: node server.js

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const OpenAI = require("openai");

const app = express();
app.use(cors());

// JSON for /ask and /prep
app.use(express.json({ limit: "2mb" }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
}

const client = new OpenAI({ apiKey });

// ---------- Upload (STT) ----------
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({ dest: TMP_DIR });

// ---------- helpers ----------
function safeStr(x, fallback = "") {
  return typeof x === "string" ? x : fallback;
}

function sanitizeDifficulty(d) {
  const v = safeStr(d, "Medium");
  if (["Easy", "Medium", "Hard"].includes(v)) return v;
  return "Medium";
}

function sanitizeStance(s) {
  const v = safeStr(s, "PRO").toUpperCase();
  return v === "CON" ? "CON" : "PRO";
}

function topicsSystemPrompt() {
  return [
    "You are a debate coach for Israeli high-school students.",
    "Generate concise, classroom-appropriate debate motions (one sentence each).",
    "Avoid hate, slurs, graphic content, or illegal instructions.",
    "Return exactly 10 different topics.",
  ].join(" ");
}

function prepSystemPrompt({ topic, stance, difficulty }) {
  const level =
    difficulty === "Easy"
      ? "Use very simple English, short sentences."
      : difficulty === "Hard"
        ? "Use more advanced English and deeper reasoning, but still clear for speaking."
        : "Use clear English suitable for speaking.";

  return [
    "You are a friendly debate coach.",
    "Your job: help the student prepare arguments, examples, rebuttals, and openings.",
    "Be practical for spoken debate (not an essay).",
    level,
    `Topic: "${topic}"`,
    `Student stance: ${stance}.`,
    "When asked for bullet points, keep them short and punchy.",
  ].join(" ");
}

function askSystemPrompt({ topic, stance, difficulty }) {
  const level =
    difficulty === "Easy"
      ? "Reply in simple English, short sentences."
      : difficulty === "Hard"
        ? "Reply with stronger logic, more nuance, and sharper rebuttals."
        : "Reply in clear English with solid reasoning.";

  return [
    "You simulate a live school debate.",
    "First, respond as the opposing debater (rebut + push your own point).",
    "Then give 2 short coaching tips to improve delivery (clarity, structure, evidence).",
    "Format:\nOPPONENT:\n...\n\nCOACH TIPS:\n- ...\n- ...",
    level,
    `Motion: "${topic}"`,
    `Student stance: ${stance}. So you must argue the opposite side in OPPONENT section.`,
  ].join(" ");
}

async function chat({ system, messages }) {
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [{ role: "system", content: system }, ...messages],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// Topics
app.get("/topics", async (_req, res) => {
  try {
    const system = topicsSystemPrompt();
    const userMsg =
      'Give me 10 debate topics as a JSON array ONLY, no extra text. Example: ["...","..."]';

    const text = await chat({
      system,
      messages: [{ role: "user", content: userMsg }],
    });

    let topics = [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) topics = parsed.map((t) => String(t)).filter(Boolean);
    } catch {
      topics = text
        .split("\n")
        .map((s) => s.replace(/^[-*\d.\s]+/, "").trim())
        .filter(Boolean);
    }

    topics = topics.slice(0, 10);
    if (!topics.length) topics = ["Should school start later in the morning?"];

    res.json({ topics });
  } catch (err) {
    console.error("/topics:", err);
    res.status(500).json({
      error: "Failed to generate topics",
      details: err?.message || String(err),
    });
  }
});

// Prep (supports either messages[] OR userText one-shot)
app.post("/prep", async (req, res) => {
  try {
    const topic = safeStr(req.body?.topic, "Debate topic");
    const stance = sanitizeStance(req.body?.stance);
    const difficulty = sanitizeDifficulty(req.body?.difficulty);

    const system = prepSystemPrompt({ topic, stance, difficulty });

    const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    const userText = safeStr(req.body?.userText, "").trim();

    let messages = [];

    if (incomingMessages && incomingMessages.length) {
      messages = incomingMessages
        .filter((m) => m && typeof m.content === "string" && typeof m.role === "string")
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content.slice(0, 4000),
        }))
        .slice(-12);
    } else if (userText) {
      messages = [{ role: "user", content: userText.slice(0, 4000) }];
    } else {
      return res.status(400).json({ error: "Missing messages or userText" });
    }

    const reply = await chat({ system, messages });
    res.json({ reply });
  } catch (err) {
    console.error("/prep:", err);
    res.status(500).json({
      error: "Prep failed",
      details: err?.message || String(err),
    });
  }
});

// Debate turn
app.post("/ask", async (req, res) => {
  try {
    const topic = safeStr(req.body?.topic, "Debate topic");
    const stance = sanitizeStance(req.body?.stance);
    const difficulty = sanitizeDifficulty(req.body?.difficulty);
    const userText = safeStr(req.body?.userText, "").trim();

    if (!userText) return res.status(400).json({ error: "Missing userText" });

    const system = askSystemPrompt({ topic, stance, difficulty });

    const messages = [
      { role: "user", content: `My argument:\n${userText}`.slice(0, 6000) },
    ];

    const reply = await chat({ system, messages });
    res.json({ reply });
  } catch (err) {
    console.error("/ask:", err);
    res.status(500).json({
      error: "Ask failed",
      details: err?.message || String(err),
    });
  }
});

// ✅ Speech-to-Text (upload audio blob from browser)
v

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});