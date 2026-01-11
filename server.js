// server.js (CommonJS) — DebateCoach backend
// Deps:
//   npm i express cors dotenv openai multer
// Run locally:
//   node server.js

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
require("dotenv").config();

const OpenAI = require("openai");
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
}

const client = new OpenAI({ apiKey });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// -------------------- helpers --------------------
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

function clampTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      studentText: safeStr(t.studentText, "").slice(0, 6000),
      studentTranscript: safeStr(t.studentTranscript, "").slice(0, 6000),
      recordingMs: Number.isFinite(t.recordingMs) ? Math.max(0, Math.floor(t.recordingMs)) : 0,
      aiReply: safeStr(t.aiReply, "").slice(0, 6000),
    }))
    .slice(0, 12);
}

function wordsCount(text) {
  const s = safeStr(text, "").trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

function wpm(words, ms) {
  if (!ms || ms <= 0) return null;
  const minutes = ms / 60000;
  if (minutes <= 0) return null;
  return Math.round(words / minutes);
}

async function chat({ system, messages, temperature = 0.7 }) {
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    messages: [{ role: "system", content: system }, ...messages],
  });
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// -------------------- prompts --------------------
function topicsSystemPrompt() {
  // ✅ ה-PROMPT הסופי שלך
  return `You are a debate coach for Israeli high-school students (ages 14–18).
Generate EXACTLY 10 debate motions (one sentence each) that are engaging and relevant to teens.

Hard rules:
1) Each motion must be from a DIFFERENT category, in this exact order:
   1. Technology / AI
   2. Social media / youth culture
   3. Education / school life
   4. Israeli society (daily life)
   5. Civic / democracy / law
   6. Economy / money / work
   7. Ethics / moral dilemma
   8. Environment / climate
   9. Health / lifestyle / sports
   10. Global affairs / international relations
2) Avoid repeating the same topic idea in different wording.
3) Do NOT start every sentence with “This house believes/This house would”.
   Vary the phrasing naturally.
4) Keep each motion clear, concrete, and debatable (not a vague discussion question).
5) No hate, slurs, graphic content, or illegal instructions.
6) Use simple-to-medium English (spoken-friendly).

Output format:
Return ONLY a JSON array of 10 strings. No extra text, no numbering, no markdown.
Example: ["...", "...", ...]`;
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
    "This is PREP mode (before the debate).",
    "Give practical speaking-ready bullets, examples, and phrases.",
    "If helpful, suggest structure: claim → reason → example.",
    level,
    `Topic: "${topic}"`,
    `Student stance: ${stance}`,
    "",
    "Formatting rules:",
    "- No markdown, no asterisks.",
    "- Use clear headings like: OPENING:, PRO POINTS:, CON POINTS:, REBUTTALS: etc.",
    "- Use hyphen bullets.",
  ].join("\n");
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
    "Respond as the OPPONENT of the student.",
    "Be concise and sharp: 2–6 sentences.",
    "Ask EXACTLY ONE follow-up question at the end.",
    level,
    `Motion: "${topic}"`,
    `Student stance: ${stance} (so you argue the opposite).`,
    "",
    "Formatting rules:",
    "- No markdown, no asterisks.",
    "- Prefer short paragraphs.",
  ].join("\n");
}

function feedbackSystemPrompt({ topic, studentSide, difficulty, mode }) {
  const level =
    difficulty === "Easy"
      ? "Use simple English explanations."
      : difficulty === "Hard"
        ? "Use more advanced English but keep it teacher-friendly."
        : "Use clear English, teacher-friendly.";

  const depth =
    mode === "detailed"
      ? "Give a detailed teacher-style feedback with examples."
      : "Give short, high-impact feedback (quick to read).";

  return [
    "You are an English teacher + debate coach.",
    "You are reviewing a FULL practice debate session (multiple turns).",
    "Your feedback must help the student improve quickly.",
    level,
    depth,
    "",
    `Topic: "${topic}"`,
    `Student side: ${studentSide}.`,
    "",
    "Hard rules:",
    "- Do NOT mention policy or safety.",
    "- Do NOT give technical audio diagnostics.",
    "- Use the provided transcript and WPM as a rough fluency indicator, but keep it educational.",
    "",
    "Output format rules (IMPORTANT):",
    "- No markdown, no asterisks, no numbering like 1) unless requested below.",
    "- Use these exact headings:",
    "SUMMARY:",
    "ENGLISH FIXES (Top 5):",
    "MISHEARD / UNCLEAR WORDS:",
    "DEBATE COACHING:",
    "FLUENCY & PACE:",
    "NEXT PRACTICE TASK:",
    "",
    "Under each heading use hyphen bullets.",
    "For ENGLISH FIXES: write Original → Better (short).",
    "For MISHEARD / UNCLEAR WORDS: only include if you strongly suspect mishearing; otherwise write: - None",
  ].join("\n");
}

// -------------------- routes --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// 🔹 Topics
app.get("/topics", async (_req, res) => {
  try {
    const system = topicsSystemPrompt();
    const userMsg = "Return ONLY a valid JSON array of 10 strings. No other text.";

    const text = await chat({
      system,
      messages: [{ role: "user", content: userMsg }],
      temperature: 0.6,
    });

    let topics = [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) topics = parsed.map((t) => String(t)).filter(Boolean);
    } catch {
      topics = text
        .split("\n")
        .map((s) => s.replace(/^[-*\d.\s]+/, "").trim())
        .filter(Boolean)
        .slice(0, 10);
    }

    topics = topics.slice(0, 10);
    if (!topics.length) topics = ["Should schools allow AI tools for homework?"];

    res.json({ topics });
  } catch (err) {
    console.error("❌ /topics:", err);
    res.status(500).json({
      error: "Failed to generate topics",
      details: err?.message || String(err),
    });
  }
});

