const app = document.querySelector('#root');
const state = {
  user: JSON.parse(localStorage.getItem('quiz_pliz_user') || 'null'),
  socket: null,
  room: null,
  reveal: null,
  selected: [],
  timer: null,
  editor: null,
  activeQuestion: 0,
};

const icons = { back: '←', next: '→', add: '+', play: '▶', save: '✓', delete: '×', logout: '↗', copy: '⧉', users: '◎', trophy: '♛', clock: '◷', image: '▧', check: '✓' };
const esc = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[char]));
const logo = () => '<div class="logo"><span>Q</span>Квиз Плиз</div>';
const alert = (message) => message ? `<div class="alert">${esc(message)}</div>` : '';
const token = () => localStorage.getItem('quiz_pliz_token');

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type':'application/json', ...(token() ? { Authorization:`Bearer ${token()}` } : {}), ...options.headers } });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.error || 'Что-то пошло не так');
  return data;
}

function go(path) { history.pushState({}, '', path); route(); }
function setAuth(payload) { localStorage.setItem('quiz_pliz_token', payload.token); localStorage.setItem('quiz_pliz_user', JSON.stringify(payload.user)); state.user = payload.user; }
function logout() { localStorage.removeItem('quiz_pliz_token'); localStorage.removeItem('quiz_pliz_user'); state.user = null; disconnect(); go('/login'); }
function protectedPage(role) { if (!state.user) { go('/login'); return false; } if (role && state.user.role !== role) { go('/dashboard'); return false; } return true; }
function loader(text = 'Загрузка') { return `<div class="full-loader"><span class="spinner"></span>${text}</div>`; }
function empty(title, text, action) { return `<div class="empty"><div class="empty-icon">${icons.trophy}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`; }

function shell(title, action = '') {
  const user = state.user;
  return `<div class="app-shell"><header class="topbar">${logo()}<div class="profile"><span class="avatar">${esc(user.name[0].toUpperCase())}</span><div><strong>${esc(user.name)}</strong><small>${user.role === 'ORGANIZER' ? 'Организатор' : 'Участник'}</small></div><button class="icon-button" data-action="logout" title="Выйти">${icons.logout}</button></div></header><main class="content"><div class="page-heading"><div><span class="eyebrow">Личный кабинет</span><h1>${esc(title)}</h1></div>${action}</div><div id="page-body">${loader()}</div></main></div>`;
}

function authPage(register) {
  if (state.user) return go('/dashboard');
  app.innerHTML = `<main class="auth-shell"><section class="auth-brand">${logo()}<div class="brand-copy"><h1>Отвечай.<br>Узнавай.<br><em>Выигрывай.</em></h1><p>Создавайте живые квизы и собирайте друзей в одной комнате.</p></div></section><section class="auth-panel"><div class="auth-card"><h2>${register ? 'Создать аккаунт' : 'Войти в Квиз Плиз'}</h2>${register ? '<p>Выберите роль и начните играть.</p>' : ''}${register ? `<div class="segmented"><button type="button" class="active" data-role="PARTICIPANT">Участник</button><button type="button" data-role="ORGANIZER">Организатор</button></div>` : ''}<form id="auth-form">${register ? '<label>Имя<input name="name" required minlength="2" placeholder="Как к вам обращаться"></label>' : ''}<label>Email<input name="email" required type="email" placeholder="name@example.com"></label><label>Пароль<input name="password" required minlength="6" type="password" placeholder="Не менее 6 символов"></label><div id="form-error"></div><button class="primary wide">${register ? 'Создать аккаунт' : 'Войти'} ${icons.next}</button></form><div class="auth-switch">${register ? 'Уже есть аккаунт?' : 'Впервые здесь?'} <a data-link href="${register ? '/login' : '/register'}">${register ? 'Войти' : 'Зарегистрироваться'}</a></div></div></section></main>`;
  let role = 'PARTICIPANT';
  document.querySelectorAll('[data-role]').forEach((button) => button.addEventListener('click', () => { role = button.dataset.role; document.querySelectorAll('[data-role]').forEach((b) => b.classList.toggle('active', b === button)); }));
  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { const payload = await api(`/auth/${register ? 'register' : 'login'}`, { method:'POST', body:JSON.stringify({ name:form.get('name'), email:form.get('email'), password:form.get('password'), role }) }); setAuth(payload); go('/dashboard'); }
    catch (error) { document.querySelector('#form-error').innerHTML = alert(error.message); button.disabled = false; }
  });
}

