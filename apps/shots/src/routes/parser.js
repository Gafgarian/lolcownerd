// src/routes/parser.js
import express from "express";

const router = express.Router();

// .env (server-side)
const PARSER_ORIGIN = (process.env.PARSER_ORIGIN || "http://localhost:8080").replace(/\/+$/, "");
const PARSER_API_KEY = process.env.PARSER_API_KEY || "";

// tiny fetch helper
async function pFetch(path, init = {}) {
  const res = await fetch(`${PARSER_ORIGIN}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PARSER_API_KEY,
      ...(init.headers || {}),
    },
  });
  return res;
}

/** GET /api/parser/active → proxy to parser /parser/active */
router.get("/active", async (_req, res, next) => {
  try {
    const r = await pFetch("/parser/active");
    const txt = await r.text();
    try { return res.status(r.status).json(JSON.parse(txt)); }
    catch { return res.status(r.status).type("text/plain").send(txt); }
  } catch (e) { next(e); }
});

/** POST /api/parser/ensure { youtube, force? } → parser /parser/ensure */
router.post("/ensure", async (req, res, next) => {
  try {
    const youtube = req.body.youtube || req.body.url || "";
    if (!youtube) return res.status(400).json({ ok:false, error:"missing_youtube" });

    const body = JSON.stringify({ url: youtube, force: !!req.body.force }); // parser expects {url, force}
    const r = await pFetch("/parser/ensure", { method:"POST", body });
    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) { next(e); }
});

/** POST /api/parser/stop → parser /parser/stop */
router.post("/stop", async (_req, res, next) => {
  try {
    const r = await pFetch("/parser/stop", { method:"POST" });
    const j = await r.json().catch(() => ({}));
    return res.status(r.status).json(j);
  } catch (e) { next(e); }
});

export default router;