/* ============================================================
   Rios Garden — servidor web + API del chatbot IA (Claude)
   - Sirve la web estática (index.html + assets)
   - Expone POST /api/chat que llama a Claude con la base de
     conocimiento de ia/ como system prompt.
   La API key vive SOLO en la variable de entorno ANTHROPIC_API_KEY.
   ============================================================ */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('⚠️  Falta ANTHROPIC_API_KEY. Configúrala como variable de entorno.');
}

const client = new Anthropic({ apiKey: API_KEY });

/* ---- Base de conocimiento (se lee una vez al arrancar) ---- */
function readIfExists(rel) {
  try { return fs.readFileSync(path.join(__dirname, rel), 'utf8'); }
  catch { return ''; }
}
const MODULO_1 = readIfExists('ia/01-system-prompt-nucleo.md');
const MODULO_2 = readIfExists('ia/02-base-conocimiento-faq.md');
const BASE_CON = readIfExists('ia/base-conocimiento.md');

const SYSTEM_PROMPT = [
  MODULO_1,
  '\n\n===== MÓDULO 2 =====\n', MODULO_2,
  '\n\n===== DATOS DE LA EMPRESA =====\n', BASE_CON,
  '\n\n===== INSTRUCCIONES DE RUNTIME =====',
  '- Responde SIEMPRE en el idioma del cliente (español o inglés).',
  '- Sé breve: 1-4 frases. Nada de textos largos.',
  '- No uses formato Markdown (nada de **, ##, listas con guiones). Texto plano y natural.',
  '- Si no sabes algo o no está en tu base de conocimiento, NO lo inventes: pide al cliente que escriba por WhatsApp al +52 981 108 7410 (https://wa.me/529811087410).',
  '- Cuando el cliente quiera cotización o agendar, invítalo amablemente a continuar por WhatsApp: https://wa.me/529811087410',
  '- HORARIO (regla estricta): atendemos ÚNICAMENTE de lunes a sábado, de 8:00 a.m. a 9:00 p.m. NUNCA digas que trabajamos las 24 horas, ni los 7 días de la semana, ni todo el año, ni "a cualquier hora" — eso es FALSO. Si preguntan por horario o disponibilidad, responde exactamente "lunes a sábado, de 8am a 9pm" y agrega que, en caso de emergencia, pueden comunicarse por WhatsApp para atención prioritaria con un especialista.',
  '- Nunca des información que no esté en tu base de conocimiento. Respeta siempre estos límites.',
].join('\n');

const WA = 'https://wa.me/529811087410';

/* ---- App ---- */
const app = express();
app.use(compression()); // gzip: comprime HTML/CSS/JS (154KB -> ~28KB) para carga rápida

/* CORS para /api: la web vive en el hosting del cliente (riosgarden.com.mx) y llama
   a esta IA en otro dominio (EasyPanel). Sin credenciales/cookies, así que es seguro
   permitir el origen. Se maneja también el preflight OPTIONS del navegador. */
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '128kb' })); /* 12 mensajes × 2000 caracteres con acentos/emojis caben de sobra */

/* Solo se publica la web: index.html, assets/ y los archivos para buscadores.
   Nada de server.js, ia/ (instrucciones internas), node_modules ni .git. */
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  dotfiles: 'deny',
  setHeaders: (res, p) => {
    /* Cache largo para imágenes/video/fuentes; lo demás se revalida */
    if (/\.(jpg|jpeg|png|webp|gif|mp4|ico|woff2?)$/i.test(p)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); /* 30 días */
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/robots.txt': 'robots.txt', '/sitemap.xml': 'sitemap.xml', '/llms.txt': 'llms.txt' };
app.get(Object.keys(PUBLIC_FILES), (req, res, next) => {
  /* Express acepta /INDEX.HTML o /robots.txt/ en estas rutas: solo se sirve la forma exacta */
  const file = PUBLIC_FILES[req.path];
  if (!file) return next();
  res.setHeader('Cache-Control', 'no-cache'); /* HTML sin cache para ver cambios al instante */
  res.sendFile(path.join(__dirname, file));
});

/* IP real: EasyPanel (Traefik) es el único proxy delante y AÑADE la IP del visitante al
   final de X-Forwarded-For. Lo que venga antes lo escribe el propio visitante y no vale. */
app.set('trust proxy', 1);

/* Rate limit simple en memoria: máx 20 peticiones / 5 min por IP, y un tope global
   de 300 / 5 min para que nadie pueda disparar el gasto de la clave rotando IPs. */
const hits = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const allHits = { count: 0, start: Date.now() };
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, start: now };
  if (now - rec.start > WINDOW_MS) { rec.count = 0; rec.start = now; }
  rec.count++;
  hits.set(ip, rec);
  return rec.count > 20;
}
/* El tope global solo cuenta lo que de verdad va a llamar a Claude: así una IP ya
   bloqueada o cuerpos inválidos no pueden dejar sin IA a los demás visitantes. */
