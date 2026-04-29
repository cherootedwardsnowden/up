/*
 * MetaUpload - Production File Hosting
 * All rights reserved. Unauthorized redistribution prohibited.
 */

const xp = require("express");
const ml = require("multer");
const bc = require("bcryptjs");
const jw = require("jsonwebtoken");
const cp = require("cookie-parser");
const fs = require("fs");
const pt = require("path");
const cr = require("crypto");
const uu = require("uuid");
const ht = require("helmet");
const rl = require("express-rate-limit");
const app = xp();

const _0x = (s) => cr.createHash("sha256").update(s).digest("hex");
const _1x = (n, k) => { const c = cr.createCipheriv("aes-256-cbc", Buffer.from(_0x(k).slice(0,32)), Buffer.from(_0x(k).slice(0,16))); return c.update(n,"utf8","hex") + c.final("hex"); };
const _2x = (n, k) => { try { const c = cr.createDecipheriv("aes-256-cbc", Buffer.from(_0x(k).slice(0,32)), Buffer.from(_0x(k).slice(0,16))); return c.update(n,"hex","utf8") + c.final("utf8"); } catch(e) { return null; } };

const OWNER_IP = "176.42.131.129";
const JWT_SECRET = process.env.JWT_SECRET || _0x("metaupload_secret_9x2k_" + Date.now().toString().slice(0,6));
const DATA_KEY = process.env.DATA_KEY || _0x("datakey_mu_" + OWNER_IP);
const PORT = process.env.PORT || 3000;
const VIDEO_TOKEN_SECRET = process.env.VIDEO_TOKEN_SECRET || _0x("videotoken_mu_9z2k_" + OWNER_IP);
const PREVIEW_SECONDS = 15;

const videoTokens = new Map();
const hlsCache = new Map();
const watchStats = new Map();

const DIRS = { uploads: "./mu_files", thumbs: "./mu_thumbs", data: "./mu_data", hls: "./mu_hls" };
Object.values(DIRS).forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

function cleanHlsTemp() {
  try {
    const files = fs.readdirSync(DIRS.hls);
    const now = Date.now();
    files.forEach(f => {
      try {
        const fp = pt.join(DIRS.hls, f);
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(fp);
      } catch(e) {}
    });
  } catch(e) {}
}
cleanHlsTemp();
setInterval(cleanHlsTemp, 10 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hlsCache.entries()) {
    if (v.expires < now) {
      v.segPaths.forEach(sp => { try { fs.unlinkSync(sp); } catch(e) {} });
      hlsCache.delete(k);
      console.log("[HLS cache] Expired entry removed:", k);
    }
  }
}, 5 * 60 * 1000);

const DB = {
  _f: (n) => pt.join(DIRS.data, _0x(n).slice(0,16) + ".dat"),
  _r: (n) => { try { const raw = fs.readFileSync(DB._f(n),"utf8"); return JSON.parse(_2x(raw, DATA_KEY) || "{}"); } catch(e) { return {}; } },
  _w: (n, d) => { fs.writeFileSync(DB._f(n), _1x(JSON.stringify(d), DATA_KEY), "utf8"); },
  get: (n) => DB._r(n),
  set: (n, d) => DB._w(n, d),
  merge: (n, d) => { const old = DB._r(n); DB._w(n, Object.assign(old, d)); }
};

function initData() {
  if (!DB.get("users").initialized) {
    const DEFAULT_OWNER_PW = "MetaOwner@2024!";
    DB.set("users", {
      initialized: true,
      list: {
        "owner": { id: "owner", username: "owner", password: bc.hashSync(DEFAULT_OWNER_PW, 10), role: "owner", created: Date.now(), uploadedToday: 0, lastDay: new Date().toDateString(), totalUploads: 0 }
      }
    });
    console.log("╔══════════════════════════════════════╗");
    console.log("║   MetaUpload - Owner Account Created  ║");
    console.log("║   Username : owner                    ║");
    console.log("║   Password : MetaOwner@2024!          ║");
    console.log("╚══════════════════════════════════════╝");
  }
  if (!DB.get("files").initialized) DB.set("files", { initialized: true, list: {} });
  if (!DB.get("config").initialized) DB.set("config", { initialized: true, premiumEnabled: true, maintenance: false, maxFreeDaily: 30*1024*1024, maxVipDaily: 1024*1024*1024 });
  if (!DB.get("sessions").initialized) DB.set("sessions", { initialized: true, list: {} });
}
initData();

