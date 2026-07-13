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
app.use(express.json({ limit: '32kb' }));
app.use(express.static(__dirname, {
  extensions: ['html'],
  setHeaders: (res, path) => {
    // Cache largo para imágenes/video/fuentes; HTML sin cache para ver cambios al instante
    if (/\.(jpg|jpeg|png|webp|gif|mp4|ico|woff2?)$/i.test(path)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 días
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

/* Rate limit simple en memoria: máx 20 peticiones / 5 min por IP */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const rec = hits.get(ip) || { count: 0, start: now };
  if (now - rec.start > windowMs) { rec.count = 0; rec.start = now; }
  rec.count++;
  hits.set(ip, rec);
  return rec.count > 20;
}
// Limpieza periódica del mapa
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now - rec.start > 6 * 60 * 1000) hits.delete(ip);
}, 10 * 60 * 1000).unref();

app.post('/api/chat', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
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
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (clean.length === 0 || clean[clean.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'bad_request' });
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
    res.status(500).json({
      error: 'server_error',
      reply: `Disculpa, tuve un problema técnico. Por favor escríbenos por WhatsApp y te atendemos de inmediato: ${WA}`,
    });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, model: MODEL, hasKey: !!API_KEY }));

app.listen(PORT, () => {
  console.log(`Rios Garden IA escuchando en http://localhost:${PORT} — modelo ${MODEL}`);
});