function sessionHistory(sessions, organizer) {
  return `<section class="quiz-list">${sessions.map((session) => {
    const participant = session.participants.find((item) => item.userId === state.user.id);
    const status = session.status === 'FINISHED' ? 'Завершён' : 'Активная игра';
    const resultsLink = organizer && session.status === 'FINISHED'
      ? `<div class="row-actions"><a data-link class="secondary compact" href="/sessions/${session.id}/results">Результаты ${icons.next}</a></div>`
      : '';
    const result = organizer
      ? `<div class="quiz-score"><strong>${session.participants.length}</strong><span>участников</span></div>${resultsLink}`
      : `<div class="quiz-score"><strong>${participant?.score || 0}</strong><span>баллов</span></div>`;
    return `<article class="quiz-row"><div class="quiz-index">${icons.trophy}</div><div class="quiz-main"><span>Комната ${session.code} · ${status}</span><h3>${esc(session.quiz?.title || 'Квиз')}</h3><p>${new Date(session.createdAt).toLocaleString('ru-RU')}</p></div>${result}</article>`;
  }).join('')}</section>`;
}

async function resultsPage(sessionId) {
  if (!protectedPage('ORGANIZER')) return;
  const back = `<a data-link class="secondary" href="/dashboard">${icons.back} Назад</a>`;
  app.innerHTML = shell('Результаты игры', back);

  try {
    const { session } = await api(`/sessions/${sessionId}`);
    const participants = session.participants.length
      ? session.participants.map((person, index) => `<article><span>${index + 1}</span><strong>${esc(person.name)}</strong><b>${person.score}</b><small>баллов</small></article>`).join('')
      : '<p class="results-empty">В этой игре не было участников.</p>';

    document.querySelector('#page-body').innerHTML = `<section class="results-summary"><div><span class="eyebrow">${esc(session.quiz.category)}</span><h2>${esc(session.quiz.title)}</h2></div><div><span>Код комнаты</span><strong>${session.code}</strong></div><div><span>Дата проведения</span><strong>${new Date(session.finishedAt || session.createdAt).toLocaleString('ru-RU')}</strong></div></section><section class="results-list"><h2>Итоговые баллы</h2><div>${participants}</div></section>`;
  } catch (error) {
    document.querySelector('#page-body').innerHTML = alert(error.message);
  }
}