const LIMITS = { free: 30*1024*1024, vip: 1024*1024*1024, owner: Infinity, mod: Infinity };
const ROLES = ["owner","mod","vip","free"];

function getUser(username) { const d = DB.get("users"); return d.list && d.list[username] ? d.list[username] : null; }
function saveUser(u) { const d = DB.get("users"); d.list[u.username] = u; DB.set("users", d); }
function getFile(fid) { const d = DB.get("files"); return d.list && d.list[fid] ? d.list[fid] : null; }
function saveFile(f) { const d = DB.get("files"); d.list[f.id] = f; DB.set("files", d); }
function deleteFile(fid) { const d = DB.get("files"); if (d.list) { delete d.list[fid]; DB.set("files", d); } }
function getCfg() { return DB.get("config"); }
function saveCfg(c) { DB.set("config", c); }

function checkDailyReset(u) {
  const today = new Date().toDateString();
  if (u.lastDay !== today) { u.uploadedToday = 0; u.lastDay = today; }
  return u;
}

// ─── FFMPEG ───────────────────────────────────────────────────────────────────
const ffmpegPath  = require("ffmpeg-static");
const ffprobePath = require("@ffprobe-installer/ffprobe").path;
const ffmpeg      = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta || !meta.format) return resolve(null);
      resolve(meta.format.duration || null);
    });
  });
}

// ─── HLS SESSION ÜRETME ───────────────────────────────────────────────────────
// HIZLI YOL: stream copy kullan (re-encode yok), fid bazlı cache (token değil)
// Aynı video için sadece bir kez ffmpeg çalışır, sonraki istekler cache'den gelir.
// isPreview=true → sadece ilk PREVIEW_SECONDS saniyelik segmentler playlist'e eklenir.

// Aktif encode işlerini takip et (aynı fid için paralel encode engelle)
const encodeInProgress = new Map();

