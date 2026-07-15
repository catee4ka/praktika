import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import { createToken, hashPassword, readToken, verifyPassword } from './native-auth.js';
import { validateQuiz } from './quiz-validation.js';
import { calculateScore, isCorrectAnswer } from './scoring.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(globalThis.process?.env?.PORT || 3001);
const sockets = new Set();
const uid = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const code = () => String(Math.floor(100000 + Math.random() * 900000));

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body == null ? '' : JSON.stringify(body));
}

async function body(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 5_000_000) throw new Error('Слишком большой запрос');
  }
  return value ? JSON.parse(value) : {};
}

function auth(req) {
  return readToken(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
}

function safeUser({ passwordHash, ...user }) { return user; }
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function leaderboard(session) {
  return session.participants.map((p) => ({ id: p.id, userId: p.userId, name: p.name, score: p.score || 0 })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function stateFor(session, userId) {
  const quiz = store.quizzes.find((q) => q.id === session.quizId);
  const current = quiz.questions[session.currentQuestion];
  const participant = session.participants.find((p) => p.userId === userId);
  const participantAnswer = current && session.answers.find((answer) => answer.questionId === current.id && answer.participantId === participant?.id);
  const question = current && ['QUESTION', 'REVEAL'].includes(session.status) ? { ...current, options: current.options.map(({ correct, ...o }) => o) } : null;
  const scoresVisible = ['SCORES', 'FINISHED'].includes(session.status);
  const participants = scoresVisible ? leaderboard(session) : session.participants.map((item) => ({ id: item.id, userId: item.userId, name: item.name }));
  return {
    session: { id: session.id, code: session.code, status: session.status, currentQuestion: session.currentQuestion, questionStartedAt: session.questionStartedAt },
    quiz: { id: quiz.id, title: quiz.title, category: quiz.category, questionCount: quiz.questions.length },
    participants,
    question,
    correctOptionIds: session.status === 'REVEAL' && current ? current.options.filter((option) => option.correct).map((option) => option.id) : [],
    selectedOptionIds: session.status === 'REVEAL' ? participantAnswer?.optionIds || [] : [],
    submitted: Boolean(participantAnswer),
  };
}

function wsSend(socket, data) {
  if (socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(data));
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  socket.write(Buffer.concat([header, payload]));
}

function broadcast(session, event = 'room:state', payload) {
  for (const client of sockets) if (client.sessionId === session.id) wsSend(client.socket, { event, data: payload ?? stateFor(session, client.user.id) });
}

function parseFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0]; let length = client.buffer[1] & 0x7f; let offset = 2;
    if ((first & 0x0f) === 8) { client.socket.end(); return; }
    if (length === 126) { if (client.buffer.length < 4) return; length = client.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (client.buffer.length < 10) return; length = Number(client.buffer.readBigUInt64BE(2)); offset = 10; }
    const masked = Boolean(client.buffer[1] & 0x80); if (masked) offset += 4;
    if (client.buffer.length < offset + length) return;
    let payload = client.buffer.subarray(offset, offset + length);
    if (masked) { const mask = client.buffer.subarray(offset - 4, offset); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
    client.buffer = client.buffer.subarray(offset + length);
    try { onMessage(client, JSON.parse(payload.toString())); } catch (error) { wsSend(client.socket, { event: 'error', data: { message: error.message } }); }
  }
}

function onMessage(client, message) {
  const reply = (ok = true, error) => wsSend(client.socket, { replyTo: message.id, ok, error });
  if (message.event === 'room:join') {
    const session = store.sessions.find((s) => s.id === message.data.sessionId || s.code === String(message.data.code));
    if (!session) return reply(false, 'Комната не найдена');
    const user = store.users.find((u) => u.id === client.user.id);
    if (session.hostId !== user.id) {
      if (session.status === 'FINISHED') return reply(false, 'Квиз уже завершён');
      if (!session.participants.some((p) => p.userId === user.id)) session.participants.push({ id: uid(), userId: user.id, name: user.name, score: 0, joinedAt: timestamp() });
    }
    client.sessionId = session.id; store.save(); reply(); broadcast(session); return;
  }
  const session = store.sessions.find((s) => s.id === client.sessionId);
  if (!session) return reply(false, 'Сначала войдите в комнату');
  const quiz = store.quizzes.find((q) => q.id === session.quizId);
  if (message.event === 'room:leave') {
    if (session.status === 'LOBBY' && session.hostId !== client.user.id) {
      const participantIndex = session.participants.findIndex((participant) => participant.userId === client.user.id);
      if (participantIndex >= 0) session.participants.splice(participantIndex, 1);
    }
    client.sessionId = null;
    store.save(); reply(); broadcast(session); return;
  } else if (message.event === 'quiz:start') {
    if (session.hostId !== client.user.id || !session.participants.length) return reply(false, 'Недостаточно прав или нет участников');
    session.status = 'QUESTION'; session.currentQuestion = 0; session.questionStartedAt = Date.now();
  } else if (message.event === 'answer:submit') {
    const question = quiz.questions[session.currentQuestion]; const participant = session.participants.find((p) => p.userId === client.user.id);
    if (session.status !== 'QUESTION' || !participant) return reply(false, 'Ответ сейчас недоступен');
    if (Date.now() > session.questionStartedAt + question.duration * 1000 + 1000) return reply(false, 'Время вышло');
    if (session.answers.some((a) => a.questionId === question.id && a.participantId === participant.id)) return reply(false, 'Ответ уже принят');
    const selected = Array.isArray(message.data.optionIds) ? [...new Set(message.data.optionIds)] : [];
    if (!selected.length || selected.some((answer) => !question.options.some((o) => o.id === answer))) return reply(false, 'Выберите вариант ответа');
    const correct = isCorrectAnswer(question, selected); const score = calculateScore({ question, selectedIds: selected });
    session.answers.push({ id: uid(), participantId: participant.id, questionId: question.id, optionIds: selected, correct, score, createdAt: timestamp() }); participant.score += score;
    participant.score = Math.round(participant.score * 100) / 100;
  } else if (message.event === 'question:close') {
    if (session.hostId !== client.user.id || session.status !== 'QUESTION') return reply(false, 'Недостаточно прав');
    session.status = 'REVEAL'; const question = quiz.questions[session.currentQuestion];
    broadcast(session, 'question:reveal', { correctOptionIds: question.options.filter((o) => o.correct).map((o) => o.id) });
  } else if (message.event === 'leaderboard:show') {
    if (session.hostId !== client.user.id || session.status !== 'REVEAL') return reply(false, 'Недостаточно прав');
    session.status = 'SCORES';
  } else if (message.event === 'quiz:next') {
    if (session.hostId !== client.user.id || session.status !== 'SCORES') return reply(false, 'Недостаточно прав');
    if (++session.currentQuestion >= quiz.questions.length) { session.currentQuestion--; session.status = 'FINISHED'; session.finishedAt = timestamp(); broadcast(session, 'quiz:finished', { leaderboard: leaderboard(session) }); }
    else { session.status = 'QUESTION'; session.questionStartedAt = Date.now(); }
  } else return reply(false, 'Неизвестная команда');
  store.save(); reply(); broadcast(session);
}

async function api(req, res, url) {
  const route = url.pathname; const method = req.method;
  if (route === '/api/health') return json(res, 200, { ok: true });
  if (route === '/api/auth/register' && method === 'POST') {
    const input = await body(req); input.email = input.email?.trim().toLowerCase();
    if (!input.name?.trim() || !/^\S+@\S+\.\S+$/.test(input.email) || input.password?.length < 6 || !['ORGANIZER','PARTICIPANT'].includes(input.role)) fail('Проверьте данные регистрации');
    if (store.users.some((u) => u.email === input.email)) fail('Этот email уже зарегистрирован', 409);
    const user = { id: uid(), name: input.name.trim(), email: input.email, role: input.role, passwordHash: hashPassword(input.password), createdAt: timestamp() };
    store.users.push(user); store.save(); return json(res, 201, { token: createToken(user), user: safeUser(user) });
  }
  if (route === '/api/auth/login' && method === 'POST') {
    const input = await body(req); const user = store.users.find((u) => u.email === input.email?.trim().toLowerCase());
    if (!user || !verifyPassword(input.password || '', user.passwordHash)) fail('Неверный email или пароль', 401);
    return json(res, 200, { token: createToken(user), user: safeUser(user) });
  }
  const tokenUser = auth(req);
  const user = store.users.find((item) => item.id === tokenUser.id);
  if (!user) fail('Необходима авторизация', 401);
  if (route === '/api/me') return json(res, 200, { user: safeUser(user) });
  if (route === '/api/dashboard') {
    const quizzes = store.quizzes
      .filter((quiz) => quiz.ownerId === user.id)
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    const sessions = store.sessions
      .filter((session) => user.role === 'ORGANIZER' ? session.hostId === user.id : session.participants.some((participant) => participant.userId === user.id))
      .sort((a, b) => (b.finishedAt || b.createdAt).localeCompare(a.finishedAt || a.createdAt))
      .map((session) => {
        const quiz = store.quizzes.find((item) => item.id === session.quizId);
        return { ...session, quiz: quiz ? { id: quiz.id, title: quiz.title, category: quiz.category } : null };
      });
    return json(res, 200, { quizzes, sessions });
  }
  let match = route.match(/^\/api\/sessions\/([^/]+)$/);
  if (match && method === 'GET') {
    if (user.role !== 'ORGANIZER') fail('Только для организатора', 403);
    const session = store.sessions.find((item) => item.id === match[1] && item.hostId === user.id);
    if (!session) fail('Игра не найдена', 404);
    const quiz = store.quizzes.find((item) => item.id === session.quizId);
    return json(res, 200, { session: {
      id: session.id,
      code: session.code,
      status: session.status,
      createdAt: session.createdAt,
      finishedAt: session.finishedAt,
      participants: leaderboard(session),
      quiz: quiz ? { id: quiz.id, title: quiz.title, category: quiz.category } : { id: '', title: 'Квиз', category: '' },
    } });
  }
  if (route === '/api/quizzes' && method === 'POST') {
    if (user.role !== 'ORGANIZER') fail('Только для организатора', 403); const input = await body(req); validateQuiz(input);
    const quiz = { id: uid(), ownerId: user.id, title: input.title.trim(), category: input.category.trim(), createdAt: timestamp(), updatedAt: timestamp(), questions: input.questions.map((q, order) => ({ ...q, id: q.id || uid(), order, options: q.options.map((o) => ({ ...o, id: o.id || uid() })) })) };
    store.quizzes.push(quiz); store.save(); return json(res, 201, { quiz });
  }
  match = route.match(/^\/api\/quizzes\/([^/]+)$/);
  if (match) {
    const quiz = store.quizzes.find((q) => q.id === match[1] && q.ownerId === user.id); if (!quiz) fail('Квиз не найден', 404);
    if (method === 'GET') return json(res, 200, { quiz });
    if (method === 'DELETE') {
      if (store.sessions.some((session) => session.quizId === quiz.id)) fail('Нельзя удалить квиз с сохранённой историей игр', 409);
      store.quizzes.splice(store.quizzes.indexOf(quiz), 1); store.save(); return json(res, 204);
    }
    if (method === 'PUT') { const input = await body(req); validateQuiz(input); Object.assign(quiz, { title: input.title.trim(), category: input.category.trim(), updatedAt: timestamp(), questions: input.questions.map((q, order) => ({ ...q, id: q.id || uid(), order, options: q.options.map((o) => ({ ...o, id: o.id || uid() })) })) }); store.save(); return json(res, 200, { quiz }); }
  }
  match = route.match(/^\/api\/quizzes\/([^/]+)\/sessions$/);
  if (match && method === 'POST') {
    const quiz = store.quizzes.find((q) => q.id === match[1] && q.ownerId === user.id); if (!quiz) fail('Квиз не найден', 404);
    let room; do room = code(); while (store.sessions.some((s) => s.code === room && s.status !== 'FINISHED'));
    const session = { id: uid(), quizId: quiz.id, hostId: user.id, code: room, status: 'LOBBY', currentQuestion: -1, questionStartedAt: null, participants: [], answers: [], createdAt: timestamp(), finishedAt: null };
    store.sessions.push(session); store.save(); return json(res, 201, { session, quiz });
  }
  fail('Маршрут не найден', 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const candidate = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const file = path.resolve(root, candidate);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return serveIndex(res);
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
  } catch (error) { json(res, error.message === 'AUTH_REQUIRED' ? 401 : error.status || 500, { error: error.message === 'AUTH_REQUIRED' ? 'Необходима авторизация' : error.message }); }
});
function serveIndex(res) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(path.join(root, 'index.html')).pipe(res); }

server.on('upgrade', (req, socket) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`); if (url.pathname !== '/ws') return socket.destroy(); const user = readToken(url.searchParams.get('token'));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = { socket, user, sessionId: null, buffer: Buffer.alloc(0) }; sockets.add(client); socket.on('data', (chunk) => parseFrames(client, chunk)); socket.on('close', () => sockets.delete(client)); socket.on('error', () => sockets.delete(client));
  } catch { socket.destroy(); }
});

server.listen(port, '0.0.0.0', () => console.log(`Сервер запущен на порту ${port}`));