async function dashboard() {
  if (!protectedPage()) return;
  const organizer = state.user.role === 'ORGANIZER';
  const action = organizer
    ? `<a data-link class="primary" href="/quizzes/new">${icons.add} Создать квиз</a>`
    : `<a data-link class="primary" href="/join">${icons.play} Войти в игру</a>`;
  app.innerHTML = shell(organizer ? 'Мои квизы' : 'История игр', action);

  try {
    const data = await api('/dashboard');
    let content;
    if (organizer) {
      const quizzes = !data.quizzes.length
        ? empty('Здесь появятся ваши квизы', 'Соберите первую игру из вопросов и пригласите участников.', '<a data-link class="secondary" href="/quizzes/new">+ Создать первый квиз</a>')
        : `<section class="quiz-list">${data.quizzes.map((quiz) => `<article class="quiz-row"><div class="quiz-index">${quiz.questions.length}</div><div class="quiz-main"><span>${esc(quiz.category)}</span><h3>${esc(quiz.title)}</h3></div><div class="quiz-meta"><span>${icons.clock} ${quiz.questions.reduce((sum, question) => sum + question.duration, 0)} сек</span><span>${new Date(quiz.updatedAt).toLocaleDateString('ru-RU')}</span></div><div class="row-actions"><a data-link class="icon-button" title="Редактировать" href="/quizzes/${quiz.id}/edit">✎</a><button class="icon-button danger" data-delete="${quiz.id}" title="Удалить">${icons.delete}</button><a data-link class="primary compact" href="/quizzes/${quiz.id}/launch">${icons.play} Запустить</a></div></article>`).join('')}</section>`;
      const conducted = data.sessions.length
        ? `<section class="history-section"><span class="eyebrow">История проведения</span><h2>Последние игры</h2>${sessionHistory(data.sessions, true)}</section>`
        : '';
      content = quizzes + conducted;
    } else {
      content = !data.sessions.length
        ? empty('История пока пуста', 'Введите код комнаты и сыграйте в свой первый квиз.', '<a data-link class="secondary" href="/join">Войти по коду</a>')
        : sessionHistory(data.sessions, false);
    }
    document.querySelector('#page-body').innerHTML = content;
    document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
      if (confirm('Удалить этот квиз?')) {
        await api(`/quizzes/${button.dataset.delete}`, { method:'DELETE' });
        dashboard();
      }
    }));
  } catch (error) {
    document.querySelector('#page-body').innerHTML = alert(error.message);
  }
}

const blankQuestion = () => ({ text:'', image:null, type:'SINGLE', duration:20, points:1, options:[{ text:'', correct:true },{ text:'', correct:false },{ text:'', correct:false },{ text:'', correct:false }] });

async function editor(quizId) {
  if (!protectedPage('ORGANIZER')) return; state.activeQuestion = 0; state.editor = { title:'', category:'Общие знания', questions:[blankQuestion()] };
  if (quizId) { app.innerHTML = loader(); try { state.editor = (await api(`/quizzes/${quizId}`)).quiz; } catch (error) { app.innerHTML = alert(error.message); return; } }
  renderEditor(quizId);
}

function syncEditor() {
  const quiz = state.editor; const q = quiz.questions[state.activeQuestion];
  const title = document.querySelector('[name="quiz-title"]'); if (title) quiz.title = title.value;
  const category = document.querySelector('[name="category"]'); if (category) quiz.category = category.value;
  const text = document.querySelector('[name="question-text"]'); if (text) q.text = text.value;
  const duration = document.querySelector('[name="duration"]'); if (duration) q.duration = Number(duration.value);
  const points = document.querySelector('[name="points"]'); if (points) q.points = Number(points.value);
  document.querySelectorAll('[data-option-text]').forEach((input) => q.options[Number(input.dataset.optionText)].text = input.value);
}

