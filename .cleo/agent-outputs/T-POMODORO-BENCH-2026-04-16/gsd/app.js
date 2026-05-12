// app.js — DOM wiring. Imports pure logic from lib/.
import {
  load, save, saveTheme, rolloverDailyTotal,
} from "./lib/storage.js";
import {
  PHASES, createTimer, start, pause, reset, tick,
  phaseDuration, formatTime, setDurations,
} from "./lib/timer.js";
import {
  addTodo, editTodo, deleteTodo, toggleTodo,
  incrementSession, findTodo,
} from "./lib/todos.js";

// ---------- State ----------
let state = rolloverDailyTotal(load());
let timer = createTimer(state.settings);

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const newTodoForm = $("new-todo-form");
const newTodoInput = $("new-todo-input");
const todoList = $("todo-list");
const todosEmpty = $("todos-empty");
const timerPhaseEl = $("timer-phase");
const timerDisplay = $("timer-display");
const timerFor = $("timer-for");
const timerStart = $("timer-start");
const timerReset = $("timer-reset");
const ringProgress = document.querySelector(".ring-progress");
const selectedCountEl = $("selected-count");
const dailyCountEl = $("daily-count");
const cycleCountEl = $("cycle-count");
const themeToggle = $("theme-toggle");
const settingsOpen = $("settings-open");
const settingsDialog = $("settings-dialog");
const settingsForm = $("settings-form");
const settingsWork = $("settings-work");
const settingsShort = $("settings-short");
const settingsLong = $("settings-long");
const settingsCancel = $("settings-cancel");

const RING_CIRCUMFERENCE = 2 * Math.PI * 90; // matches r=90 in SVG

// ---------- Audio (chime) ----------
let audioCtx = null;
function ensureAudio() {
  if (audioCtx) return audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}
function chime(freq = 880, durationMs = 180) {
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t0 = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durationMs / 1000 + 0.05);
}

// ---------- Save helper ----------
function persist() {
  save(state);
}

/** Remove all children from an element without using innerHTML. */
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ---------- Rendering ----------
function render() {
  renderTodos();
  renderTimer();
  renderCounters();
}

function renderTodos() {
  clearChildren(todoList);
  if (state.todos.length === 0) {
    todosEmpty.hidden = false;
  } else {
    todosEmpty.hidden = true;
    for (const t of state.todos) {
      const li = document.createElement("li");
      li.className = "todo-item" + (t.completed ? " completed" : "") + (t.id === state.selectedId ? " selected" : "");
      li.dataset.id = t.id;
      li.tabIndex = 0;
      li.setAttribute("role", "listitem");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = t.completed;
      checkbox.setAttribute("aria-label", `Mark "${t.text}" ${t.completed ? "incomplete" : "complete"}`);
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => {
        state.todos = toggleTodo(state.todos, t.id);
        persist();
        renderTodos();
      });
      li.appendChild(checkbox);

      const text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = t.text;
      li.appendChild(text);

      const count = document.createElement("span");
      count.className = "todo-count";
      count.setAttribute("aria-label", `${t.sessionCount} sessions`);
      count.textContent = `${t.sessionCount}🍅`;
      li.appendChild(count);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "todo-delete";
      del.setAttribute("aria-label", `Delete "${t.text}"`);
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        handleDelete(t.id);
      });
      li.appendChild(del);

      li.addEventListener("click", () => selectTodo(t.id));
      li.addEventListener("dblclick", () => enterEdit(t.id));
      todoList.appendChild(li);
    }
  }
}

function renderTimer() {
  const phaseLabel = timer.phase === PHASES.IDLE ? "Idle"
    : timer.phase === PHASES.WORK ? "Work"
    : timer.phase === PHASES.SHORT ? "Short Break"
    : "Long Break";
  timerPhaseEl.textContent = phaseLabel;

  const total = phaseDuration(timer);
  const remaining = timer.remainingMs == null ? total : timer.remainingMs;
  timerDisplay.textContent = formatTime(remaining || total || timer.durations.work * 60000);

  // Ring progress
  if (total > 0) {
    const pct = Math.max(0, Math.min(1, remaining / total));
    ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct));
  } else {
    ringProgress.style.strokeDashoffset = "0";
  }

  // Start button state
  const selected = state.selectedId ? findTodo(state.todos, state.selectedId) : null;
  timerStart.disabled = !selected;
  timerStart.textContent = timer.running ? "Pause" : "Start";
  timerFor.textContent = selected ? `Focusing on: ${selected.text}` : "Select a todo to begin";
}

function renderCounters() {
  const selected = state.selectedId ? findTodo(state.todos, state.selectedId) : null;
  selectedCountEl.textContent = String(selected ? selected.sessionCount : 0);
  dailyCountEl.textContent = String(state.dailyTotal);
  cycleCountEl.textContent = String(timer.cyclesCompleted);
}

