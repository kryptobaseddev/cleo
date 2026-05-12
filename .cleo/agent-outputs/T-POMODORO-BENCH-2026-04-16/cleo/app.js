/**
 * app.js — wires the pure modules (storage/todos/timer) to the DOM.
 *
 * Responsibilities:
 *   - localStorage persistence via storage module
 *   - render todo list + timer ring
 *   - handle user events + keyboard shortcuts
 *   - WebAudio chime on phase end
 *   - theme resolution (auto | light | dark) with OS media query
 */
import {
  loadState, saveState,
} from './src/storage.js';
import {
  addTodo, editTodo, deleteTodo, toggleComplete,
  incrementSession, findTodo,
} from './src/todos.js';
import {
  createTimerState, toggle, reset, skip,
  tick, computeRemaining, phaseDurationMs, applySettings, formatMs,
} from './src/timer.js';

// ---------- State bootstrap ----------
const store = window.localStorage;
let state = loadState(store);
let timer = createTimerState(state.settings);

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const refs = {
  phase: $('timer-phase'),
  display: $('timer-display'),
  cycle: $('timer-cycle'),
  ring: $('ring-progress'),
  btnStart: $('btn-start'),
  btnReset: $('btn-reset'),
  btnSkip: $('btn-skip'),
  currentTodoTitle: $('current-todo-title'),
  dailyCount: $('daily-count'),
  todoForm: $('todo-form'),
  todoInput: $('new-todo'),
  todoList: $('todo-list'),
  emptyState: $('empty-state'),
  themeToggle: $('theme-toggle'),
  settingsToggle: $('settings-toggle'),
  settingsPanel: $('settings-panel'),
  settingsForm: $('settings-form'),
  settingsClose: $('settings-close'),
  optWork: $('opt-work'),
  optShort: $('opt-short'),
  optLong: $('opt-long'),
  optCadence: $('opt-cadence'),
  liveRegion: $('live-region'),
};

// ---------- Daily counter bookkeeping ----------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function rolloverDaily() {
  const k = todayKey();
  if (state.counters.dailyDate !== k) {
    state.counters.dailyDate = k;
    state.counters.dailyCount = 0;
  }
}
rolloverDaily();

// ---------- Theme ----------
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme || 'auto');
  refs.themeToggle.setAttribute('aria-pressed', state.theme === 'dark' ? 'true' : 'false');
  refs.themeToggle.setAttribute('aria-label', `Theme: ${state.theme}. Click to change.`);
}
function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const idx = order.indexOf(state.theme || 'auto');
  state.theme = order[(idx + 1) % order.length];
  applyTheme();
  persist();
}
applyTheme();

// ---------- Settings form ----------
function loadSettingsIntoForm() {
  refs.optWork.value = state.settings.work;
  refs.optShort.value = state.settings.short;
  refs.optLong.value = state.settings.long;
  refs.optCadence.value = state.settings.cadence;
}
loadSettingsIntoForm();

function toggleSettingsPanel(open) {
  const next = open ?? refs.settingsPanel.hasAttribute('hidden');
  if (next) {
    refs.settingsPanel.removeAttribute('hidden');
    refs.settingsToggle.setAttribute('aria-expanded', 'true');
    refs.optWork.focus();
  } else {
    refs.settingsPanel.setAttribute('hidden', '');
    refs.settingsToggle.setAttribute('aria-expanded', 'false');
  }
}

refs.settingsToggle.addEventListener('click', () => toggleSettingsPanel());
refs.settingsClose.addEventListener('click', () => toggleSettingsPanel(false));
refs.settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const next = {
    work: clampInt(refs.optWork.value, 1, 120, 25),
    short: clampInt(refs.optShort.value, 1, 60, 5),
    long: clampInt(refs.optLong.value, 1, 60, 15),
    cadence: clampInt(refs.optCadence.value, 2, 12, 4),
  };
  state.settings = next;
  timer = applySettings(timer, next);
  persist();
  render();
  announce('Settings saved');
  toggleSettingsPanel(false);
});

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------- Todos ----------
refs.todoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = refs.todoInput.value;
  if (!title.trim()) return;
  state.todos = addTodo(state.todos, title);
  refs.todoInput.value = '';
  // Auto-select newly added if nothing selected.
  if (!state.selectedTodoId) {
    state.selectedTodoId = state.todos[state.todos.length - 1].id;
  }
  persist();
  render();
  announce('Task added');
});

function selectTodo(id) {
  state.selectedTodoId = id;
  persist();
  render();
}

function beginEditTodo(id) {
  const li = refs.todoList.querySelector(`[data-id="${id}"] .todo-title`);
  if (!li) return;
  li.setAttribute('contenteditable', 'true');
  li.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(li);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);

  const commit = () => {
    li.removeAttribute('contenteditable');
    state.todos = editTodo(state.todos, id, li.textContent);
    persist();
    render();
  };
  const cancel = () => {
    li.removeAttribute('contenteditable');
    render();
  };

  li.addEventListener('blur', commit, { once: true });
  li.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
  }, { once: true });
}

function removeTodo(id) {
  state.todos = deleteTodo(state.todos, id);
  if (state.selectedTodoId === id) state.selectedTodoId = null;
  persist();
  render();
  announce('Task deleted');
}

function toggleDone(id) {
  state.todos = toggleComplete(state.todos, id);
  persist();
  render();
}

// ---------- Timer controls ----------
refs.btnStart.addEventListener('click', () => toggleTimer());
refs.btnReset.addEventListener('click', () => {
  timer = reset(timer, state.settings);
  render();
  announce('Timer reset');
});
refs.btnSkip.addEventListener('click', () => {
  timer = skip(timer, state.settings);
  render();
  announce(`Skipped to ${timer.phase}`);
});

