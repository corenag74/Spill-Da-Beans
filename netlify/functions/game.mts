import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

interface Question {
  id: string;
  text: string;
}

interface McQuestion {
  id: string;
  text: string;
  options: string[];
  correctAnswer: string;
}

interface PlayerResult {
  playerName: string;
  answers: Record<string, string>;
  score: number;
  elapsedMs: number;
  submittedAt: number;
}

interface Photo {
  id: string;
  dataUrl: string;
}

interface Testimonial {
  playerName: string;
  note: string;
  submittedAt: number;
}

interface GameRecord {
  gameCode: string;
  ownerName: string;
  ownerPassword: string;
  subjectName: string;
  subjectPassword: string;
  questions: Question[];
  subjectAnswers: Record<string, string> | null;
  mcQuestions: McQuestion[] | null;
  status: "awaiting_subject" | "ready";
  players: Record<string, PlayerResult>;
  createdAt: number;
  photos: Photo[];
  slideshowText: string;
  testimonials: Testimonial[];
}

function store() {
  return getStore("subject-game");
}

function makeCode(len: number, alphabet: string) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildMcQuestions(questions: Question[], answers: Record<string, string>): McQuestion[] {
  const allAnswers = questions.map((q) => answers[q.id]).filter(Boolean);
  return questions.map((q) => {
    const correct = answers[q.id] || "";
    const others = allAnswers.filter((a) => a !== correct);
    const distractors = shuffle(others).slice(0, Math.min(3, others.length));
    // pad with placeholder decoys if not enough distinct other answers exist
    while (distractors.length < 3) {
      distractors.push(`Something ${q.text.split(" ")[0] || "else"} entirely`);
    }
    const options = shuffle([correct, ...distractors.slice(0, 3)]);
    return { id: q.id, text: q.text, options, correctAnswer: correct };
  });
}