// ---------- Actions ----------
function selectTodo(id) {
  state.selectedId = id;
  persist();
  render();
}

function handleDelete(id) {
  if (!confirm("Delete this todo?")) return;
  state.todos = deleteTodo(state.todos, id);
  if (state.selectedId === id) state.selectedId = null;
  delete state.counters[id];
  persist();
  render();
}

function enterEdit(id) {
  const li = todoList.querySelector(`[data-id="${id}"]`);
  if (!li) return;
  const textEl = li.querySelector(".todo-text");
  if (!textEl) return;
  const current = textEl.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.value = current;
  input.className = "edit-input";
  input.setAttribute("aria-label", "Edit todo text");
  input.maxLength = 200;
  textEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const val = input.value.trim();
    if (val) {
      state.todos = editTodo(state.todos, id, val);
      persist();
    }
    renderTodos();
  };
  const cancel = () => renderTodos();
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

// ---------- Timer loop ----------
let rafId = null;
function loop() {
  if (!timer.running) { rafId = null; return; }
  const now = performance.now();
  const res = tick(timer, now);
  const prev = timer;
  timer = res.state;
  if (res.fired === "phaseEnd") {
    // Fire chime for phase change
    chime(prev.phase === PHASES.WORK ? 880 : 660);
    // Increment session counters when we just finished WORK
    if (prev.phase === PHASES.WORK && state.selectedId) {
      state.todos = incrementSession(state.todos, state.selectedId);
      state = rolloverDailyTotal(state);
      state.dailyTotal = (state.dailyTotal || 0) + 1;
      state.counters[state.selectedId] = (state.counters[state.selectedId] || 0) + 1;
      persist();
    }
    // Auto-start next phase
    timer = start(timer, performance.now());
  }
  render();
  rafId = requestAnimationFrame(loop);
}

function startTimer() {
  if (!state.selectedId) return;
  ensureAudio(); // user gesture
  timer = start(timer, performance.now());
  if (!rafId) rafId = requestAnimationFrame(loop);
  render();
}

function pauseTimer() {
  timer = pause(timer, performance.now());
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  render();
}

function toggleTimer() {
  if (!state.selectedId) return;
  if (timer.running) pauseTimer(); else startTimer();
}

function resetTimer() {
  timer = reset(timer);
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  render();
}

// ---------- Theme ----------
function getTheme() {
  return document.documentElement.dataset.theme || "light";
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  state.theme = t;
  saveTheme(t);
  persist();
}

// ---------- Settings ----------
function openSettings() {
  settingsWork.value = state.settings.work;
  settingsShort.value = state.settings.short;
  settingsLong.value = state.settings.long;
  if (typeof settingsDialog.showModal === "function") {
    settingsDialog.showModal();
  } else {
    settingsDialog.setAttribute("open", "");
  }
}
function closeSettings() {
  if (settingsDialog.open) settingsDialog.close();
  else settingsDialog.removeAttribute("open");
}

// ---------- Events ----------
newTodoForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = newTodoInput.value.trim();
  if (!val) return;
  state.todos = addTodo(state.todos, val);
  const justAdded = state.todos[state.todos.length - 1];
  if (!state.selectedId) state.selectedId = justAdded.id;
  newTodoInput.value = "";
  persist();
  render();
});

timerStart.addEventListener("click", toggleTimer);
timerReset.addEventListener("click", resetTimer);
themeToggle.addEventListener("click", () => setTheme(getTheme() === "dark" ? "light" : "dark"));

settingsOpen.addEventListener("click", openSettings);
settingsCancel.addEventListener("click", closeSettings);
settingsForm.addEventListener("submit", () => {
  // Dialog submit — grab values
  const w = clampInt(settingsWork.value, 1, 120, state.settings.work);
  const s = clampInt(settingsShort.value, 1, 60, state.settings.short);
  const l = clampInt(settingsLong.value, 1, 120, state.settings.long);
  state.settings = { work: w, short: s, long: l };
  timer = setDurations(timer, state.settings);
  persist();
  render();
});

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// Global keyboard shortcuts
function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return true;
  return false;
}
window.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    toggleTimer();
  } else if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    newTodoInput.focus();
  } else if (e.key === "Enter" && state.selectedId) {
    e.preventDefault();
    enterEdit(state.selectedId);
  } else if (e.key === "Delete" && state.selectedId) {
    e.preventDefault();
    handleDelete(state.selectedId);
  }
});

// OS theme live-listen (only applies when state.theme is null)
if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener?.("change", (e) => {
    if (!state.theme) {
      document.documentElement.dataset.theme = e.matches ? "dark" : "light";
    }
  });
}

// ---------- Boot ----------
(function boot() {
  timer = setDurations(timer, state.settings);
  ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  ringProgress.style.strokeDashoffset = "0";
  render();
})();