function renderEditor(quizId) {
  const quiz = state.editor; const q = quiz.questions[state.activeQuestion];
  app.innerHTML = `<div class="editor-shell"><header class="editor-top"><a data-link class="icon-button" href="/dashboard">${icons.back}</a><div><input name="quiz-title" class="title-input" value="${esc(quiz.title)}" placeholder="Название квиза"><span>${quiz.questions.length} вопросов</span></div><button class="primary" data-action="save-quiz">${icons.save} Сохранить</button></header><div class="editor-layout"><aside class="question-nav"><div class="nav-label">Вопросы</div>${quiz.questions.map((item,index) => `<button class="${state.activeQuestion === index ? 'active' : ''}" data-question="${index}"><span>${index + 1}</span><div><strong>${esc(item.text || 'Новый вопрос')}</strong><small>${item.duration} сек. · ${item.points ?? 1} б.</small></div><b>${icons.next}</b></button>`).join('')}<button class="add-question" data-action="add-question">+ Добавить вопрос</button></aside><main class="editor-canvas"><div class="editor-heading"><div><span class="eyebrow">Вопрос ${state.activeQuestion + 1}</span><h2>Содержание и ответы</h2></div><button class="icon-button danger" data-action="delete-question" ${quiz.questions.length === 1 ? 'disabled' : ''}>${icons.delete}</button></div><div id="editor-error"></div><div class="question-form"><label>Текст вопроса<textarea name="question-text" placeholder="Например: Какая планета ближе всего к Солнцу?">${esc(q.text)}</textarea></label><div class="field-row question-settings"><label>Категория<input name="category" value="${esc(quiz.category)}"></label><label>Время на ответ<div class="number-field"><input name="duration" type="number" min="5" max="120" value="${q.duration}"><span>сек.</span></div></label><label>Баллы за вопрос<div class="number-field"><input name="points" type="number" min="0.1" max="100" step="0.1" value="${q.points ?? 1}"><span>б.</span></div></label></div><div class="field-row"><label>Тип ответа<div class="segmented compact"><button type="button" data-type="SINGLE" class="${q.type === 'SINGLE' ? 'active' : ''}">Один вариант</button><button type="button" data-type="MULTIPLE" class="${q.type === 'MULTIPLE' ? 'active' : ''}">Несколько</button></div></label><label class="image-field">Изображение<div><input id="image-upload" type="file" accept="image/*">${icons.image} ${q.image ? 'Заменить' : 'Добавить изображение'}</div></label></div>${q.image ? `<div class="image-preview"><img src="${q.image}" alt="Иллюстрация"><button class="icon-button" data-action="remove-image">${icons.delete}</button></div>` : ''}<div class="answers-head"><div><span class="eyebrow">Варианты ответа</span><p>Отметьте правильный вариант слева.</p></div></div><div class="answer-editor">${q.options.map((option,index) => `<div class="answer-edit ${option.correct ? 'correct' : ''}"><button class="correct-toggle" data-correct="${index}">${option.correct ? icons.check : ''}</button><span class="letter">${String.fromCharCode(65 + index)}</span><input data-option-text="${index}" value="${esc(option.text)}" placeholder="Вариант ${index + 1}"></div>`).join('')}</div></div></main></div></div>`;
  document.querySelectorAll('[data-question]').forEach((button) => button.addEventListener('click', () => { syncEditor(); state.activeQuestion = Number(button.dataset.question); renderEditor(quizId); }));
  document.querySelector('[data-action="add-question"]').addEventListener('click', () => { syncEditor(); quiz.questions.push(blankQuestion()); state.activeQuestion = quiz.questions.length - 1; renderEditor(quizId); });
  document.querySelector('[data-action="delete-question"]').addEventListener('click', () => { if (quiz.questions.length > 1) { quiz.questions.splice(state.activeQuestion, 1); state.activeQuestion = Math.max(0, state.activeQuestion - 1); renderEditor(quizId); } });
  document.querySelectorAll('[data-type]').forEach((button) => button.addEventListener('click', () => { syncEditor(); q.type = button.dataset.type; if (q.type === 'SINGLE') q.options.forEach((o,i) => o.correct = i === 0); renderEditor(quizId); }));
  document.querySelectorAll('[data-correct]').forEach((button) => button.addEventListener('click', () => { syncEditor(); const index = Number(button.dataset.correct); if (q.type === 'SINGLE') q.options.forEach((o,i) => o.correct = i === index); else q.options[index].correct = !q.options[index].correct; renderEditor(quizId); }));
  document.querySelector('#image-upload').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; if (file.size > 2_000_000) return document.querySelector('#editor-error').innerHTML = alert('Изображение должно быть меньше 2 МБ'); const reader = new FileReader(); reader.onload = () => { syncEditor(); q.image = reader.result; renderEditor(quizId); }; reader.readAsDataURL(file); });
  document.querySelector('[data-action="remove-image"]')?.addEventListener('click', () => { syncEditor(); q.image = null; renderEditor(quizId); });
  document.querySelector('[data-action="save-quiz"]').addEventListener('click', async () => { syncEditor(); const button = document.querySelector('[data-action="save-quiz"]'); button.disabled = true; try { await api(quizId ? `/quizzes/${quizId}` : '/quizzes', { method:quizId ? 'PUT':'POST', body:JSON.stringify(quiz) }); go('/dashboard'); } catch (error) { document.querySelector('#editor-error').innerHTML = alert(error.message); button.disabled = false; } });
}

