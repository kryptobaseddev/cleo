// @ts-check
/**
 * App entry — wires DOM to store + timer + theme modules.
 * Kept small and procedural on purpose: the domain logic lives in store.js /
 * timer.js and is independently tested.
 */

import {
  load, save, addTodo, editTodo, deleteTodo, toggleTodo,
  selectTodo, incrementSession, emptyState,
} from './store.js';
import { createTimer, DEFAULT_SETTINGS, PHASES, phaseDuration } from './timer.js';
import { loadTheme, applyTheme, nextTheme } from './theme.js';
import { playChime } from './chime.js';

/* ---------- state ---------- */

const SETTINGS_KEY = 'focus.settings.v1';

/** @returns {import('./timer.js').Settings} */
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      workMin:  Math.max(1, Math.min(180, Number(parsed.workMin)  || DEFAULT_SETTINGS.workMin)),
      shortMin: Math.max(1, Math.min(60,  Number(parsed.shortMin) || DEFAULT_SETTINGS.shortMin)),
      longMin:  Math.max(1, Math.min(120, Number(parsed.longMin)  || DEFAULT_SETTINGS.longMin)),
      longEvery: DEFAULT_SETTINGS.longEvery,
      chime: parsed.chime !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
/** @param {import('./timer.js').Settings} s */
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

let state = load();
let settings = loadSettings();
let currentTheme = loadTheme();
applyTheme(currentTheme);

/* ---------- DOM refs ---------- */

const $ = /** @type {<T extends HTMLElement>(id: string) => T} */(id => /** @type {any} */(document.getElementById(id)));
const list        = $( 'todo-list');
const empty       = $( 'todo-empty');
const newForm     = /** @type {HTMLFormElement} */($( 'new-todo-form'));
const newInput    = /** @type {HTMLInputElement} */($( 'new-todo-input'));
const btnNew      = $( 'btn-new');
const btnStart    = $( 'btn-start');
const btnReset    = $( 'btn-reset');
const btnSkip     = $( 'btn-skip');
const display     = $( 'timer-display');
const phaseLabel  = $( 'timer-phase');
const cycleCount  = $( 'cycle-count');
const todayTotal  = $( 'today-total');
const ringProgress = /** @type {SVGCircleElement} */(/** @type {any} */(document.querySelector('.ring-progress')));
const ringWrap    = /** @type {HTMLElement} */(document.querySelector('.ring-wrap'));
const selText     = $( 'timer-selected-text');
const themeBtn    = $( 'theme-toggle');
const themeIcon   = $( 'theme-icon');
const liveRegion  = $( 'live-region');
const dialog      = /** @type {HTMLDialogElement} */(/** @type {any} */($( 'settings-dialog')));
const btnOpenSettings = $( 'settings-open');
const btnCancelSettings = $( 'settings-cancel');
const setWork   = /** @type {HTMLInputElement} */($( 'set-work'));
const setShort  = /** @type {HTMLInputElement} */($( 'set-short'));
const setLong   = /** @type {HTMLInputElement} */($( 'set-long'));
const setChime  = /** @type {HTMLInputElement} */($( 'set-chime'));
const settingsForm = /** @type {HTMLFormElement} */($( 'settings-form'));

/* ---------- timer ---------- */

const timer = createTimer({
  settings,
  onTick(remaining, duration, phase) {
    renderTime(remaining, duration, phase);
  },
  onPhaseEnd(completedPhase, next) {
    if (completedPhase === PHASES.WORK) {
      state = incrementSession(state);
      save(state);
      renderTodos();
      renderCounters();
    }
    if (settings.chime) {
      playChime(completedPhase === PHASES.WORK ? 'break' : 'work');
    }
    announce(`${labelFor(completedPhase)} complete. Starting ${labelFor(next)}.`);
    renderTime(
      phaseDuration(next, settings),
      phaseDuration(next, settings),
      next,
    );
    renderStartButton();
  },
});

/* ---------- render helpers ---------- */

/** @param {string} phase */
function labelFor(phase) {
  if (phase === PHASES.WORK)  return 'Work';
  if (phase === PHASES.SHORT) return 'Short break';
  if (phase === PHASES.LONG)  return 'Long break';
  return phase;
}