async function generateHlsSession(fid, filePath, isPreview, token) {
  // Cache key: fid + preview flag (token DEĞİL — aynı video herkes için bir kez encode)
  const fidCacheKey = fid + ":" + (isPreview ? "p" : "f");

  // Cache'de varsa playlist'teki segment URL'lerini bu token ile yeniden yaz ve dön
  if (hlsCache.has(fidCacheKey)) {
    const cached = hlsCache.get(fidCacheKey);
    if (cached.expires > Date.now()) {
      return rewritePlaylistForToken(cached, token);
    }
    cached.segPaths.forEach(sp => { try { fs.unlinkSync(sp); } catch(e) {} });
    hlsCache.delete(fidCacheKey);
  }

  // Aynı fid için encode devam ediyorsa bekle
  if (encodeInProgress.has(fidCacheKey)) {
    await encodeInProgress.get(fidCacheKey);
    if (hlsCache.has(fidCacheKey)) {
      return rewritePlaylistForToken(hlsCache.get(fidCacheKey), token);
    }
  }

  const uid        = _0x(fidCacheKey).slice(0, 20);
  const segPrefix  = pt.join(DIRS.hls, uid + "_s");
  const m3u8Path   = pt.join(DIRS.hls, uid + ".m3u8");

  const encodePromise = new Promise((resolve, reject) => {
    const cmd = ffmpeg(filePath);

    // Stream copy: orijinal codec'i koru, re-encode yok → anında başlar
    // isPreview: sadece ilk N saniyeyi kes
    const inputOpts = [];
    if (isPreview) inputOpts.push("-t " + PREVIEW_SECONDS);
    if (inputOpts.length) cmd.inputOptions(inputOpts);

    cmd
      .outputOptions([
        "-c:v copy",          // Video re-encode YOK → çok hızlı
        "-c:a copy",          // Ses re-encode YOK
        "-hls_time 4",
        "-hls_list_size 0",
        "-hls_segment_type mpegts",
        "-hls_segment_filename " + segPrefix + "%03d.ts",
        "-hls_flags independent_segments",
        "-f hls"
      ])
      .output(m3u8Path)
      .on("end", () => {
        try {
          const rawPlaylist = fs.readFileSync(m3u8Path, "utf8");
          try { fs.unlinkSync(m3u8Path); } catch(e) {}

          // Segment yollarını topla (token'sız — raw paths)
          const segPaths = [];
          rawPlaylist.replace(/^([^\s#][^\n]*\.ts)$/gm, (_, segRelFile) => {
            const segAbs = pt.join(DIRS.hls, pt.basename(segRelFile));
            if (fs.existsSync(segAbs)) segPaths.push(segAbs);
          });

          const entry = {
            rawPlaylist,  // Token içermeyen ham playlist
            segPaths,
            expires: Date.now() + 8 * 60 * 60 * 1000, // 8 saat cache
            isPreview
          };
          hlsCache.set(fidCacheKey, entry);
          resolve(entry);
        } catch(e) { reject(e); }
      })
      .on("error", (err) => {
        // Stream copy başarısız olduysa (codec uyumsuzluğu) re-encode ile dene
        console.warn("[HLS copy failed, retrying with encode]", err.message);
        const cmd2 = ffmpeg(filePath);
        if (isPreview) cmd2.inputOptions(["-t " + PREVIEW_SECONDS]);
        cmd2
          .outputOptions([
            "-c:v libx264", "-c:a aac",
            "-preset ultrafast", "-crf 23",
            "-hls_time 4", "-hls_list_size 0",
            "-hls_segment_type mpegts",
            "-hls_segment_filename " + segPrefix + "%03d.ts",
            "-hls_flags independent_segments",
            "-f hls"
          ])
          .output(m3u8Path)
          .on("end", () => {
            try {
              const rawPlaylist = fs.readFileSync(m3u8Path, "utf8");
              try { fs.unlinkSync(m3u8Path); } catch(e2) {}
              const segPaths = [];
              rawPlaylist.replace(/^([^\s#][^\n]*\.ts)$/gm, (_, sf) => {
                const sa = pt.join(DIRS.hls, pt.basename(sf));
                if (fs.existsSync(sa)) segPaths.push(sa);
              });
              const entry = { rawPlaylist, segPaths, expires: Date.now() + 8*60*60*1000, isPreview };
              hlsCache.set(fidCacheKey, entry);
              resolve(entry);
            } catch(e3) { reject(e3); }
          })
          .on("error", (e4) => { console.error("[HLS encode fallback failed]", e4.message); reject(e4); })
          .run();
      })
      .run();
  });

  encodeInProgress.set(fidCacheKey, encodePromise);
  try {
    const result = await encodePromise;
    encodeInProgress.delete(fidCacheKey);
    return rewritePlaylistForToken(result, token);
  } catch(e) {
    encodeInProgress.delete(fidCacheKey);
    throw e;
  }
}

// Segment URL'lerini bu token ile yeniden yaz (her kullanıcı kendi token'ını görür)
function rewritePlaylistForToken(cached, token) {
  const playlist = cached.rawPlaylist.replace(/^([^\s#][^\n]*\.ts)$/gm, (_, segRelFile) => {
    const segBase = pt.basename(segRelFile);
    return "/hls/" + encodeURIComponent(token) + "/" + encodeURIComponent(segBase);
  });
  return { ...cached, playlist };
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
const storage = ml.diskStorage({
  destination: (req, file, cb) => cb(null, DIRS.uploads),
  filename: (req, file, cb) => {
    const ext = pt.extname(file.originalname).toLowerCase();
    const fid = _0x(uu.v4() + Date.now() + file.originalname).slice(0,32);
    cb(null, fid + ext);
  }
});
const fileFilter = (req, file, cb) => {
  const allowed = ["image/jpeg","image/png","image/gif","image/webp","video/mp4","video/webm","video/ogg","video/quicktime"];
  allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("INVALID_TYPE"), false);
};
const upload = ml({ storage, fileFilter, limits: { fileSize: 1024*1024*1024 } });

function authMW(req, res, next) {
  const token = req.cookies && req.cookies["_mu_sess"];
  if (!token) return res.status(401).json({ error: "AUTH_REQUIRED" });
  try {
    const pl = jw.verify(token, JWT_SECRET);
    const u = getUser(pl.username);
    if (!u) return res.status(401).json({ error: "USER_NOT_FOUND" });
    req.user = u;
    next();
  } catch(e) { return res.status(401).json({ error: "INVALID_TOKEN" }); }
}

function ownerMW(req, res, next) {
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || req.ip;
  const isOwner = clientIp === OWNER_IP || clientIp === "::ffff:" + OWNER_IP || clientIp === "::1";
  if (!isOwner) return res.status(403).json({ error: "IP_FORBIDDEN" });
  authMW(req, res, () => {
    if (req.user.role !== "owner") return res.status(403).json({ error: "ROLE_FORBIDDEN" });
    next();
  });
}

function modMW(req, res, next) {
  authMW(req, res, () => {
    if (!["owner","mod"].includes(req.user.role)) return res.status(403).json({ error: "MOD_REQUIRED" });
    next();
  });
}

const BLOCKED_UA = ["wget","curl","aria2","idm","internet download","fdm","jdownloader","downloadmgr","getright","flashget","libwww","python-requests","go-http","java/","okhttp","axel","httrack","yt-dlp","youtube-dl"];
function blockDlMgr(req, res, next) {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  if (BLOCKED_UA.some(b => ua.includes(b))) return res.status(403).end();
  next();
}

const limiter = rl({
  windowMs: 15*60*1000, max: 600, standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path.startsWith("/hls/") || req.path.startsWith("/t/") || req.path.startsWith("/g/") || req.path === "/api/watch-stat"
});
const authLimiter  = rl({ windowMs: 15*60*1000, max: 30,  standardHeaders: true, legacyHeaders: false });
const tokenLimiter = rl({ windowMs: 60*1000,    max: 10,  standardHeaders: true, legacyHeaders: false });
const hlsLimiter   = rl({ windowMs: 60*1000,    max: 6,   standardHeaders: true, legacyHeaders: false });

app.use(ht({ contentSecurityPolicy: false }));
app.use(limiter);
app.use(xp.json({ limit: "2mb" }));
app.use(xp.urlencoded({ extended: true, limit: "2mb" }));
app.use(cp());
app.set("trust proxy", 1);

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post("/api/register", authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: "MISSING_FIELDS" });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.json({ ok: false, error: "INVALID_USERNAME" });
  if (password.length < 6) return res.json({ ok: false, error: "PASS_TOO_SHORT" });
  if (getUser(username)) return res.json({ ok: false, error: "USER_EXISTS" });
  const hashed = await bc.hash(password, 12);
  const u = { id: uu.v4(), username, password: hashed, role: "free", created: Date.now(), uploadedToday: 0, lastDay: new Date().toDateString(), totalUploads: 0, banned: false };
  saveUser(u);
  res.json({ ok: true });
});