function globalLimited() {
  const now = Date.now();
  if (now - allHits.start > WINDOW_MS) { allHits.count = 0; allHits.start = now; }
  return ++allHits.count > 300;
}
// Limpieza periódica del mapa
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now - rec.start > 6 * 60 * 1000) hits.delete(ip);
}, 10 * 60 * 1000).unref();

/* Texto que llega a Claude: sin surrogates sueltos, recortado a 2000 caracteres SIN partir
   emojis, y vacío si solo quedan espacios (Claude lo rechazaría y gastaría el tope global). */
function cleanText(t) {
  const sinSueltos = t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return Array.from(sinSueltos).slice(0, 2000).join('').trim();
}

app.post('/api/chat', async (req, res) => {
  try {
    const ip = req.ip || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'rate_limited', reply: `Has enviado muchos mensajes. Por favor escríbenos por WhatsApp: ${WA}` });
    }

    let { messages, lang } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'bad_request' });
    }
    // Saneado: solo roles válidos, texto, límite de longitud e historial
    const clean = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: cleanText(m.content) }))
      .filter(m => m.content)
      .slice(-12);
    /* La conversación que recibe Claude debe empezar por el cliente: al recortar a 12
       el primero puede quedar de la IA (pasa desde la 7.ª pregunta). */
    while (clean.length && clean[0].role !== 'user') clean.shift();
    if (clean.length === 0 || clean[clean.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'bad_request' });
    }

    if (globalLimited()) {
      return res.status(429).json({ error: 'busy', reply: `En este momento hay muchas consultas. Escríbenos por WhatsApp y te atendemos: ${WA}` });
    }

    const langNote = lang === 'en'
      ? '\n\n(The customer is browsing in English. Reply in English unless they write in Spanish.)'
      : '\n\n(El cliente navega en español. Responde en español salvo que escriba en inglés.)';

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: [{ type: 'text', text: SYSTEM_PROMPT + langNote, cache_control: { type: 'ephemeral' } }],
      messages: clean,
    });

    const reply = (response.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim() || `Escríbenos por WhatsApp y con gusto te atendemos: ${WA}`;

    res.json({ reply });
  } catch (err) {
    console.error('Error /api/chat:', err?.status || '', err?.message || err);
    const badInput = err?.status === 400; /* la API rechazó el contenido: es fallo de la petición, no del servidor */
    res.status(badInput ? 400 : 500).json({
      error: badInput ? 'bad_request' : 'server_error',
      reply: `Disculpa, tuve un problema técnico. Por favor escríbenos por WhatsApp y te atendemos de inmediato: ${WA}`,
    });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, model: MODEL, hasKey: !!API_KEY }));

/* Todo lo demás: 404 (va DESPUÉS de todas las rutas) */
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

/* Errores de Express (JSON roto, cuerpo enorme…): respuesta genérica, sin rutas internas */
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('Error:', err.message);
  res.status(status).json({ error: status === 413 ? 'too_large' : status === 404 ? 'not_found' : 'bad_request' });
});

app.listen(PORT, () => {
  console.log(`Rios Garden IA escuchando en http://localhost:${PORT} — modelo ${MODEL}`);
});