function announce(text) {
  liveRegion.textContent = '';
  // next tick to force SR to pick up
  setTimeout(() => { liveRegion.textContent = text; }, 10);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function renderTime(remaining, duration, phase) {
  display.textContent = fmtTime(Math.max(0, remaining));
  phaseLabel.textContent = labelFor(phase);
  document.title = `${fmtTime(remaining)} · ${labelFor(phase)} — Focus`;
  ringWrap.dataset.phase = phase;
  const frac = duration > 0 ? Math.max(0, Math.min(1, remaining / duration)) : 0;
  // Ring draws clockwise; we want it to drain as time passes.
  // pathLength=1 means dash offset 0..1 == full..empty.
  ringProgress.setAttribute('stroke-dashoffset', String(1 - frac));
}

function renderStartButton() {
  const s = timer.getState();
  btnStart.textContent = s.running ? 'Pause' : 'Start';
  btnStart.setAttribute('aria-pressed', s.running ? 'true' : 'false');
}

function renderCounters() {
  cycleCount.textContent = String(timer.getState().completedWork + 1);
  todayTotal.textContent = String(state.dailyTotal.count);
}

function renderSelected() {
  const t = state.todos.find(t => t.id === state.selectedId);
  selText.textContent = t ? t.text : 'Select a todo';
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderTodos() {
  clearChildren(list);
  empty.hidden = state.todos.length > 0;
  for (const t of state.todos) {
    const li = document.createElement('li');
    li.className = 'todo-item' + (t.done ? ' done' : '') + (state.selectedId === t.id ? ' selected' : '');
    li.dataset.id = t.id;
    li.setAttribute('role', 'listitem');
    li.tabIndex = 0;
    li.setAttribute('aria-selected', state.selectedId === t.id ? 'true' : 'false');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'todo-check';
    check.checked = t.done;
    check.setAttribute('aria-label', `Mark "${t.text}" ${t.done ? 'incomplete' : 'complete'}`);
    check.addEventListener('change', (ev) => {
      ev.stopPropagation();
      state = toggleTodo(state, t.id);
      save(state);
      renderTodos();
    });

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = t.text;
    text.setAttribute('role', 'textbox');
    text.addEventListener('dblclick', () => startEdit(text, t.id));

    const sessions = document.createElement('span');
    sessions.className = 'todo-sessions';
    sessions.textContent = `${t.sessions} \u25F7`;
    sessions.title = `${t.sessions} pomodoro session${t.sessions === 1 ? '' : 's'}`;
    sessions.setAttribute('aria-label', `${t.sessions} sessions`);

    const actions = document.createElement('span');
    actions.className = 'todo-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn';
    editBtn.textContent = 'E';
    editBtn.setAttribute('aria-label', `Edit "${t.text}"`);
    editBtn.title = 'Edit (Enter)';
    editBtn.addEventListener('click', (ev) => { ev.stopPropagation(); startEdit(text, t.id); });
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn';
    delBtn.textContent = 'X';
    delBtn.setAttribute('aria-label', `Delete "${t.text}"`);
    delBtn.title = 'Delete (Delete)';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state = deleteTodo(state, t.id);
      save(state);
      renderTodos();
      renderSelected();
    });
    actions.append(editBtn, delBtn);

    li.addEventListener('click', () => {
      state = selectTodo(state, t.id);
      save(state);
      renderTodos();
      renderSelected();
    });
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !text.isContentEditable) {
        ev.preventDefault();
        startEdit(text, t.id);
      } else if (ev.key === 'Delete') {
        ev.preventDefault();
        state = deleteTodo(state, t.id);
        save(state);
        renderTodos();
        renderSelected();
      }
    });

    li.append(check, text, sessions, actions);
    list.appendChild(li);
  }
  renderSelected();
}

/** @param {HTMLElement} textEl @param {string} id */
function startEdit(textEl, id) {
  const original = textEl.textContent ?? '';
  textEl.setAttribute('contenteditable', 'true');
  textEl.focus();
  // select all
  const range = document.createRange();
  range.selectNodeContents(textEl);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const finish = (commit) => {
    textEl.removeAttribute('contenteditable');
    textEl.removeEventListener('blur', onBlur);
    textEl.removeEventListener('keydown', onKey);
    const next = (textEl.textContent ?? '').trim();
    if (commit && next && next !== original) {
      state = editTodo(state, id, next);
      save(state);
    }
    renderTodos();
  };
  const onBlur = () => finish(true);
  const onKey = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); textEl.textContent = original; finish(false); }
  };
  textEl.addEventListener('blur', onBlur);
  textEl.addEventListener('keydown', onKey);
}