app.post("/api/login", authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const u = getUser(username);
  if (!u) return res.json({ ok: false, error: "INVALID_CREDENTIALS" });
  if (u.banned) return res.json({ ok: false, error: "ACCOUNT_BANNED" });
  const valid = await bc.compare(password, u.password);
  if (!valid) return res.json({ ok: false, error: "INVALID_CREDENTIALS" });
  const token = jw.sign({ username: u.username, role: u.role }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("_mu_sess", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 7*24*60*60*1000 });
  res.json({ ok: true, role: u.role, username: u.username });
});

app.post("/api/logout", (req, res) => { res.clearCookie("_mu_sess"); res.json({ ok: true }); });

app.get("/api/me", authMW, (req, res) => {
  const u = checkDailyReset(req.user);
  saveUser(u);
  const limit = LIMITS[u.role] || LIMITS.free;
  const remaining = limit === Infinity ? -1 : Math.max(0, limit - (u.uploadedToday || 0));
  res.json({ ok: true, username: u.username, role: u.role, remaining, totalUploads: u.totalUploads || 0 });
});

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
app.post("/api/upload", authMW, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "NO_FILE" });
  const u = checkDailyReset(req.user);
  const cfg = getCfg();
  const fsize = req.file.size;
  const limit = LIMITS[u.role] || LIMITS.free;

  if (limit !== Infinity && (u.uploadedToday || 0) + fsize > limit) {
    fs.unlinkSync(req.file.path);
    return res.json({ ok: false, error: "DAILY_LIMIT_EXCEEDED" });
  }

  const isVideo = req.file.mimetype.startsWith("video/");
  const isImage = req.file.mimetype.startsWith("image/");
  const isGif   = req.file.mimetype === "image/gif";
  const userWantsPremium = req.body && req.body.markPremium === "1";
  const isPremiumContent = isVideo && cfg.premiumEnabled && userWantsPremium;
  const fid = pt.basename(req.file.filename, pt.extname(req.file.filename));
  const thumbPath    = pt.join(DIRS.thumbs, fid + "_t.jpg");
  const gifThumbPath = pt.join(DIRS.thumbs, fid + "_g.gif");

  let thumbReady = false, gifReady = false, duration = null;

  try {
    if (isImage && !isGif) {
      const sharp = require("sharp");
      await sharp(req.file.path).resize(320, 240, { fit: "cover" }).jpeg({ quality: 70 }).toFile(thumbPath);
      thumbReady = true;
    } else if (isVideo) {
      duration = await getVideoDuration(req.file.path);
      await new Promise((resolve) => {
        ffmpeg(req.file.path).seekInput(Math.random() * 4 + 0.5).frames(1).size("320x240").output(thumbPath)
          .on("end", () => { thumbReady = true; resolve(); }).on("error", () => resolve()).run();
      });
    }
  } catch(e) { console.log("[thumb]", e.message); }

  try {
    if (isVideo) {
      const segPaths = [];
      for (let i = 0; i < 7; i++) {
        const sp = pt.join(DIRS.thumbs, fid + "_s" + i + ".gif");
        await new Promise((resolve) => {
          ffmpeg(req.file.path).seekInput(i * 1.5).duration(1)
            .outputOptions(["-vf","fps=8,scale=320:240:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse","-loop","0"])
            .output(sp).on("end", () => { if (fs.existsSync(sp)) segPaths.push(sp); resolve(); }).on("error", () => resolve()).run();
        });
      }
      if (segPaths.length >= 2) {
        let cmd = ffmpeg(); segPaths.forEach(s => cmd.input(s));
        await new Promise((resolve) => {
          cmd.complexFilter([`concat=n=${segPaths.length}:v=1:a=0[v]`], ["v"]).outputOptions(["-loop","0"]).output(gifThumbPath)
            .on("end", () => { gifReady = fs.existsSync(gifThumbPath); resolve(); }).on("error", () => resolve()).run();
        });
      } else if (segPaths.length === 1) { try { fs.renameSync(segPaths[0], gifThumbPath); gifReady = true; } catch(e2) {} }
      segPaths.forEach(s => { try { fs.unlinkSync(s); } catch(e3) {} });
    }
  } catch(e) { console.log("[gifthumb]", e.message); }

  u.uploadedToday = (u.uploadedToday || 0) + fsize;
  u.totalUploads  = (u.totalUploads  || 0) + 1;
  saveUser(u);

  const fd = { id: fid, originalName: _1x(req.file.originalname, DATA_KEY), filename: req.file.filename, mimetype: req.file.mimetype, size: fsize, uploader: u.username, uploaded: Date.now(), premium: isPremiumContent, thumbReady, gifReady, duration, views: 0, downloads: 0 };
  saveFile(fd);
  const remaining = limit === Infinity ? -1 : Math.max(0, limit - u.uploadedToday);
  res.json({ ok: true, id: fid, premium: isPremiumContent, remaining });
});