function sortedPlayers(record: GameRecord): PlayerResult[] {
  return Object.values(record.players).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.elapsedMs - b.elapsedMs;
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const { action } = body;
  const db = store();

  try {
    if (action === "create") {
      const { ownerName, ownerPassword, subjectName, questions } = body;
      if (!ownerName || !ownerPassword || !subjectName || !Array.isArray(questions) || questions.length !== 10) {
        return new Response(JSON.stringify({ error: "Owner name, password, subject name, and exactly 10 questions are required." }), { status: 400 });
      }
      const gameCode = makeCode(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
      const subjectPassword = makeCode(4, "0123456789");
      const record: GameRecord = {
        gameCode,
        ownerName,
        ownerPassword,
        subjectName,
        subjectPassword,
        questions: questions.map((text: string, i: number) => ({ id: `q${i + 1}`, text })),
        subjectAnswers: null,
        mcQuestions: null,
        status: "awaiting_subject",
        players: {},
        createdAt: Date.now(),
        photos: [],
        slideshowText: "",
        testimonials: [],
      };
      await db.setJSON(gameCode, record);
      return new Response(JSON.stringify({ gameCode, subjectPassword }), { status: 200 });
    }

    if (action === "owner-login") {
      const { gameCode, ownerPassword } = body;
      const record: GameRecord | null = await db.get(gameCode, { type: "json" });
      if (!record || record.ownerPassword !== ownerPassword) {
        return new Response(JSON.stringify({ error: "Game not found or incorrect password." }), { status: 404 });
      }
      const players = sortedPlayers(record);
      return new Response(JSON.stringify({
        gameCode: record.gameCode,
        ownerName: record.ownerName,
        subjectName: record.subjectName,
        subjectPassword: record.subjectPassword,
        status: record.status,
        questions: record.questions,
        players,
        photos: record.photos || [],
        slideshowText: record.slideshowText || "",
        testimonials: record.testimonials || [],
      }), { status: 200 });
    }

    if (action === "set-photos") {
      const { gameCode, ownerPassword, photos, slideshowText } = body;
      const record: GameRecord | null = await db.get(gameCode, { type: "json" });
      if (!record || record.ownerPassword !== ownerPassword) {
        return new Response(JSON.stringify({ error: "Game not found or incorrect password." }), { status: 404 });
      }
      if (!Array.isArray(photos) || photos.length > 5) {
        return new Response(JSON.stringify({ error: "Up to 5 photos are allowed." }), { status: 400 });
      }
      record.photos = photos.map((dataUrl: string, i: number) => ({ id: `p${i + 1}`, dataUrl }));
      record.slideshowText = String(slideshowText || "").slice(0, 300);
      await db.setJSON(gameCode, record);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (action === "subject-check") {
      const { gameCode, subjectPassword } = body;
      const record: GameRecord | null = await db.get(gameCode, { type: "json" });
      if (!record || record.subjectPassword !== subjectPassword) {
        return new Response(JSON.stringify({ error: "Game code or password not recognized." }), { status: 404 });
      }
      if (record.subjectAnswers) {
        return new Response(JSON.stringify({ alreadyAnswered: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ questions: record.questions, subjectName: record.subjectName }), { status: 200 });
    }

    if (action === "subject-submit") {
      const { gameCode, subjectPassword, answers } = body;
      const record: GameRecord | null = await db.get(gameCode, { type: "json" });
      if (!record || record.subjectPassword !== subjectPassword) {
        return new Response(JSON.stringify({ error: "Game code or password not recognized." }), { status: 404 });
      }
      if (record.subjectAnswers) {
        return new Response(JSON.stringify({ error: "This subject has already answered." }), { status: 400 });
      }
      const answerMap: Record<string, string> = {};
      for (const a of answers) {
        answerMap[a.id] = String(a.text || "").trim();
      }
      record.subjectAnswers = answerMap;
      record.mcQuestions = buildMcQuestions(record.questions, answerMap);
      record.status = "ready";
      await db.setJSON(gameCode, record);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (action === "player-join") {
      const { gameCode, playerName } = body;
      const record: GameRecord | null = await db.get(gameCode, { type: "json" });
      if (!record) {
        return new Response(JSON.stringify({ error: "Game not found. Check the code." }), { status: 404 });
      }
      if (record.status !== "ready" || !record.mcQuestions) {
        return new Response(JSON.stringify({ error: "The birthday questions aren't ready yet. Ask the host." }), { status: 400 });
      }
      if (record.players[playerName]) {
        return new Response(JSON.stringify({ error: "That name already played this game. Try another name." }), { status: 400 });
      }
      const publicQuestions = record.mcQuestions.map((q) => ({ id: q.id, text: q.text, options: q.options }));
      return new Response(JSON.stringify({ questions: publicQuestions, subjectName: record.subjectName }), { status: 200 });
    }

    if (action === "player-submit") {
      const { gameCode, playerName, answers, elapsedMs } = body;
      const record: GameRecord | null = await db.get(gameCode, { type: "json" });
      if (!record || !record.mcQuestions) {
        return new Response(JSON.stringify({ error: "Game not found." }), { status: 404 });
      }
      if (record.players[playerName]) {
        return new Response(JSON.stringify({ error: "That name already played this game." }), { status: 400 });
      }
      const answerMap: Record<string, string> = {};
      let score = 0;
      for (const a of answers) {
        answerMap[a.id] = a.choice;
        const q = record.mcQuestions.find((mq) => mq.id === a.id);
        if (q && q.correctAnswer === a.choice) score++;
      }
      record.players[playerName] = {
        playerName,
        answers: answerMap,
        score,
        elapsedMs: elapsedMs || 0,
        submittedAt: Date.now(),
      };
      await db.setJSON(gameCode, record);

      const ranked = sortedPlayers(record);
      const isWinner = ranked.length > 0 && ranked[0].playerName === playerName;

      return new Response(JSON.stringify({
        score,
        total: record.mcQuestions.length,
        photos: record.photos || [],
        slideshowText: record.slideshowText || "",
        isWinner,
      }), { status: 200 });
    }

    if (action === "leaderboard") {
      const { gameCode } = body;
      const record: GameRecord | null = await db.get(gameCode, { type: "json" });
      if (!record) {
        return new Response(JSON.stringify({ error: "Game not found." }), { status: 404 });
      }
      const players = sortedPlayers(record);
      return new Response(JSON.stringify({ players, total: record.mcQuestions?.length || 10 }), { status: 200 });
    }

    if (action === "submit-testimonial") {
      const { gameCode, playerName, note } = body;
      const record: GameRecord | null = await db.get(gameCode, { type: "json" });
      if (!record) {
        return new Response(JSON.stringify({ error: "Game not found." }), { status: 404 });
      }
      const trimmed = String(note || "").trim().slice(0, 500);
      if (!trimmed) {
        return new Response(JSON.stringify({ error: "Write a note first." }), { status: 400 });
      }
      if (!record.testimonials) record.testimonials = [];
      record.testimonials.push({
        playerName: String(playerName || "A guest").slice(0, 60),
        note: trimmed,
        submittedAt: Date.now(),
      });
      await db.setJSON(gameCode, record);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "Unknown action." }), { status: 400 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Server error" }), { status: 500 });
  }
};

export const config: Config = {
  path: "/api/game",
};