/* ---------- controls ---------- */

newForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = newInput.value;
  if (!text.trim()) return;
  state = addTodo(state, text);
  // Auto-select the new top todo if none selected
  if (!state.selectedId && state.todos[0]) {
    state = selectTodo(state, state.todos[0].id);
  }
  save(state);
  newInput.value = '';
  renderTodos();
});

btnNew.addEventListener('click', () => newInput.focus());

btnStart.addEventListener('click', () => {
  timer.toggle();
  renderStartButton();
  const st = timer.getState();
  renderTime(st.remainingSec, st.durationSec, st.phase);
});
btnReset.addEventListener('click', () => {
  timer.reset();
  renderStartButton();
});
btnSkip.addEventListener('click', () => {
  timer.skip();
  renderStartButton();
  const st = timer.getState();
  renderTime(st.remainingSec, st.durationSec, st.phase);
});

themeBtn.addEventListener('click', () => {
  currentTheme = nextTheme(currentTheme);
  applyTheme(currentTheme);
  themeIcon.textContent = currentTheme === 'auto' ? 'A' : currentTheme === 'light' ? 'L' : 'D';
  themeBtn.setAttribute('aria-label', `Theme: ${currentTheme} (click to change)`);
});
themeIcon.textContent = currentTheme === 'auto' ? 'A' : currentTheme === 'light' ? 'L' : 'D';
themeBtn.setAttribute('aria-label', `Theme: ${currentTheme} (click to change)`);

/* ---------- settings dialog ---------- */

function openSettings() {
  setWork.value  = String(settings.workMin);
  setShort.value = String(settings.shortMin);
  setLong.value  = String(settings.longMin);
  setChime.checked = settings.chime;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}
function closeSettings() {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}
btnOpenSettings.addEventListener('click', openSettings);
btnCancelSettings.addEventListener('click', (ev) => { ev.preventDefault(); closeSettings(); });

settingsForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const next = {
    workMin:  Math.max(1, Math.min(180, Number(setWork.value)  || DEFAULT_SETTINGS.workMin)),
    shortMin: Math.max(1, Math.min(60,  Number(setShort.value) || DEFAULT_SETTINGS.shortMin)),
    longMin:  Math.max(1, Math.min(120, Number(setLong.value)  || DEFAULT_SETTINGS.longMin)),
    longEvery: DEFAULT_SETTINGS.longEvery,
    chime: setChime.checked,
  };
  settings = next;
  saveSettings(settings);
  timer.updateSettings(settings);
  const st = timer.getState();
  renderTime(st.remainingSec, st.durationSec, st.phase);
  closeSettings();
});

/* ---------- keyboard shortcuts ---------- */

document.addEventListener('keydown', (ev) => {
  const target = /** @type {HTMLElement} */(ev.target);
  const typing =
    target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
               target.isContentEditable || dialog.hasAttribute('open'));

  if (ev.key === ' ' && !typing) {
    ev.preventDefault();
    timer.toggle();
    renderStartButton();
    const st = timer.getState();
    renderTime(st.remainingSec, st.durationSec, st.phase);
  } else if ((ev.key === 'n' || ev.key === 'N') && !typing) {
    ev.preventDefault();
    newInput.focus();
  } else if (ev.key === 'Enter' && !typing) {
    const t = state.todos.find(t => t.id === state.selectedId);
    if (t) {
      const li = list.querySelector(`[data-id="${t.id}"]`);
      const textEl = li?.querySelector('.todo-text');
      if (textEl instanceof HTMLElement) {
        ev.preventDefault();
        startEdit(textEl, t.id);
      }
    }
  } else if (ev.key === 'Delete' && !typing) {
    if (state.selectedId) {
      ev.preventDefault();
      state = deleteTodo(state, state.selectedId);
      save(state);
      renderTodos();
      renderSelected();
    }
  }
});

/* ---------- init ---------- */

// Render initial state
{
  const st = timer.getState();
  renderTime(st.remainingSec, st.durationSec, st.phase);
}
renderStartButton();
renderTodos();
renderCounters();