// ─── IMAGE/GIF SERVING (non-video) ────────────────────────────────────────────
app.get("/f/:fid", blockDlMgr, (req, res) => {
  const f = getFile(req.params.fid);
  if (!f) return res.status(404).json({ error: "NOT_FOUND" });
  if (f.mimetype.startsWith("video/")) return res.status(410).json({ error: "USE_HLS" });

  let u = null;
  const token = req.cookies && req.cookies["_mu_sess"];
  if (token) { try { const pl = jw.verify(token, JWT_SECRET); u = getUser(pl.username); } catch(e) {} }
  if (!u) return res.status(401).json({ error: "AUTH_REQUIRED" });

  const fp = pt.join(DIRS.uploads, f.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "FILE_MISSING" });
  const stat = fs.statSync(fp);
  res.setHeader("Content-Type", f.mimetype);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `inline; filename="${_0x(f.filename).slice(0,12)}"`);
  res.setHeader("Cache-Control", "no-store, no-cache");
  fs.createReadStream(fp).pipe(res);
});

app.get("/t/:fid", (req, res) => {
  const tp = pt.join(DIRS.thumbs, req.params.fid + "_t.jpg");
  if (!fs.existsSync(tp)) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Content-Type", "image/jpeg");
  fs.createReadStream(tp).pipe(res);
});

app.get("/g/:fid", (req, res) => {
  const gp = pt.join(DIRS.thumbs, req.params.fid + "_g.gif");
  if (!fs.existsSync(gp)) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Content-Type", "image/gif");
  fs.createReadStream(gp).pipe(res);
});