function toggleTimer() {
  timer = toggle(timer, Date.now());
  refs.btnStart.textContent = timer.running ? 'Pause' : 'Start';
  render();
}

// ---------- Tick loop ----------
function loop() {
  if (timer.running) {
    const result = tick(timer, state.settings, Date.now());
    timer = result.state;
    if (result.events.length) {
      for (const ev of result.events) {
        if (ev.type === 'phaseEnded') onPhaseEnded(ev);
      }
    }
  }
  render();
  requestAnimationFrame(loop);
}

function onPhaseEnded(ev) {
  playChime(ev.endedPhase);
  if (ev.endedPhase === 'work') {
    // Increment session on the currently-selected todo + daily total.
    if (state.selectedTodoId) {
      state.todos = incrementSession(state.todos, state.selectedTodoId);
    }
    rolloverDaily();
    state.counters.dailyCount = (state.counters.dailyCount | 0) + 1;
  }
  persist();
  refs.btnStart.textContent = 'Start';
  announce(`${labelForPhase(ev.endedPhase)} complete. Next: ${labelForPhase(ev.nextPhase)}.`);
}

// ---------- Render ----------
function render() {
  const total = timer.phaseMs || phaseDurationMs(timer.phase, state.settings);
  const remaining = timer.running ? computeRemaining(timer, Date.now()) : timer.remainingMs;
  const progress = total > 0 ? 1 - remaining / total : 0;
  const CIRC = 2 * Math.PI * 90;
  refs.ring.setAttribute('stroke-dasharray', String(CIRC));
  refs.ring.setAttribute('stroke-dashoffset', String(CIRC * progress));

  refs.phase.textContent = labelForPhase(timer.phase);
  refs.display.textContent = formatMs(remaining);
  document.documentElement.setAttribute('data-phase', timer.phase);

  const cadence = state.settings.cadence || 4;
  const cyclePos = (timer.completedWorkCycles % cadence) + (timer.phase === 'work' ? 1 : 0);
  refs.cycle.textContent = `Cycle ${Math.min(cadence, Math.max(1, cyclePos))} of ${cadence}`;

  const current = findTodo(state.todos, state.selectedTodoId);
  refs.currentTodoTitle.textContent = current ? current.title : '(none selected)';
  refs.dailyCount.textContent = String(state.counters.dailyCount | 0);

  renderTodos();

  document.title = `${formatMs(remaining)} ${labelForPhase(timer.phase)} - Pomodoro Todos`;
}

function renderTodos() {
  const list = refs.todoList;
  // Clear via safe DOM API.
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!state.todos.length) {
    refs.emptyState.hidden = false;
    return;
  }
  refs.emptyState.hidden = true;

  for (const t of state.todos) {
    const li = document.createElement('li');
    li.className = 'todo-item' + (t.done ? ' done' : '') + (t.id === state.selectedTodoId ? ' selected' : '');
    li.dataset.id = t.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'listitem');
    li.setAttribute('aria-selected', t.id === state.selectedTodoId ? 'true' : 'false');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !!t.done;
    check.setAttribute('aria-label', `Mark "${t.title}" ${t.done ? 'active' : 'done'}`);
    check.addEventListener('click', (e) => { e.stopPropagation(); toggleDone(t.id); });

    const title = document.createElement('span');
    title.className = 'todo-title';
    title.textContent = t.title;
    title.addEventListener('dblclick', () => beginEditTodo(t.id));

    const sessions = document.createElement('span');
    sessions.className = 'todo-sessions';
    sessions.setAttribute('aria-label', `${t.sessions || 0} sessions completed`);
    sessions.textContent = `${t.sessions || 0}🍅`;

    const del = document.createElement('button');
    del.className = 'todo-delete';
    del.type = 'button';
    del.setAttribute('aria-label', `Delete ${t.title}`);
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeTodo(t.id); });

    li.append(check, title, sessions, del);
    li.addEventListener('click', () => selectTodo(t.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !title.isContentEditable) {
        e.preventDefault();
        beginEditTodo(t.id);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        removeTodo(t.id);
      } else if (e.key === ' ') {
        e.preventDefault();
        toggleDone(t.id);
      }
    });

    list.appendChild(li);
  }
}

function labelForPhase(phase) {
  return phase === 'short' ? 'Short break' : phase === 'long' ? 'Long break' : 'Work';
}

// ---------- Keyboard shortcuts (global) ----------
document.addEventListener('keydown', (e) => {
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName)
                 || e.target.isContentEditable;
  if (typing && e.key !== 'Escape') {
    return;
  }
  if (e.key === ' ' && !typing) {
    e.preventDefault();
    toggleTimer();
  } else if ((e.key === 'n' || e.key === 'N') && !typing) {
    e.preventDefault();
    refs.todoInput.focus();
  } else if (e.key === 'Enter' && !typing) {
    if (state.selectedTodoId) beginEditTodo(state.selectedTodoId);
  } else if (e.key === 'Delete' && !typing) {
    if (state.selectedTodoId) removeTodo(state.selectedTodoId);
  }
});

refs.themeToggle.addEventListener('click', cycleTheme);

// ---------- Chime (WebAudio) ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx && typeof AudioContext !== 'undefined') {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}
function playChime(endedPhase) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const freqs = endedPhase === 'work' ? [880, 660] : [660, 880];
  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, now + i * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.25 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.25 + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.25);
    osc.stop(now + i * 0.25 + 0.4);
  });
}

// ---------- Persistence + announcements ----------
function persist() { saveState(store, state); }
function announce(msg) { if (refs.liveRegion) refs.liveRegion.textContent = msg; }

// ---------- Boot ----------
loop();