async function launch(quizId) {
  if (!protectedPage('ORGANIZER')) return; app.innerHTML = shell('Создаём комнату');
  try { const { session } = await api(`/quizzes/${quizId}/sessions`, { method:'POST' }); go(`/host/${session.id}`); } catch (error) { document.querySelector('#page-body').innerHTML = alert(error.message); }
}

function joinPage() {
  if (!protectedPage()) return;
  app.innerHTML = `<main class="join-shell"><header>${logo()}<a data-link href="/dashboard">${icons.back} В кабинет</a></header><section class="join-content"><span class="eyebrow">Подключение к игре</span><h1>Введите код<br>комнаты</h1><p>Шесть цифр отображаются на экране ведущего.</p><form id="join-form"><input name="code" autofocus maxlength="6" placeholder="000000"><div id="join-error"></div><button class="primary wide">Присоединиться ${icons.next}</button></form></section><div class="join-art"><div class="ring ring-one"></div><div class="ring ring-two"></div><b>${icons.trophy}</b></div></main>`;
  const input = document.querySelector('[name="code"]'); input.addEventListener('input', () => input.value = input.value.replace(/\D/g,'')); document.querySelector('#join-form').addEventListener('submit', (event) => { event.preventDefault(); if (!/^\d{6}$/.test(input.value)) document.querySelector('#join-error').innerHTML = alert('Введите шестизначный код'); else go(`/play/${input.value}`); });
}