// 🔹 Prep (optional; one-shot or messages[])
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

    const reply = await chat({ system, messages, temperature: 0.7 });
    res.json({ reply });
  } catch (err) {
    console.error("❌ /prep:", err);
    res.status(500).json({
      error: "Prep failed",
      details: err?.message || String(err),
    });
  }
});

// 🔹 Debate turn
app.post("/ask", async (req, res) => {
  try {
    const topic = safeStr(req.body?.topic, "Debate topic");
    const stance = sanitizeStance(req.body?.stance); // student stance
    const difficulty = sanitizeDifficulty(req.body?.difficulty);
    const userText = safeStr(req.body?.userText, "").trim();

    if (!userText) return res.status(400).json({ error: "Missing userText" });

    const system = askSystemPrompt({ topic, stance, difficulty });

    const messages = [{ role: "user", content: `My argument:\n${userText}`.slice(0, 6000) }];

    const reply = await chat({ system, messages, temperature: 0.7 });
    res.json({ reply });
  } catch (err) {
    console.error("❌ /ask:", err);
    res.status(500).json({
      error: "Ask failed",
      details: err?.message || String(err),
    });
  }
});

// 🔹 Feedback on FULL debate
app.post("/feedback", async (req, res) => {
  try {
    const topic = safeStr(req.body?.topic, "Debate topic");
    const studentSide = sanitizeStance(req.body?.studentSide || req.body?.stance);
    const difficulty = sanitizeDifficulty(req.body?.difficulty);
    const mode = (safeStr(req.body?.mode, "short").toLowerCase() === "detailed") ? "detailed" : "short";

    const turns = clampTurns(req.body?.turns);

    if (!turns.length) {
      return res.status(400).json({ error: "No turns provided" });
    }

    // Aggregate WPM (rough)
    const totalMs = turns.reduce((a, t) => a + (t.recordingMs || 0), 0);
    const totalTranscript = turns.map(t => t.studentTranscript || "").join(" ").trim();
    const totalWords = wordsCount(totalTranscript);
    const totalWpm = wpm(totalWords, totalMs);

    const compactTurns = turns.map((t, idx) => {
      const tr = (t.studentTranscript || "").trim();
      const txt = (t.studentText || "").trim();
      const words = wordsCount(tr);
      const w = wpm(words, t.recordingMs);
      return [
        `TURN ${idx + 1}:`,
        `Student transcript: ${tr || "(empty)"}`,
        `Student final text (after edits): ${txt || "(empty)"}`,
        `Recording time ms: ${t.recordingMs || 0}`,
        `Estimated WPM: ${w ?? "unknown"}`,
        `Computer reply: ${t.aiReply || "(empty)"}`,
      ].join("\n");
    }).join("\n\n");

    const system = feedbackSystemPrompt({ topic, studentSide, difficulty, mode });

    const userMsg = [
      "Here is the full session data.",
      `Overall estimated WPM: ${totalWpm ?? "unknown"} (based on transcript words / recording time)`,
      "",
      compactTurns,
    ].join("\n");

    const reply = await chat({
      system,
      messages: [{ role: "user", content: userMsg.slice(0, 24000) }],
      temperature: 0.4,
    });

    res.json({
      reply: reply || "",
      meta: { totalWpm: totalWpm ?? null, totalWords, totalMs, turns: turns.length, mode },
    });
  } catch (err) {
    console.error("❌ /feedback:", err);
    res.status(500).json({
      error: "Feedback failed",
      details: err?.message || String(err),
    });
  }
});

// -------------------- STT (optional) --------------------
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

function extFromFile(reqFile) {
  const orig = (reqFile.originalname || "").toLowerCase();
  const byName = path.extname(orig);
  if (byName) return byName;

  const mt = (reqFile.mimetype || "").toLowerCase();
  if (mt.includes("wav")) return ".wav";
  if (mt.includes("mpeg") || mt.includes("mp3")) return ".mp3";
  if (mt.includes("mp4") || mt.includes("m4a")) return ".m4a";
  if (mt.includes("ogg")) return ".ogg";
  if (mt.includes("webm")) return ".webm";
  return ".wav";
}

app.post("/stt", upload.single("audio"), async (req, res) => {
  let tmpPath = null;
  let finalPath = null;

  try {
    if (!req.file?.path) return res.status(400).json({ error: "Missing audio file" });

    tmpPath = req.file.path;
    const ext = extFromFile(req.file);
    finalPath = tmpPath + ext;
    fs.renameSync(tmpPath, finalPath);

    const stat = fs.statSync(finalPath);
    if (stat.size < 2500) {
      return res.status(400).json({ error: "Audio too small. Speak louder/closer and try again." });
    }

    const tr = await client.audio.transcriptions.create({
      file: fs.createReadStream(finalPath),
      model: "whisper-1",
      language: "en",
    });

    res.json({ text: tr.text || "" });
  } catch (err) {
    console.error("❌ /stt:", err);
    res.status(err?.status || 500).json({
      error: "STT failed",
      details: err?.message || String(err),
    });
  } finally {
    try {
      if (finalPath && fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      else if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
});

// -------------------- SPA fallback (Express 5 safe) --------------------
app.get(/.*/, (req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -------------------- start --------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});