// ─── VIDEO TOKEN ───────────────────────────────────────────────────────────────
app.post("/api/video-token/:fid", authMW, tokenLimiter, (req, res) => {
  const f = getFile(req.params.fid);
  if (!f) return res.status(404).json({ error: "NOT_FOUND" });
  if (!f.mimetype.startsWith("video/")) return res.status(400).json({ error: "NOT_VIDEO" });

  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || req.ip;
  const cfg = getCfg();
  const canFull = ["owner","mod","vip"].includes(req.user.role);
  const isPreview = cfg.premiumEnabled && f.premium && !canFull;

  // Token: her şeyi içeriyor + benzersiz timestamp → tahmin edilemez
  const token = _0x(VIDEO_TOKEN_SECRET + req.user.username + clientIp + f.id + Date.now() + Math.random());
  const expires = Date.now() + (canFull ? 4*60*60*1000 : 30*60*1000);

  videoTokens.set(token, { fid: f.id, username: req.user.username, ip: clientIp, expires, role: req.user.role, isPreview });

  if (videoTokens.size > 2000) {
    const now = Date.now();
    for (const [k, v] of videoTokens.entries()) { if (v.expires < now) videoTokens.delete(k); }
  }

  res.json({ ok: true, token, isPreview });
});

// ─── HLS PLAYLIST ─────────────────────────────────────────────────────────────
// GET /hls/:token/playlist.m3u8
// Token doğrulanır, ffmpeg ile HLS segmentleri üretilir.
// isPreview=true → ffmpeg sadece 15sn encode eder, DAHA FAZLASI OLMAZ
app.get("/hls/:token/playlist.m3u8", blockDlMgr, hlsLimiter, async (req, res) => {
  const { token } = req.params;
  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;

  const td = videoTokens.get(token);
  if (!td) return res.status(401).end();
  if (td.expires < Date.now()) { videoTokens.delete(token); return res.status(401).end(); }

  const ipMatch = td.ip === clientIp || td.ip === clientIp?.replace("::ffff:","") || clientIp === "::ffff:"+td.ip || td.ip === "::1" || clientIp === "::1";
  if (!ipMatch) return res.status(403).end();

  const f = getFile(td.fid);
  if (!f) return res.status(404).end();
  const fp = pt.join(DIRS.uploads, f.filename);
  if (!fs.existsSync(fp)) return res.status(404).end();

  try {
    const session = await generateHlsSession(td.fid, fp, td.isPreview, token);
    f.views = (f.views || 0) + 1;
    saveFile(f);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(session.playlist);
  } catch(e) {
    console.error("[HLS playlist error]", e.message);
    res.status(500).end();
  }
});

// ─── HLS SEGMENT ──────────────────────────────────────────────────────────────
app.get("/hls/:token/:segFile", blockDlMgr, (req, res) => {
  const { token, segFile } = req.params;

  if (!/^[a-zA-Z0-9_-]+\.ts$/.test(segFile)) return res.status(400).end();

  const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
  const td = videoTokens.get(token);
  if (!td || td.expires < Date.now()) return res.status(401).end();

  const ipMatch = td.ip === clientIp || td.ip === clientIp?.replace("::ffff:","") || clientIp === "::ffff:"+td.ip || td.ip === "::1" || clientIp === "::1";
  if (!ipMatch) return res.status(403).end();

  // fid-based cache key (token değil)
  const fidCacheKey = td.fid + ":" + (td.isPreview ? "p" : "f");
  const session = hlsCache.get(fidCacheKey);
  if (!session) return res.status(404).end();

  const segPath = pt.join(DIRS.hls, segFile);
  if (!session.segPaths.includes(segPath)) return res.status(403).end();
  if (!fs.existsSync(segPath)) return res.status(404).end();

  const stat = fs.statSync(segPath);
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Disposition", `inline; filename="${_0x(token+segFile).slice(0,16)}.ts"`);
  fs.createReadStream(segPath).pipe(res);
});

// ─── FILE INFO ────────────────────────────────────────────────────────────────
app.get("/api/file/:fid", authMW, (req, res) => {
  const f = getFile(req.params.fid);
  if (!f) return res.status(404).json({ error: "NOT_FOUND" });
  const cfg = getCfg();
  const canFull = ["owner","mod","vip"].includes(req.user.role);
  res.json({ ok: true, id: f.id, originalName: _2x(f.originalName, DATA_KEY) || "unknown", mimetype: f.mimetype, size: f.size, uploader: f.uploader, uploaded: f.uploaded, premium: f.premium && cfg.premiumEnabled, isPreview: cfg.premiumEnabled && f.premium && !canFull, thumbReady: f.thumbReady, gifReady: f.gifReady, duration: f.duration, views: f.views, downloads: f.downloads });
});