function disconnect() { clearInterval(state.timer); if (state.socket) state.socket.close(); state.socket = null; state.room = null; state.reveal = null; state.selected = []; }
async function leaveQuiz() {
  try { if (state.room && state.send) await state.send('room:leave'); } catch {}
  disconnect(); go('/dashboard');
}
function connect(joinData, host) {
  disconnect(); app.innerHTML = gameFrame(loader('Подключаемся'));
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token())}`); state.socket = ws; const pending = new Map(); let seq = 0;
  ws.onopen = () => send('room:join', joinData).catch((error) => app.innerHTML = gameFrame(alert(error.message)));
  ws.onmessage = (event) => { const message = JSON.parse(event.data); if (message.replyTo) { const item = pending.get(message.replyTo); if (item) { pending.delete(message.replyTo); message.ok ? item.resolve(message) : item.reject(new Error(message.error)); } return; } if (message.event === 'room:state') { const previous = state.room?.session.currentQuestion; state.room = message.data; if (previous !== state.room.session.currentQuestion) state.selected = []; renderRoom(host); } else if (message.event === 'question:reveal') { state.reveal = message.data; renderRoom(host); } else if (message.event === 'quiz:finished') { state.reveal = { finished:true, ...message.data }; renderRoom(host); } else if (message.event === 'error') showRoomError(message.data.message); };
  ws.onclose = () => { if (state.room && state.room.session.status !== 'FINISHED') showRoomError('Соединение с комнатой потеряно'); };
  function send(event, data = {}) { return new Promise((resolve,reject) => { const id = ++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({ id,event,data })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Сервер не ответил')); } }, 6000); }); }
  state.send = send;
}

function gameFrame(content) { return `<main class="game-shell"><header class="game-top">${logo()}<button class="leave-quiz" data-action="leave-quiz">Покинуть квиз <b>×</b></button></header><div class="game-content">${content}</div></main>`; }
function showRoomError(message) { const node = document.querySelector('#room-error'); if (node) node.innerHTML = alert(message); }
function people(list) { return list.map((p) => `<span>${esc(p.name)}</span>`).join(''); }
function leader(title, list) { return `<section class="leaderboard"><span class="eyebrow">Лидерборд</span><h1>${esc(title)}</h1><div>${list.map((person,index) => `<article><span class="place p${index + 1}">${index + 1}</span><strong>${esc(person.name)}</strong><b>${person.score}</b><small>баллов</small></article>`).join('')}</div></section>`; }
function final(host) { const room = state.room; return `<div class="final"><b class="result-mark">${icons.trophy}</b><span class="eyebrow">Квиз завершён</span><h1>${esc(room.quiz.title)}</h1><p>Победители определены. Отличная игра!</p></div>${leader('Итоговые места', state.reveal?.leaderboard || room.participants)}<a data-link class="secondary game-action" href="/dashboard">${host ? 'Вернуться к квизам' : 'В личный кабинет'} ${icons.next}</a>`; }

function questionView(room, host, reveal = false) {
  const q = room.question; if (!q) return loader();
  const selected = reveal ? room.selectedOptionIds : state.selected;
  const header = reveal ? `<header class="reveal-heading"><span>Верный ответ</span><strong>Вопрос ${room.session.currentQuestion + 1} из ${room.quiz.questionCount}</strong></header>` : `<header><span>Вопрос ${room.session.currentQuestion + 1} из ${room.quiz.questionCount}</span><div class="timer" id="question-timer">${icons.clock} <b>${q.duration}</b></div><span>${q.type === 'MULTIPLE' ? 'Несколько ответов' : 'Один ответ'} · ${q.points ?? 1} б.</span></header>`;
  return `<section class="question-view ${reveal ? 'question-reveal' : ''}">${header}<div class="question-body ${q.image ? 'with-image' : ''}"><div><span class="eyebrow">${esc(room.quiz.category)}</span><h1>${esc(q.text)}</h1></div>${q.image ? `<img src="${q.image}" alt="Изображение к вопросу">` : ''}</div><div class="answer-grid ${reveal ? 'reveal-grid' : ''}">${q.options.map((option,index) => { const correct = reveal && room.correctOptionIds.includes(option.id); const wrong = reveal && selected.includes(option.id) && !correct; return `<button data-answer="${option.id}" ${(host || reveal) ? 'disabled' : ''} class="${correct ? 'correct-answer' : wrong ? 'wrong-answer' : selected.includes(option.id) ? 'selected' : ''}"><span>${String.fromCharCode(65 + index)}</span><strong>${esc(option.text)}</strong>${correct ? `<b>${icons.check}</b>` : wrong ? '<b>×</b>' : selected.includes(option.id) ? `<b>${icons.check}</b>` : ''}</button>`; }).join('')}</div></section>`;
}

function startTimer() { clearInterval(state.timer); const update = () => { const room = state.room; const node = document.querySelector('#question-timer'); if (!node || !room?.question) return; const remaining = Math.max(0, Math.ceil((room.session.questionStartedAt + room.question.duration * 1000 - Date.now()) / 1000)); node.innerHTML = `${icons.clock} <b>${remaining}</b>`; node.classList.toggle('urgent', remaining <= 5); }; update(); state.timer = setInterval(update, 250); }

function renderRoom(host) {
  const room = state.room; if (!room) return; const status = room.session.status; let content = '';
  if (status === 'LOBBY') content = host ? `<div class="host-lobby"><span class="eyebrow">Комната готова</span><h1>${esc(room.quiz.title)}</h1><p>Участники входят по коду</p><button class="room-code" data-action="copy-code">${room.session.code} ${icons.copy}</button><div class="participant-strip"><b>${icons.users}</b><strong>${room.participants.length}</strong><span>участников в комнате</span></div><div class="people">${people(room.participants)}</div><div id="room-error"></div><button class="primary huge" data-event="quiz:start" ${room.participants.length ? '' : 'disabled'}>${icons.play} Начать квиз</button></div>` : `<div class="waiting"><div class="pulse">${icons.play}</div><span class="eyebrow">Вы в комнате ${room.session.code}</span><h1>Ждём ведущего</h1><p>${esc(room.quiz.title)}</p><div class="participant-strip"><b>${icons.users}</b><strong>${room.participants.length}</strong><span>уже подключились</span></div><div id="room-error"></div></div>`;
  else if (status === 'FINISHED' || state.reveal?.finished) content = final(host);
  else if (status === 'REVEAL') content = `${questionView(room, true, true)}<div id="room-error"></div>${host ? `<button class="primary huge game-action" data-event="leaderboard:show">Показать баллы участников ${icons.next}</button>` : `<div class="submitted">Ведущий скоро покажет баллы</div>`}`;
  else if (status === 'SCORES') content = `${leader('Баллы участников', room.participants)}<div id="room-error"></div>${host ? `<button class="primary huge game-action" data-event="quiz:next">${room.session.currentQuestion + 1 === room.quiz.questionCount ? 'Показать итоги' : 'Следующий вопрос'} ${icons.next}</button>` : `<div class="submitted">Ждём следующего вопроса</div>`}`;
  else content = host ? `${questionView(room,true)}<div class="host-progress">${icons.users} В комнате: <strong>${room.participants.length}</strong></div><div id="room-error"></div><button class="primary huge game-action" data-event="question:close">Завершить вопрос ${icons.next}</button>` : `${questionView(room,false)}<div id="room-error"></div>${room.submitted ? `<div class="submitted">${icons.check} Ответ принят. Ждём остальных.</div>` : `<button class="primary huge game-action" data-action="submit-answer" ${state.selected.length ? '' : 'disabled'}>Ответить ${icons.next}</button>`}`;
  app.innerHTML = gameFrame(content); bindRoom(host); if (status === 'QUESTION') startTimer();
}

function bindRoom(host) {
  document.querySelector('[data-action="copy-code"]')?.addEventListener('click', () => navigator.clipboard.writeText(state.room.session.code));
  document.querySelectorAll('[data-event]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await state.send(button.dataset.event); } catch (error) { showRoomError(error.message); button.disabled = false; } }));
  document.querySelectorAll('[data-answer]').forEach((button) => button.addEventListener('click', () => { const id = button.dataset.answer; const q = state.room.question; state.selected = q.type === 'SINGLE' ? [id] : state.selected.includes(id) ? state.selected.filter((x) => x !== id) : [...state.selected,id]; renderRoom(host); }));
  document.querySelector('[data-action="submit-answer"]')?.addEventListener('click', async (event) => { event.currentTarget.disabled = true; try { await state.send('answer:submit', { optionIds:state.selected }); } catch (error) { showRoomError(error.message); event.currentTarget.disabled = false; } });
}

function hostRoom(sessionId) { if (!protectedPage('ORGANIZER')) return; connect({ sessionId }, true); }
function playRoom(code) { if (!protectedPage()) return; connect({ code }, false); }

function route() {
  clearInterval(state.timer); const path = location.protocol === 'file:' ? '/register' : location.pathname; let match;
  if (path === '/' || path === '/dashboard') return dashboard();
  if (path === '/login') return authPage(false); if (path === '/register') return authPage(true); if (path === '/join') return joinPage(); if (path === '/quizzes/new') return editor();
  if ((match = path.match(/^\/quizzes\/([^/]+)\/edit$/))) return editor(match[1]);
  if ((match = path.match(/^\/quizzes\/([^/]+)\/launch$/))) return launch(match[1]);
  if ((match = path.match(/^\/sessions\/([^/]+)\/results$/))) return resultsPage(match[1]);
  if ((match = path.match(/^\/host\/([^/]+)$/))) return hostRoom(match[1]);
  if ((match = path.match(/^\/play\/(\d{6})$/))) return playRoom(match[1]);
  go('/dashboard');
}

document.addEventListener('click', (event) => { const link = event.target.closest('a[data-link]'); if (link && link.origin === location.origin) { event.preventDefault(); disconnect(); go(link.pathname); } if (event.target.closest('[data-action="logout"]')) logout(); if (event.target.closest('[data-action="leave-quiz"]')) leaveQuiz(); });
window.addEventListener('popstate', () => { disconnect(); route(); });
route();