app.get("/api/myfiles", authMW, (req, res) => {
  const d = DB.get("files");
  const files = Object.values(d.list || {}).filter(f => f.uploader === req.user.username).sort((a,b) => b.uploaded - a.uploaded)
    .map(f => ({ id: f.id, originalName: _2x(f.originalName, DATA_KEY) || "file", mimetype: f.mimetype, size: f.size, uploaded: f.uploaded, premium: f.premium, views: f.views || 0 }));
  res.json({ ok: true, files });
});

app.delete("/api/file/:fid", authMW, (req, res) => {
  const f = getFile(req.params.fid);
  if (!f) return res.status(404).json({ error: "NOT_FOUND" });
  if (f.uploader !== req.user.username && !["owner","mod"].includes(req.user.role)) return res.status(403).json({ error: "FORBIDDEN" });
  try { fs.unlinkSync(pt.join(DIRS.uploads, f.filename)); } catch(e) {}
  try { fs.unlinkSync(pt.join(DIRS.thumbs, f.id + "_t.jpg")); } catch(e) {}
  try { fs.unlinkSync(pt.join(DIRS.thumbs, f.id + "_g.gif")); } catch(e) {}
  deleteFile(f.id);
  res.json({ ok: true });
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────
app.get("/api/admin/users", ownerMW, (req, res) => {
  const d = DB.get("users");
  res.json({ ok: true, users: Object.values(d.list || {}).map(u => ({ username: u.username, role: u.role, created: u.created, totalUploads: u.totalUploads || 0, banned: u.banned || false, uploadedToday: u.uploadedToday || 0 })) });
});
app.post("/api/admin/setrole", ownerMW, (req, res) => {
  const { username, role } = req.body;
  if (!ROLES.includes(role)) return res.json({ ok: false, error: "INVALID_ROLE" });
  const u = getUser(username); if (!u) return res.json({ ok: false, error: "USER_NOT_FOUND" });
  u.role = role; saveUser(u); res.json({ ok: true });
});
app.post("/api/admin/ban", ownerMW, (req, res) => {
  const { username, banned } = req.body;
  const u = getUser(username); if (!u) return res.json({ ok: false, error: "USER_NOT_FOUND" });
  u.banned = !!banned; saveUser(u); res.json({ ok: true });
});
app.post("/api/admin/config", ownerMW, (req, res) => {
  const cfg = getCfg();
  const { premiumEnabled, maintenance, maxFreeDaily, maxVipDaily } = req.body;
  if (premiumEnabled !== undefined) cfg.premiumEnabled = !!premiumEnabled;
  if (maintenance !== undefined) cfg.maintenance = !!maintenance;
  if (maxFreeDaily) { cfg.maxFreeDaily = parseInt(maxFreeDaily); LIMITS.free = cfg.maxFreeDaily; }
  if (maxVipDaily) { cfg.maxVipDaily = parseInt(maxVipDaily); LIMITS.vip = cfg.maxVipDaily; }
  saveCfg(cfg); res.json({ ok: true, cfg });
});
app.get("/api/admin/config", ownerMW, (req, res) => res.json({ ok: true, cfg: getCfg() }));
app.get("/api/admin/files", ownerMW, (req, res) => {
  const d = DB.get("files");
  res.json({ ok: true, files: Object.values(d.list || {}).sort((a,b) => b.uploaded - a.uploaded).map(f => ({ id: f.id, originalName: _2x(f.originalName, DATA_KEY) || "file", mimetype: f.mimetype, size: f.size, uploader: f.uploader, uploaded: f.uploaded, premium: f.premium, views: f.views || 0 })) });
});
app.delete("/api/admin/file/:fid", ownerMW, (req, res) => {
  const f = getFile(req.params.fid); if (!f) return res.status(404).json({ error: "NOT_FOUND" });
  try { fs.unlinkSync(pt.join(DIRS.uploads, f.filename)); } catch(e) {}
  try { fs.unlinkSync(pt.join(DIRS.thumbs, f.id + "_t.jpg")); } catch(e) {}
  try { fs.unlinkSync(pt.join(DIRS.thumbs, f.id + "_g.gif")); } catch(e) {}
  deleteFile(f.id); res.json({ ok: true });
});
app.post("/api/admin/setpremium", ownerMW, (req, res) => {
  const { fid, premium } = req.body; const f = getFile(fid);
  if (!f) return res.json({ ok: false, error: "NOT_FOUND" });
  f.premium = !!premium; saveFile(f); res.json({ ok: true });
});
app.post("/api/admin/resetpw", ownerMW, async (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.json({ ok: false, error: "PASS_TOO_SHORT" });
  const u = getUser(username); if (!u) return res.json({ ok: false, error: "USER_NOT_FOUND" });
  u.password = await bc.hash(newPassword, 12); saveUser(u); res.json({ ok: true });
});
app.get("/api/admin/stats", ownerMW, (req, res) => {
  const users = DB.get("users"); const files = DB.get("files");
  const ulist = Object.values(users.list || {}); const flist = Object.values(files.list || {});
  let totalSize = 0; flist.forEach(f => totalSize += f.size || 0);
  res.json({ ok: true, totalUsers: ulist.length, totalFiles: flist.length, totalSize, vipUsers: ulist.filter(u => u.role === "vip").length, modUsers: ulist.filter(u => u.role === "mod").length, bannedUsers: ulist.filter(u => u.banned).length });
});

// ─── WATCH STATS ──────────────────────────────────────────────────────────────
app.post("/api/watch-stat", (req, res) => {
  let username = null;
  const cookieToken = req.cookies && req.cookies["_mu_sess"];
  if (cookieToken) { try { const pl = jw.verify(cookieToken, JWT_SECRET); const u = getUser(pl.username); if (u) username = u.username; } catch(e) {} }
  if (!username && req.body && req.body.vt) { const td = videoTokens.get(req.body.vt); if (td && td.expires > Date.now()) username = td.username; }
  if (!username) return res.status(401).json({ ok: false });
  const { fid, second } = req.body;
  if (!fid || second === undefined || isNaN(second)) return res.json({ ok: false });
  const sec = Math.floor(Number(second));
  if (sec < 0 || sec > 86400) return res.json({ ok: false });
  if (!watchStats.has(fid)) watchStats.set(fid, { byUser: {}, heatmap: {} });
  const ws = watchStats.get(fid);
  if (!ws.byUser[username]) ws.byUser[username] = {};
  ws.byUser[username][sec] = (ws.byUser[username][sec] || 0) + 1;
  ws.heatmap[sec] = (ws.heatmap[sec] || 0) + 1;
  res.json({ ok: true });
});
app.get("/api/admin/watch-stats/:fid", ownerMW, (req, res) => {
  const ws = watchStats.get(req.params.fid);
  if (!ws) return res.json({ ok: true, heatmap: {}, byUser: {} });
  res.json({ ok: true, heatmap: ws.heatmap, byUser: ws.byUser });
});
app.get("/api/admin/watch-stats-all", ownerMW, (req, res) => {
  const result = [];
  for (const [fid, ws] of watchStats.entries()) {
    const f = getFile(fid); const fname = f ? (_2x(f.originalName, DATA_KEY) || "unknown") : fid;
    const topSeconds = Object.entries(ws.heatmap).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([s,c])=>({second:parseInt(s),count:c}));
    result.push({ fid, filename: fname, topSeconds, heatmap: ws.heatmap, byUser: ws.byUser, totalPlays: Object.values(ws.heatmap).reduce((a,b)=>a+b,0) });
  }
  result.sort((a,b)=>b.totalPlays-a.totalPlays);
  res.json({ ok: true, stats: result });
});

app.get("/api/config", (req, res) => { const cfg = getCfg(); res.json({ premiumEnabled: cfg.premiumEnabled, maintenance: cfg.maintenance }); });

app.use((req, res, next) => {
  const cfg = getCfg();
  if (cfg.maintenance) {
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
    if (clientIp !== OWNER_IP && clientIp !== "::ffff:" + OWNER_IP) {
      if (req.path.startsWith("/api/") && !req.path.startsWith("/api/login")) return res.status(503).json({ error: "MAINTENANCE_MODE" });
    }
  }
  next();
});

app.get("*", (req, res) => {
  const htmlPath = pt.join(__dirname, "index.html");
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  res.status(404).send("MetaUpload - index.html not found");
});

app.listen(PORT, () => console.log(`[MetaUpload] HLS-protected server running on :${PORT}`));
