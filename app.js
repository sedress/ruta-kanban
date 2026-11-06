/* ══════════════════════════════════════════════════════════
   Ruta — app.js
   Módulos: utils · auth · state · render · actions · dnd · ui
   Datos y usuarios en localStorage (sin backend).
   ══════════════════════════════════════════════════════════ */
"use strict";

/* ── utils ──────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = (p = "") => p + crypto.randomUUID();

const localDateISO = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const fmtDate = iso => {
  const [y, m, d] = iso.split("-").map(Number);
  const meses = ["ene", "feb", "mar", "abr", "may", "jun",
                 "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${d} ${meses[m - 1]} ${y !== new Date().getFullYear() ? String(y) : ""}`.trim();
};

const slug = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "espacio";

const initials = name =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";

const THEME_NAMES = { claro: "Claro", oscuro: "Oscuro", retro: "Retro CRT" };

/* paletas de color (columnas y etiquetas) */
const COLORS = {
  rojo: "#D64545",
  naranja: "#E8842C",
  amarillo: "#E0B400",
  verde: "#1F9D55",
  azul: "#2E5BFF",
  morado: "#7C4DFF",
  rosa: "#E0559B",
  gris: "#8A97A5"
};

const PRIORITIES = {
  alta: { label: "Alta", cls: "prio-alta" },
  media: { label: "Media", cls: "prio-media" },
  baja: { label: "Baja", cls: "prio-baja" }
};

/* ── estado vivo en memoria ─────────────────────────────── */
const state = {
  user: null,      // { id, name, email, … }
  data: null,      // { activeWorkspace, workspaces: […] }
  filter: "",
  filterPriority: "",
  filterLabel: "",
  theme: "claro"
};

const hasActiveFilters = () =>
  state.filter.trim() !== "" || state.filterPriority !== "" || state.filterLabel !== "";

const activeWorkspace = () =>
  state.data.workspaces.find(w => w.id === state.data.activeWorkspace)
  || state.data.workspaces[0];

const findCard = cardId => {
  for (const col of activeWorkspace().columns) {
    const c = col.cards.find(k => k.id === cardId);
    if (c) return { card: c, col };
  }
  return null;
};


/* ── cliente Supabase ───────────────────────────────────── */
const SUPABASE_URL = "https://zovompatmyxefyjikbxx.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpvdm9tcGF0bXl4ZWZ5amlrYnh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2NTE1MTQsImV4cCI6MjEwNzIyNzUxNH0.KGhDCVOqH782UGPn39QglIix_6HCg5lP7ZAH8r3IWss";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ── api: reemplaza a `store` (localStorage → Supabase) ──── */
/* Mantiene el MISMO shape que usa render:
   state.data = { activeWorkspace, workspaces: [
     { id, title, labels:[{id,name,color}], columns:[
       { id, title, color, wipLimit, cards:[
         { id, title, description, dueDate, priority, labels:[id],
           assignee, subtasks:[{id,title,done}], comments:[{id,author,text,at}] }
       ] } ] } ] }
   `activeWorkspace` y `theme` son preferencias de cliente (localStorage). */
const api = {
  /* ── carga del tablero completo ── */
  async loadWorkspaces(userId) {
    // Workspaces donde soy miembro (vía workspace_members)
    const { data: rows, error } = await sb
      .from("workspaces").select("*")
      .in("id", (await sb.from("workspace_members").select("workspace_id").eq("user_id", userId)).data?.map(r => r.workspace_id) || []);
    if (error) throw error;
    const workspaces = [];
    for (const r of (rows || [])) {
      workspaces.push(await this.loadWorkspace(r.id));
    }
    return workspaces;
  },

  async loadWorkspace(wsId) {
    const [colsRes, labelsRes] = await Promise.all([
      sb.from("columns").select("*").eq("workspace_id", wsId).order("position"),
      sb.from("labels").select("*").eq("workspace_id", wsId)
    ]);
    if (colsRes.error) throw colsRes.error;
    if (labelsRes.error) throw labelsRes.error;

    const columns = [];
    for (const c of (colsRes.data || [])) {
      const { data: cards, error: ce } = await sb
        .from("cards").select("*").eq("column_id", c.id).order("position");
      if (ce) throw ce;
      const col = {
        id: c.id, title: c.title, color: c.color,
        wipLimit: c.wip_limit, _pos: c.position, cards: []
      };
      for (const k of (cards || [])) {
        const card = {
          id: k.id, title: k.title, description: k.description,
          dueDate: k.due_date, priority: k.priority,
          _pos: k.position,
          labels: [], assignee: k.assignee_id || "",
          subtasks: [], comments: []
        };
        await this.loadCardExtras(card);
        if (card.assignee) {
          const { data: u } = await sb.from("users")
            .select("name").eq("id", card.assignee).single();
          card.assigneeName = u ? u.name : "";
        }
        col.cards.push(card);
      }
      columns.push(col);
    }
    const labels = (labelsRes.data || []).map(l =>
      ({ id: l.id, name: l.name, color: l.color }));
    const title = await this._wsTitle(wsId);
    // cargar miembros una vez por workspace (para resolver asigneeName)
    let members = [];
    try { members = await this.members(wsId); } catch { /* sin permisos */ }
    return { id: wsId, title, labels, columns, _members: members };
  },

  async _wsTitle(wsId) {
    const { data } = await sb.from("workspaces")
      .select("title").eq("id", wsId).single();
    return data ? data.title : "Espacio";
  },

  async loadCardExtras(card) {
    const [cl, st, cm] = await Promise.all([
      sb.from("card_labels").select("label_id").eq("card_id", card.id),
      sb.from("subtasks").select("*").eq("card_id", card.id).order("position"),
      sb.from("comments").select("*, users(name)").eq("card_id", card.id).order("created_at")
    ]);
    card.labels = (cl.data || []).map(x => x.label_id);
    card.subtasks = (st.data || []).map(s =>
      ({ id: s.id, title: s.title, done: s.done }));
    card.comments = (cm.data || []).map(c =>
      ({ id: c.id, author: c.users ? c.users.name : "—", text: c.text, at: c.created_at }));
  },

  /* ── workspaces ── */
  async createWorkspace(userId, title) {
    const { data, error } = await sb.from("workspaces")
      .insert({ title, owner_id: userId }).select("id").single();
    if (error) throw error;
    const wsId = data.id;
    // workspace_members se crea solo vía trigger add_owner_as_member
    await sb.from("columns")
      .insert({ workspace_id: wsId, title: "Por hacer", position: 1 });
    return wsId;
  },

  async renameWorkspace(wsId, title) {
    const { error } = await sb.from("workspaces")
      .update({ title }).eq("id", wsId);
    if (error) throw error;
  },

  async deleteWorkspace(wsId) {
    const { error } = await sb.from("workspaces").delete().eq("id", wsId);
    if (error) throw error;
  },

  /* ── columns ── */
  async createColumn(wsId, title, position) {
    const { data, error } = await sb.from("columns")
      .insert({ workspace_id: wsId, title, position }).select("id").single();
    if (error) throw error;
    return data.id;
  },

  async updateColumn(colId, { title, color, wipLimit, position }) {
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (color !== undefined) patch.color = color;
    if (wipLimit !== undefined) patch.wip_limit = wipLimit;
    if (position !== undefined) patch.position = position;
    const { error } = await sb.from("columns").update(patch).eq("id", colId);
    if (error) throw error;
  },

  async deleteColumn(colId) {
    const { error } = await sb.from("columns").delete().eq("id", colId);
    if (error) throw error;
  },

  /* ── cards ── */
  async createCard(colId, { title, description, dueDate, priority, position }) {
    const { data, error } = await sb.from("cards").insert({
      column_id: colId,
      title,
      description: description || "",
      due_date: dueDate || null,
      priority: priority || null,
      position: position === undefined ? 1 : position
    }).select("id").single();
    if (error) throw error;
    return data.id;
  },

  async updateCard(cardId, { title, description, dueDate, priority, colId, assigneeId, position }) {
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    if (dueDate !== undefined) patch.due_date = dueDate;
    if (priority !== undefined) patch.priority = priority;
    if (colId !== undefined) patch.column_id = colId;
    if (assigneeId !== undefined) patch.assignee_id = assigneeId;
    if (position !== undefined) patch.position = position;
    const { error } = await sb.from("cards").update(patch).eq("id", cardId);
    if (error) throw error;
  },

  async deleteCard(cardId) {
    const { error } = await sb.from("cards").delete().eq("id", cardId);
    if (error) throw error;
  },

  async setCardLabels(cardId, labelIds) {
    await sb.from("card_labels").delete().eq("card_id", cardId);
    if (labelIds.length) {
      const rows = labelIds.map(label_id => ({ card_id: cardId, label_id }));
      const { error } = await sb.from("card_labels").upsert(rows,
        { onConflict: "card_id,label_id" });
      if (error) throw error;
    }
  },

  /* ── labels ── */
  async createLabel(wsId, name, color) {
    const { data, error } = await sb.from("labels")
      .insert({ workspace_id: wsId, name, color }).select("id").single();
    if (error) throw error;
    return data.id;
  },

  /* ── subtasks ── */
  async replaceSubtasks(cardId, list) {
    const { data: existing, error } = await sb
      .from("subtasks").select("id").eq("card_id", cardId);
    if (error) throw error;
    const keep = new Set(list.map(s => s.id).filter(Boolean));
    const toDelete = (existing || []).map(e => e.id).filter(id => !keep.has(id));
    if (toDelete.length) {
      const { error: de } = await sb.from("subtasks").delete().in("id", toDelete);
      if (de) throw de;
    }
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.id) {
        const { error: ue } = await sb.from("subtasks")
          .update({ title: s.title, done: s.done, position: i + 1 }).eq("id", s.id);
        if (ue) throw ue;
      } else {
        const { data, error: ie } = await sb.from("subtasks")
          .insert({ card_id: cardId, title: s.title, done: s.done, position: i + 1 })
          .select("id").single();
        if (ie) throw ie;
        s.id = data.id;
      }
    }
  },

  /* ── comments ── */
  async addComment(cardId, userId, text) {
    const { data, error } = await sb.from("comments")
      .insert({ card_id: cardId, author_id: userId, text }).select().single();
    if (error) throw error;
    return data;
  },

  async deleteComment(commentId) {
    const { error } = await sb.from("comments").delete().eq("id", commentId);
    if (error) throw error;
  },

  /* ── membresía ── */
  async members(wsId) {
    const { data, error } = await sb.from("workspace_members")
      .select("user_id, role, users(name)").eq("workspace_id", wsId);
    if (error) throw error;
    return (data || []).map(m => ({
      id: m.user_id,
      name: m.users ? m.users.name : "—",
      role: m.role
    }));
  },

  async inviteUser(wsId, email) {
    // Buscar usuario por email
    const { data: user } = await sb.from("users")
      .select("id").eq("email", email.toLowerCase()).single();
    if (!user) throw new Error("No existe un usuario con ese correo.");
    // Agregar como miembro (editor)
    const { error } = await sb.from("workspace_members")
      .insert({ workspace_id: wsId, user_id: user.id, role: "editor" });
    if (error) {
      if (error.code === "23505") return; // ya es miembro
      throw error;
    }
  },

  async removeMember(wsId, userId) {
    const { error } = await sb.from("workspace_members")
      .delete().eq("workspace_id", wsId).eq("user_id", userId);
    if (error) throw error;
  }
};

/* ── auth: Supabase Auth (reemplaza el auth de localStorage) ─ */
const auth = {
  async register(name, email, pass) {
    const { data, error } = await sb.auth.signUp({
      email: email.trim().toLowerCase(),
      password: pass,
      options: { data: { name: name.trim() } }
    });
    if (error) throw new Error(this._msg(error.message));
    const { data: prof, error: profErr } = await sb.from("users").select("*").eq("id", data.user.id).single();
    if (profErr || !prof) throw new Error("No pudimos crear tu perfil. Reintentá.");
    return { id: data.user.id, name: prof.name, email: prof.email };
  },

  async login(email, pass) {
    const { data, error } = await sb.auth.signInWithPassword({
      email: email.trim().toLowerCase(), password: pass
    });
    if (error) throw new Error("Correo o contraseña incorrectos.");
    const { data: prof, error: profErr } = await sb.from("users").select("*").eq("id", data.user.id).single();
    if (profErr || !prof) throw new Error("No encontramos tu perfil. Reintentá.");
    return { id: prof.id, name: prof.name, email: prof.email };
  },

  async currentSession() {
    const { data } = await sb.auth.getSession();
    const s = data && data.session;
    if (!s) return null;
    const { data: prof, error: profErr } = await sb.from("users").select("*").eq("id", s.user.id).single();
    if (profErr || !prof) return null;
    return { user: { id: prof.id, name: prof.name, email: prof.email } };
  },

  async logout() { await sb.auth.signOut(); },

  _msg(m) {
    m = m.toLowerCase();
    if (m.includes("already registered") || m.includes("already been registered"))
      return "Ya existe una cuenta con ese correo.";
    if (m.includes("invalid login")) return "Correo o contraseña incorrectos.";
    if (m.includes("valid email")) return "Ese correo no parece válido.";
    if (m.includes("password")) return "La contraseña debe tener al menos 8 caracteres.";
    return m;
  }
};

/* ── preferencias de cliente (se quedan en localStorage) ── */
const THEME_KEY = "ruta.theme";
const prefs = {
  key(userId) { return `ruta.prefs.${userId}.v1`; },
  load(userId) {
    try { return JSON.parse(localStorage.getItem(this.key(userId))) || {}; }
    catch { return {}; }
  },
  save(userId, p) { localStorage.setItem(this.key(userId), JSON.stringify(p)); }
};
/* tema global (antes de login) */
const getGlobalTheme = () => localStorage.getItem(THEME_KEY) || "claro";
const setGlobalTheme = t => localStorage.setItem(THEME_KEY, t);
/* ── validadores de formulario (UI) ─────────────────────── */
const validators = {
  name: v => {
    const t = v.trim();
    return t.length >= 2 && t.length <= 40
      ? "" : "El nombre debe tener al menos 2 caracteres.";
  },
  email: v =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
      ? "" : "Ese correo no parece válido.",
  pass: v =>
    v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v)
      ? "" : "Usá al menos 8 caracteres, con una letra y un número.",
  confirm: (v, pass) =>
    v === pass ? "" : "Las contraseñas no coinciden."
};

/* ── render ─────────────────────────────────────────────── */
function renderCard(card, prevIds) {
  const el = document.createElement("article");
  el.className = "card-item";
  el.draggable = true;
  el.dataset.id = card.id;
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", `Editar tarea: ${card.title}`);

  // animar solo cards que no estaban en el DOM antes
  if (prevIds && !prevIds.has(card.id)) {
    el.classList.add("card-new");
    el.style.setProperty("--stagger", Math.random() * 150);
  }

  // fila superior: prioridad + responsable
  const top = document.createElement("div");
  top.className = "card-top";
  const prio = PRIORITIES[card.priority];
  if (prio) {
    const p = document.createElement("span");
    p.className = `card-prio ${prio.cls}`;
    p.textContent = prio.label;
    top.appendChild(p);
  }
  if (card.assignee) {
    const a = document.createElement("span");
    a.className = "card-assignee";
    a.title = `Responsable: ${card.assigneeName || card.assignee}`;
    a.textContent = initials(card.assigneeName || card.assignee);
    top.appendChild(a);
  }
  if (top.children.length) el.appendChild(top);

  const t = document.createElement("div");
  t.className = "card-title-text";
  t.textContent = card.title;
  el.appendChild(t);

  if (card.description) {
    const d = document.createElement("div");
    d.className = "card-desc";
    d.textContent = card.description;
    el.appendChild(d);
  }

  // etiquetas
  const labels = (card.labels || []).map(id =>
    (activeWorkspace().labels || []).find(l => l.id === id)).filter(Boolean);
  if (labels.length) {
    const row = document.createElement("div");
    row.className = "card-labels";
    labels.forEach((l, i) => {
      const chip = document.createElement("span");
      chip.className = "label-chip";
      chip.dataset.id = l.id;
      chip.style.background = l.color;
      chip.textContent = l.name;
      row.appendChild(chip);
    });
    el.appendChild(row);
  }

  if (card.dueDate) {
    const today = localDateISO();
    let cls = "";
    if (card.dueDate < today) cls = "overdue";
    else if (card.dueDate === today) cls = "due-today";
    const due = document.createElement("div");
    due.className = `card-due ${cls}`.trim();
    due.textContent =
      (cls === "overdue" ? "⚠ " : "⏱ ") + fmtDate(card.dueDate) +
      (cls === "due-today" ? " · hoy" : "");
    el.appendChild(due);
  }

  // progreso por subtareas
  const subs = card.subtasks || [];
  if (subs.length) {
    const done = subs.filter(s => s.done).length;
    const pct = Math.round((done / subs.length) * 100);
    const prog = document.createElement("div");
    prog.className = "card-progress";
    const bar = document.createElement("div");
    bar.className = "card-progress-bar";
    bar.style.width = pct + "%";
    const txt = document.createElement("span");
    txt.className = "card-progress-txt";
    txt.textContent = `${done}/${subs.length} subtareas`;
    prog.append(bar, txt);
    el.appendChild(prog);
  }

  // contador de comentarios
  const cms = card.comments || [];
  if (cms.length) {
    const c = document.createElement("span");
    c.className = "card-comments-count";
    c.title = `Comentarios: ${cms.length}`;
    c.textContent = `💬 ${cms.length}`;
    el.appendChild(c);
  }

  el.addEventListener("click", () => ui.openCardModal(card.id));
  el.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      ui.openCardModal(card.id);
    }
  });
  return el;
}

/* re-renderiza SOLO una card in-place (sin tocar el resto del board)
   y anima los subelementos que cambiaron (prioridad, responsable,
   etiquetas, subtareas, comentarios). */
function refreshCardInPlace(cardId, changes) {
  const found = findCard(cardId);
  if (!found) return;
  const { card } = found;
  const oldEl = document.querySelector(`.card-item[data-id="${cardId}"]`);
  if (!oldEl) return;
  const newEl = renderCard(card, null); // prevIds=null → sin animación card-new

  // aplicar clases de animación a los subelementos que cambiaron.
  // (las etiquetas NO se animan: se actualizan al instante)
  const animated = [];
  const animate = (el, cls) => {
    if (!el) return;
    el.classList.add(cls);
    animated.push({ el, cls });
  };
  if (changes) {
    if (changes.priority) animate(newEl.querySelector(".card-prio"), "prio-changed");
    if (changes.assignee) animate(newEl.querySelector(".card-assignee"), "assignee-changed");
    if (changes.subtasks) animate(newEl.querySelector(".card-progress-txt"), "subtasks-changed");
    if (changes.comments) animate(newEl.querySelector(".card-comments-count"), "comments-changed");
  }

  oldEl.replaceWith(newEl);

  // quitar las clases de animación al terminar (evita transform residual)
  animated.forEach(({ el, cls }) => {
    const onEnd = (e) => {
      if (e.animationName) {
        el.classList.remove(cls);
        el.removeEventListener("animationend", onEnd);
      }
    };
    el.addEventListener("animationend", onEnd);
  });
}

function renderColumn(col, prevIds) {
  const el = document.createElement("section");
  el.className = "column";
  el.dataset.id = col.id;
  // animar solo columnas nuevas
  if (prevIds && !prevIds.has(col.id)) {
    el.classList.add("col-new");
  }

  const filter = state.filter.trim().toLowerCase();
  const filtering = hasActiveFilters();
  const visible = col.cards.filter(c => cardMatchesFilters(c, filter));

  // barra de color de la columna
  if (col.color) {
    const accent = document.createElement("div");
    accent.className = "col-accent";
    accent.style.background = col.color;
    el.appendChild(accent);
  }

  const head = document.createElement("header");
  head.className = "col-head";
  head.draggable = !filtering;
  head.title = "Arrastrá para reordenar la columna";
  const title = document.createElement("span");
  title.className = "col-title";
  title.textContent = col.title;
  const count = document.createElement("span");
  count.className = "col-count";
  const total = col.cards.length;
  if (col.wipLimit) {
    count.textContent = `${total}/${col.wipLimit}`;
    if (total > col.wipLimit) count.classList.add("wip-over");
    count.title = `Límite WIP: ${col.wipLimit}`;
  } else {
    count.textContent = String(filtering ? visible.length : total);
  }
  const tools = document.createElement("span");
  tools.className = "col-tools";
  tools.innerHTML =
    `<button class="col-btn" data-act="edit" type="button" aria-label="Editar columna">✎</button>` +
    `<button class="col-btn" data-act="delete" type="button" aria-label="Eliminar columna">✕</button>`;
  tools.querySelector('[data-act="edit"]').addEventListener("click", () => ui.openColModal(col.id));
  tools.querySelector('[data-act="delete"]').addEventListener("click", () => actions.deleteColumn(col.id));
  head.append(title, count, tools);

  const body = document.createElement("div");
  body.className = "col-cards";

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "col-empty";
    empty.textContent = filtering
      ? "Sin coincidencias"
      : "Sin tareas. Arrastrá una aquí o añadí una.";
    body.appendChild(empty);
  } else {
    visible.forEach(c => body.appendChild(renderCard(c, prevIds)));
  }

  el.append(head, body);
  if (!filtering) {
    const add = document.createElement("button");
    add.className = "btn btn-retro btn-sm col-add";
    add.type = "button";
    add.textContent = "+ Añadir";
    add.addEventListener("click", () => ui.openInlineEditor(col.id));
    el.appendChild(add);
  }
  return el;
}

function cardMatchesFilters(card, filterText) {
  if (filterText &&
      !card.title.toLowerCase().includes(filterText) &&
      !(card.description || "").toLowerCase().includes(filterText))
    return false;
  if (state.filterPriority && card.priority !== state.filterPriority)
    return false;
  if (state.filterLabel && !(card.labels || []).includes(state.filterLabel))
    return false;
  return true;
}

function cardMatches(col, filterText) {
  return col.cards.some(c => cardMatchesFilters(c, filterText));
}

function renderBoard() {
  const ws = activeWorkspace();
  const board = $("#board");

  // capturar IDs de cards ya visibles (para animar solo las nuevas)
  const prevIds = new Set(
    [...board.querySelectorAll(".card-item")].map(el => el.dataset.id)
  );
  board.innerHTML = "";
  const filter = state.filter.trim().toLowerCase();
  const filtering = hasActiveFilters();
  const cols = filtering
    ? ws.columns.filter(col => cardMatches(col, filter))
    : ws.columns;
  cols.forEach(col => board.appendChild(renderColumn(col, prevIds)));

  if (filtering && cols.length === 0) {
    const empty = document.createElement("p");
    empty.className = "board-empty";
    empty.textContent = "No hay tareas que coincidan con los filtros activos.";
    board.appendChild(empty);
  }

  if (!filtering) {
    const addCol = document.createElement("button");
    addCol.className = "btn btn-retro add-column";
    addCol.type = "button";
    addCol.textContent = "+ Añadir columna";
    addCol.addEventListener("click", () => {
      ui.openTextModal({
        label: "Nombre de la columna",
        placeholder: "p. ej. En revisión",
        onSave: t => actions.addColumn(t)
      });
    });
    board.appendChild(addCol);
  }
  renderTopbar();
}

function renderTopbar() {
  const ws = activeWorkspace();
  $("#ws-name").textContent = ws.title;
  $("#user-name").textContent = state.user.name;
  $("#user-email").textContent = state.user.email;
  renderWsMenu();
  renderLabelFilter();
}

function renderLabelFilter() {
  const sel = $("#filter-label");
  const ws = activeWorkspace();
  const labels = ws.labels || [];
  const prev = state.filterLabel;
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Etiqueta: todas";
  sel.appendChild(all);
  labels.forEach(l => {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = l.name;
    sel.appendChild(o);
  });
  sel.value = labels.some(l => l.id === prev) ? prev : "";
  if (sel.value !== prev) state.filterLabel = sel.value;
  $("#filter-clear").classList.toggle("d-none", !hasActiveFilters());
}

function renderWsMenu() {
  const menu = $("#ws-menu");
  menu.innerHTML = "";
  state.data.workspaces.forEach(ws => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dropdown-item" +
      (ws.id === state.data.activeWorkspace ? " active" : "");
    b.textContent = (ws.id === state.data.activeWorkspace ? "▸ " : "") + ws.title;
    b.addEventListener("click", () => actions.switchWorkspace(ws.id));
    li.appendChild(b);
    menu.appendChild(li);
  });
  const hr = document.createElement("li");
  hr.innerHTML = '<hr class="dropdown-divider">';
  menu.appendChild(hr);
  const mk = (txt, fn) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dropdown-item";
    b.textContent = txt;
    b.addEventListener("click", fn);
    li.appendChild(b);
    menu.appendChild(li);
  };
  mk("Nuevo espacio…", () => {
    ui.openTextModal({
      label: "Nombre del espacio",
      placeholder: "p. ej. Trabajo Final Kanban",
      onSave: t => actions.addWorkspace(t)
    });
  });
  mk("Renombrar…", () => {
    const ws = activeWorkspace();
    ui.openTextModal({
      label: "Nombre del espacio",
      value: ws.title,
      onSave: t => actions.renameWorkspace(ws.id, t)
    });
  });
  mk("Miembros…", () => ui.openMembersModal());
  mk("Invitar miembro…", () => {
    ui.openTextModal({
      label: "Correo del invitado",
      placeholder: "persona@ejemplo.com",
      onSave: async t => {
        realtime._suppress++;
        try {
          await api.inviteUser(activeWorkspace().id, t);
          ui.toast("Miembro invitado. Ya puede ver este espacio.");
          await actions._reloadActive();
        } catch (e) {
          ui.toast(e.message, true);
        } finally {
          setTimeout(() => { realtime._suppress--; }, 1500);
        }
      }
    });
  });
  mk("Eliminar…", () => actions.deleteWorkspace(activeWorkspace().id));
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  $("#theme-name").textContent = THEME_NAMES[theme] || "Claro";
  const authName = $("#auth-theme-name");
  if (authName) authName.textContent = THEME_NAMES[theme] || "Claro";
}

/* ── actions ────────────────────────────────────────────── */
/* posición numérica: inserta 1.5 entre 1 y 2 (drag & drop sin reescribir) */
const posBetween = (a, b) => (a == null && b == null) ? 1
  : a == null ? b - 0.5 : b == null ? a + 1 : (a + b) / 2;

const actions = {
  async addCard(colId, { title, description, dueDate, priority, labels, assignee, subtasks, comments }) {
    const col = activeWorkspace().columns.find(c => c.id === colId);
    if (!col) return;
    const last = col.cards[col.cards.length - 1];
    const pos = posBetween(last ? last._pos : 0, null);
    realtime._suppress++;
    try {
      const id = await api.createCard(colId, {
        title, description, dueDate, priority, position: pos
      });
      if (labels && labels.length) await api.setCardLabels(id, labels);
      if (subtasks && subtasks.length) await api.replaceSubtasks(id, subtasks);
      if (comments && comments.length) {
        for (const c of comments)
          if (c.text) await api.addComment(id, state.user.id, c.text);
      }
      await this._reloadActive();
    } finally {
      setTimeout(() => { realtime._suppress--; }, 1500);
    }
  },

  async updateCard(cardId, { title, description, dueDate, colId, priority, labels, assignee, subtasks, comments }) {
    const found = findCard(cardId);
    if (!found) return;
    const { card, col } = found;
    const colChanged = colId && colId !== col.id;

    // ── detectar qué subelementos cambiaron (para animar) ──
    const oldSubs = card.subtasks || [];
    const newSubs = subtasks || [];
    const subsChanged = subtasks !== undefined && (
      newSubs.length !== oldSubs.length ||
      newSubs.some((s, i) => oldSubs[i]?.done !== s.done || oldSubs[i]?.title !== s.title)
    );
    const labelsChanged = labels !== undefined &&
      (labels || []).join(",") !== (card.labels || []).join(",");
    const changes = {
      priority: priority !== undefined && (priority || null) !== (card.priority || null),
      assignee: assignee !== undefined && (assignee || null) !== (card.assignee || null),
      labels: labelsChanged,
      subtasks: subsChanged,
      comments: comments !== undefined &&
        (comments || []).length !== (card.comments || []).length
    };
    // ── Optimistic UI: actualizar state local AL INSTANTE ──
    card.title = title;
    card.description = description || "";
    card.dueDate = dueDate || null;
    if (priority !== undefined) card.priority = priority || null;
    if (labels !== undefined) card.labels = labels || [];
    if (assignee !== undefined) {
      card.assignee = assignee || null;
      // buscar el nombre del miembro en el estado local (si existe)
      const ws = activeWorkspace();
      const member = (ws._members || []).find(m => m.id === assignee);
      card.assigneeName = member ? member.name : "";
    }
    if (subtasks !== undefined) card.subtasks = subtasks || [];
    if (comments !== undefined) card.comments = comments || [];
    if (colChanged) {
      col.cards = col.cards.filter(k => k.id !== cardId);
      const newCol = activeWorkspace().columns.find(c => c.id === colId);
      if (newCol) newCol.cards.push(card);
    }

    // ── Render INMEDIATO (como drag & drop) ──
    if (colChanged) renderBoard();
    else refreshCardInPlace(cardId, changes);

    // ── Guardar en background (no bloquea el render) ──
    realtime._suppress++;
    (async () => {
      try {
        await api.updateCard(cardId, {
          title,
          description: description || "",
          dueDate: dueDate || null,
          priority: priority === undefined ? undefined : (priority || null),
          colId: colChanged ? colId : undefined,
          assigneeId: assignee === undefined ? undefined : (assignee || null)
        });
        if (labels !== undefined) await api.setCardLabels(cardId, labels || []);
        if (subtasks !== undefined) await api.replaceSubtasks(cardId, subtasks || []);
        if (comments !== undefined) {
          const keep = new Set((comments || []).map(c => c.id).filter(Boolean));
          const { data: existing } = await sb
            .from("comments").select("id").eq("card_id", cardId);
          for (const e of (existing || []))
            if (!keep.has(e.id)) await api.deleteComment(e.id);
          for (const c of (comments || [])) {
            if (!c.id) {
              // Guardar el id REAL devuelto por Supabase para no re-insertar
              // el comentario en el próximo guardado (id local "cm-…" no es UUID).
              const saved = await api.addComment(cardId, state.user.id, c.text);
              if (saved) c.id = saved.id;
            }
          }
        }
      } catch (err) {
        ui.toast("Error al guardar: " + (err.message || "intentalo de nuevo."));
        await this._reloadActive();
      } finally {
        // Liberar el bloqueo de realtime INMEDIATO: el insert ya quedó en la BD,
        // así el próximo evento de realtime (debounce 800 ms) recarga con el dato fresco.
        // Con el setTimeout de 2 s, el debounce de 800 ms disparaba un reload
        // EN MEDIO del guardado y el comentario nuevo se perdía/re-escribía.
        realtime._suppress--;
      }
    })();
  },

  deleteCard(cardId) {
    const found = findCard(cardId);
    if (!found) return;
    // ── 1. Quitar del DOM (instantáneo) ──
    const el = document.querySelector(`.card-item[data-id="${cardId}"]`);
    if (el) {
      const body = el.closest(".col-cards");
      el.remove();
      if (body) {
        if (!body.querySelector(".card-item")) {
          const empty = document.createElement("p");
          empty.className = "col-empty";
          empty.textContent = "Sin tareas. Arrastrá una aquí o añadí una.";
          body.appendChild(empty);
        }
        const colEl = body.closest(".column");
        if (colEl) {
          const count = colEl.querySelector(".col-count");
          const colData = found.col;
          if (count && colData) {
            const total = body.querySelectorAll(".card-item").length;
            count.textContent = colData.wipLimit ? `${total}/${colData.wipLimit}` : String(total);
            count.classList.toggle("wip-over", colData.wipLimit && total > colData.wipLimit);
          }
        }
      }
    }
    // ── 2. Quitar del estado local ──
    found.col.cards = found.col.cards.filter(k => k.id !== cardId);
    // ── 3. Mandar al servidor en background ──
    realtime._suppress++;
    api.deleteCard(cardId).catch(() => this._reloadActive())
      .finally(() => setTimeout(() => { realtime._suppress--; }, 1200));
    ui.toast("Tarea eliminada");
  },

  moveCard(cardId, toColId, beforeCardId) {
    const ws = activeWorkspace();
    const from = ws.columns.find(c => c.cards.some(k => k.id === cardId));
    if (!from) return;
    const to = ws.columns.find(c => c.id === toColId);
    if (!to) return;

    // ── 1. Mover el elemento en el DOM (instantáneo) ──
    const cardEl = document.querySelector(`.card-item[data-id="${cardId}"]`);
    const toBody = document.querySelector(`.column[data-id="${toColId}"] .col-cards`);
    if (cardEl && toBody) {
      const beforeEl = beforeCardId
        ? toBody.querySelector(`.card-item[data-id="${beforeCardId}"]`)
        : null;
      if (beforeEl) toBody.insertBefore(cardEl, beforeEl);
      else toBody.appendChild(cardEl);
      // quitar mensaje "vacío" si quedó
      const empty = toBody.querySelector(".col-empty");
      if (empty) empty.remove();
    }

    // ── 2. Actualizar estado local ──
    const cardIdx = from.cards.findIndex(k => k.id === cardId);
    const card = from.cards.splice(cardIdx, 1)[0];
    if (beforeCardId) {
      const bIdx = to.cards.findIndex(k => k.id === beforeCardId);
      to.cards.splice(bIdx, 0, card);
    } else {
      to.cards.push(card);
    }

    // ── 3. Calcular posición para el servidor ──
    const destCards = to.cards; // ya incluye la card en su nueva posición
    const cIdx = destCards.findIndex(k => k.id === cardId);
    const targetPos = posBetween(
      cIdx > 0 ? destCards[cIdx - 1]._pos : null,
      cIdx < destCards.length - 1 ? destCards[cIdx + 1]._pos : null);

    // ── 4. Mandar al servidor en background ──
    // Suprimir realtime hasta que el UPDATE de nuestra propia card haya sido
    // procesado por el canal (debounce 800 ms). Con 1500 ms de ventana el
    // evento se descarta y NO hay segundo renderBoard (parpadeo).
    // Los cambios de OTROS usuarios siguen llegando: la supresión es breve.
    realtime._suppress++;
    api.updateCard(cardId, { colId: toColId, position: targetPos })
      .catch(() => setTimeout(() => this._reloadActive(), 2000))
      .finally(() => setTimeout(() => { realtime._suppress--; }, 2500));

    // ── 5. WIP check ──
    if (to.wipLimit && to.cards.length > to.wipLimit) {
      ui.toast(`«${to.title}» superó su límite WIP (${to.cards.length}/${to.wipLimit}).`);
    }
  },

  async addColumn(title) {
    const ws = activeWorkspace();
    const last = ws.columns[ws.columns.length - 1];
    // Suprimir realtime: el INSERT de nuestra propia columna no debe
    // disparar un segundo _reloadActive (doble render = parpadeo).
    realtime._suppress++;
    try {
      const id = await api.createColumn(ws.id, title,
        posBetween(last ? last._pos : 0, null));
      await this._reloadActive();
    } finally {
      // el evento realtime tarda ~800 ms (debounce) en llegar; liberar después
      setTimeout(() => { realtime._suppress--; }, 1500);
    }
  },

  async updateColumn(colId, { title, color, wipLimit }) {
    realtime._suppress++;
    try {
      await api.updateColumn(colId, {
        title, color: color || null,
        wipLimit: wipLimit > 0 ? wipLimit : null
      });
      await this._reloadActive();
    } finally {
      setTimeout(() => { realtime._suppress--; }, 1500);
    }
  },

  deleteColumn(colId) {
    const ws = activeWorkspace();
    const col = ws.columns.find(c => c.id === colId);
    if (!col) return;
    const n = col.cards.length;
    const msg = n
      ? `La columna «${col.title}» tiene ${n} ${n === 1 ? "tarea" : "tareas"}. Al borrarla, esas tareas se pierden del tablero. Esta acción no se puede deshacer.`
      : `¿Seguro que querés borrar la columna «${col.title}»? Esta acción no se puede deshacer.`;
    ui.openConfirm({
      title: "Borrar columna",
      message: msg,
      onConfirm: async () => {
        realtime._suppress++;
        try {
          await api.deleteColumn(colId);
          await this._reloadActive();
        } finally {
          setTimeout(() => { realtime._suppress--; }, 1500);
        }
        ui.toast(`Columna «${col.title}» eliminada.`);
      }
    });
  },

  moveColumn(colId, beforeColId) {
    const ws = activeWorkspace();
    const colIdx = ws.columns.findIndex(c => c.id === colId);
    if (colIdx < 0) return;

    // ── 1. Mover el elemento en el DOM (instantáneo) ──
    const colEl = document.querySelector(`.column[data-id="${colId}"]`);
    const board = $("#board");
    if (colEl && board) {
      const beforeEl = beforeColId
        ? board.querySelector(`.column[data-id="${beforeColId}"]`)
        : null;
      if (beforeEl) board.insertBefore(colEl, beforeEl);
      else {
        const addBtn = board.querySelector(".add-column");
        if (addBtn) board.insertBefore(colEl, addBtn);
        else board.appendChild(colEl);
      }
    }

    // ── 2. Actualizar estado local ──
    const col = ws.columns.splice(colIdx, 1)[0];
    if (beforeColId) {
      const bIdx = ws.columns.findIndex(c => c.id === beforeColId);
      ws.columns.splice(bIdx, 0, col);
    } else {
      ws.columns.push(col);
    }

    // ── 3. Calcular posición para el servidor ──
    const cIdx = ws.columns.findIndex(c => c.id === colId);
    const targetPos = posBetween(
      cIdx > 0 ? ws.columns[cIdx - 1]._pos : null,
      cIdx < ws.columns.length - 1 ? ws.columns[cIdx + 1]._pos : null);

    // ── 4. Mandar al servidor en background ──
    // Ventana de 2500 ms: cubre el debounce de 800 ms del canal realtime
    // para que el UPDATE de nuestra propia columna NO dispare un segundo
    // renderBoard (parpadeo). Los cambios de otros usuarios siguen llegando.
    realtime._suppress++;
    api.updateColumn(colId, { position: targetPos })
      .catch(() => setTimeout(() => this._reloadActive(), 2000))
      .finally(() => setTimeout(() => { realtime._suppress--; }, 2500));
  },

  async addWorkspace(title) {
    realtime._suppress++;
    try {
      const wsId = await api.createWorkspace(state.user.id, title);
      state.data.activeWorkspace = wsId;
      await this._reloadActive();
    } finally {
      setTimeout(() => { realtime._suppress--; }, 1500);
    }
  },

  async renameWorkspace(wsId, title) {
    realtime._suppress++;
    try {
      await api.renameWorkspace(wsId, title);
      await this._reloadActive();
    } finally {
      setTimeout(() => { realtime._suppress--; }, 1500);
    }
  },

  deleteWorkspace(wsId) {
    const ws = state.data.workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const n = ws.columns.reduce((sum, c) => sum + c.cards.length, 0);
    const msg = n
      ? `El espacio «${ws.title}» tiene ${n} ${n === 1 ? "tarea" : "tareas"} en ${ws.columns.length} ${ws.columns.length === 1 ? "columna" : "columnas"}. Al borrarlo, todo ese trabajo se pierde. Esta acción no se puede deshacer.`
      : `¿Seguro que querés borrar el espacio «${ws.title}»? Esta acción no se puede deshacer.`;
    ui.openConfirm({
      title: "Borrar espacio",
      message: msg,
      onConfirm: async () => {
        realtime._suppress++;
        try {
          await api.deleteWorkspace(wsId);
          state.data.workspaces = state.data.workspaces.filter(w => w.id !== wsId);
          if (state.data.workspaces.length === 0) {
            const id = await api.createWorkspace(state.user.id, "Mi primer proyecto");
            state.data.workspaces.push({ id, title: "Mi primer proyecto", labels: [], columns: [] });
          }
          state.data.activeWorkspace = state.data.workspaces[0].id;
          await this._reloadActive();
        } finally {
          setTimeout(() => { realtime._suppress--; }, 1500);
        }
        ui.toast(`Espacio «${ws.title}» eliminado.`);
      }
    });
  },

  switchWorkspace(wsId) {
    if (!state.data.workspaces.some(w => w.id === wsId)) return;
    state.data.activeWorkspace = wsId;
    this._saveActive();
    realtime.subscribe(wsId);
    renderBoard();
  },

  setFilter(q) { state.filter = q; renderBoard(); },
  setFilterPriority(v) { state.filterPriority = v; renderBoard(); },
  setFilterLabel(v) { state.filterLabel = v; renderBoard(); },

  clearFilters() {
    state.filter = "";
    state.filterPriority = "";
    state.filterLabel = "";
    $("#search").value = "";
    $("#filter-priority").value = "";
    $("#filter-label").value = "";
    renderBoard();
  },

  setTheme(theme, x = innerWidth / 2, y = innerHeight / 2) {
    const apply = () => {
      applyTheme(theme);
      setGlobalTheme(theme);
      if (state.user) prefs.save(state.user.id, { theme });
    };
    if (document.startViewTransition) {
      document.documentElement.style.setProperty("--vt-x", x + "px");
      document.documentElement.style.setProperty("--vt-y", y + "px");
      document.startViewTransition(apply);
    } else {
      apply();
    }
  },

  /* recarga el workspace activo desde la BD (fuente de verdad) */
  async _reloadActive() {
    const wsId = state.data.activeWorkspace;
    const fresh = await api.loadWorkspace(wsId);
    const ws = state.data.workspaces.find(w => w.id === wsId);
    if (ws) Object.assign(ws, fresh);
    else state.data.workspaces.push(fresh);
    renderBoard();
  },

  _saveActive() {
    if (state.user) {
      const p = prefs.load(state.user.id);
      p.activeWorkspace = state.data.activeWorkspace;
      prefs.save(state.user.id, p);
    }
  }
};

/* ── realtime: suscripción a cambios del workspace activo ── */
const realtime = {
  _channel: null,
  _debounce: null,
  _suppress: 0, // >0 = suprimir reloads (optimistic UI en curso)

  subscribe(wsId) {
    this.unsubscribe();
    if (!wsId) return;

    console.log(`[realtime] Suscribiendo a workspace ${wsId}`);

    // Canal principal: suscripción por tabla con filter donde es posible
    this._channel = sb.channel(`ws-${wsId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "columns" },
        (p) => { console.log("[realtime] columns change:", p.type, p.new?.workspace_id); this._onChange(); })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "cards" },
        (p) => { console.log("[realtime] cards change:", p.type, p.new?.id || p.old?.id); this._onCardChange(p, wsId); })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "labels" },
        (p) => { console.log("[realtime] labels change:", p.type); this._onChange(); })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "subtasks" },
        (p) => { console.log("[realtime] subtasks change:", p.type); this._onCardDataChange(p); })
      .on("postgres_changes",
        { event: "*", schema: "public", table: "comments" },
        (p) => { console.log("[realtime] comments change:", p.type); this._onCardDataChange(p); })
      .subscribe((status) => {
        console.log(`[realtime] Channel status: ${status}`);
      });

    // Canal de diagnóstico: TODO el schema, sin filter, solo para debug
    this._debugChannel = sb.channel(`debug-${wsId}`)
      .on("postgres_changes",
        { event: "*", schema: "public" },
        (p) => { console.log("[realtime:debug] ANY change:", p.table, p.type); })
      .subscribe((status) => {
        console.log(`[realtime:debug] Channel status: ${status}`);
      });
  },

  // subtasks / comments viven DENTRO del modal de edición y se guardan solos.
  // Recargar el tablero completo por cada uno DESTRUYE y reconstruye la card
  // (refresco abrupto) y puede pintarla sin el comentario nuevo. En su lugar,
  // solo refrescamos el contador de comentarios de la card en el sitio.
  _onCardDataChange(payload) {
    const row = payload.new || payload.old;
    const cardId = row && row.card_id;
    if (!cardId) return;
    // si el modal de edición está abierto, NO tocar nada: el modal ya muestra
    // los comentarios en vivo y los guarda él mismo.
    if (ui.editingCard) return;
    // actualizar el contador de comentarios de la card sin re-renderizar el board
    const cardEl = document.querySelector(`.card-item[data-id="${cardId}"]`);
    if (!cardEl) return;
    sb.from("comments").select("id", { count: "exact", head: true }).eq("card_id", cardId)
      .then(({ count }) => {
        if (count == null) return;
        let el = cardEl.querySelector(".card-comments-count");
        if (!el) {
          el = document.createElement("span");
          el.className = "card-comments-count";
          cardEl.appendChild(el);
        }
        el.title = `Comentarios: ${count}`;
        el.textContent = `💬 ${count}`;
      })
      .catch(() => {});
  },

  _onCardChange(payload, wsId) {
    // Verificar si la card pertenece a una columna de este workspace
    const row = payload.new || payload.old;
    if (!row || !row.column_id) { this._onChange(); return; }
    // Chequear si la columna es del workspace activo
    const col = state.data?.workspaces
      ?.find(w => w.id === wsId)?.columns
      ?.find(c => c.id === row.column_id);
    if (col) this._onChange();
    // Si no la encontramos localmente, igual recargamos (puede ser nueva)
    else this._onChange();
  },

  _onChange() {
    // Suprimir si hay operación optimista en curso
    if (this._suppress > 0) return;
    // Debounce: no recargar más de 1 vez cada 800 ms
    if (this._debounce) return;
    this._debounce = setTimeout(() => {
      this._debounce = null;
      if (this._suppress > 0) return;
      actions._reloadActive();
    }, 800);
  },

  unsubscribe() {
    if (this._channel) {
      sb.removeChannel(this._channel);
      this._channel = null;
    }
    if (this._debugChannel) {
      sb.removeChannel(this._debugChannel);
      this._debugChannel = null;
    }
    if (this._debounce) {
      clearTimeout(this._debounce);
      this._debounce = null;
    }
  }
};

/* ── dnd: delegación en #board ──────────────────────────── */
const dnd = {
  drag: null,
  ghost: null,
  ghostOffset: { x: 0, y: 0 },

  init() {
    const board = $("#board");

    board.addEventListener("dragstart", e => {
      const card = e.target.closest ? e.target.closest(".card-item") : null;
      const col = e.target.closest ? e.target.closest(".column") : null;
      if (card) {
        this.drag = { type: "card", cardId: card.dataset.id };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.dataset.id);
        card.classList.add("dragging");
        this._spawnGhost(card, e);
      } else if (col) {
        this.drag = { type: "column", colId: col.dataset.id };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", col.dataset.id);
        col.classList.add("col-dragging");
        this._spawnGhost(col, e);
      }
    });

    board.addEventListener("dragover", e => {
      if (!this.drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      // mover ghost custom
      if (this.ghost) {
        this.ghost.style.left = (e.clientX - this.ghostOffset.x) + "px";
        this.ghost.style.top = (e.clientY - this.ghostOffset.y) + "px";
      }

      if (this.drag.type === "card") {
        const body = e.target.closest ? e.target.closest(".col-cards") : null;
        if (!body) { this._hidePh(".drop-placeholder"); return; }
        const ph = this.ensurePh(body, ".drop-placeholder");
        ph.style.display = "";
        // copiar altura de la card arrastrada
        const draggedCard = body.querySelector(`.card-item[data-id="${this.drag.cardId}"]`);
        if (draggedCard) ph.style.height = draggedCard.offsetHeight + "px";
        const cards = $$(".card-item", body)
          .filter(c => !c.classList.contains("dragging"));
        if (cards.length === 0) {
          body.appendChild(ph);
          return;
        }
        let before = null;
        for (const c of cards) {
          const r = c.getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { before = c; break; }
        }
        // NO mostrar placeholder en la posición de la propia card arrastrada
        const draggedEl = body.querySelector(`.card-item[data-id="${this.drag.cardId}"]`);
        if (draggedEl) {
          const dr = draggedEl.getBoundingClientRect();
          // si el cursor está sobre la propia card → no mover placeholder
          if (e.clientY >= dr.top && e.clientY <= dr.bottom) {
            return;
          }
        }
        const currentBefore = ph.nextElementSibling;
        if (before !== currentBefore) {
          if (before) body.insertBefore(ph, before);
          else body.appendChild(ph);
        }
      } else {
        const ph = this.ensurePh(board, ".col-placeholder");
        ph.style.display = "";
        // copiar ancho de la columna arrastrada
        const draggedCol = board.querySelector(`.column[data-id="${this.drag.colId}"]`);
        if (draggedCol) ph.style.width = draggedCol.offsetWidth + "px";
        const cols = $$(".column", board)
          .filter(c => !c.classList.contains("col-dragging"));
        if (cols.length === 0) {
          board.appendChild(ph);
          return;
        }
        let before = null;
        for (const c of cols) {
          const r = c.getBoundingClientRect();
          if (e.clientX < r.left + r.width / 2) { before = c; break; }
        }
        // NO mostrar placeholder en la posición de la propia columna arrastrada
        if (draggedCol) {
          const dr = draggedCol.getBoundingClientRect();
          if (e.clientX >= dr.left && e.clientX <= dr.right) {
            return;
          }
        }
        const currentBefore = ph.nextElementSibling;
        if (before && before !== currentBefore) {
          board.insertBefore(ph, before);
        } else if (!before && currentBefore !== board.querySelector(".add-column")) {
          const end = board.querySelector(".add-column");
          if (end) board.insertBefore(ph, end);
          else board.appendChild(ph);
        }
      }
    });

    board.addEventListener("drop", e => {
      if (!this.drag) return;
      e.preventDefault();

      // ── FLIP: registrar posición ANTES del movimiento ──
      const el = this.drag.type === "column"
        ? board.querySelector(`.column[data-id="${this.drag.colId}"]`)
        : board.querySelector(`.card-item[data-id="${this.drag.cardId}"]`);
      const firstRect = el ? el.getBoundingClientRect() : null;

      if (this.drag.type === "column") {
        const ph = board.querySelector(".col-placeholder");
        let beforeColId = null;
        if (ph) {
          let n = ph.nextElementSibling;
          while (n && !n.classList.contains("column")) n = n.nextElementSibling;
          if (n) beforeColId = n.dataset.id;
        }
        actions.moveColumn(this.drag.colId, beforeColId);
      } else {
        const body = e.target.closest ? e.target.closest(".col-cards") : null;
        if (body) {
          const ph = body.querySelector(".drop-placeholder");
          let beforeCardId = null;
          if (ph) {
            let n = ph.nextElementSibling;
            while (n && !n.classList.contains("card-item")) n = n.nextElementSibling;
            if (n) beforeCardId = n.dataset.id;
          }
          actions.moveCard(this.drag.cardId, body.closest(".column").dataset.id, beforeCardId);
        }
      }

      // ── FLIP: animar desde la posición antigua a la nueva ──
      if (el && firstRect) {
        const lastRect = el.getBoundingClientRect();
        const dx = firstRect.left - lastRect.left;
        const dy = firstRect.top - lastRect.top;
        if (dx !== 0 || dy !== 0) {
          el.classList.add("flip-anim");
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          el.style.opacity = "0.7";
          void el.offsetWidth;
          el.style.transform = "";
          el.style.opacity = "";
          el.addEventListener("transitionend", function handler() {
            el.classList.remove("flip-anim");
            el.removeEventListener("transitionend", handler);
            el.classList.add("drop-settle");
            el.addEventListener("animationend", function settleHandler() {
              el.classList.remove("drop-settle");
              el.removeEventListener("animationend", settleHandler);
            });
          });
        }
      }
      this.cleanup();
    });

    board.addEventListener("dragend", () => this.cleanup());
  },

  _spawnGhost(sourceEl, e) {
    // clon que sigue al cursor con wobble
    const ghost = sourceEl.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.classList.remove("dragging", "col-dragging");
    const rect = sourceEl.getBoundingClientRect();
    ghost.style.width = rect.width + "px";
    ghost.style.height = rect.height + "px";
    ghost.style.left = (e.clientX - 10) + "px";
    ghost.style.top = (e.clientY - 10) + "px";
    this.ghostOffset = { x: 10, y: 10 };
    document.body.appendChild(ghost);
    this.ghost = ghost;

    // ocultar el ghost nativo del navegador (pixel transparente)
    const px = document.createElement("canvas");
    px.width = 1; px.height = 1;
    e.dataTransfer.setDragImage(px, 0, 0);
  },

  _hidePh(selector) {
    const ph = document.querySelector(selector);
    if (ph) ph.style.display = "none";
  },

  ensurePh(parent, cls) {
    let ph = parent.querySelector(cls);
    if (!ph) {
      ph = document.createElement("div");
      ph.className = cls.replace(/^\./, "");
      parent.appendChild(ph);
    }
    return ph;
  },

  cleanup() {
    $$(".drop-placeholder, .col-placeholder").forEach(p => p.remove());
    $$(".card-item.dragging, .column.col-dragging")
      .forEach(el => el.classList.remove("dragging", "col-dragging"));
    if (this.ghost) {
      this.ghost.remove();
      this.ghost = null;
    }
    this.drag = null;
  }
};

/* ── ui: modal, toast, editor inline, export/import, atajos ─ */
const ui = {
  editingCard: null,
  textModalCb: null,

  bsModal(el) { return bootstrap.Modal.getOrCreateInstance(el); },

  toast(msg, opts = {}) {
    const container = $("#toast");
    const el = document.createElement("div");
    el.className = "toast-item";
    const span = document.createElement("span");
    span.textContent = msg;
    el.appendChild(span);
    if (opts.action) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toast-action";
      b.textContent = opts.action;
      b.addEventListener("click", () => { opts.onAction(); el.remove(); });
      el.appendChild(b);
    }
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add("toast-out");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }, 5000);
  },

  openCardModal(cardId) {
    const found = findCard(cardId);
    if (!found) return;
    this.editingCard = cardId;
    $("#card-title").value = found.card.title;
    $("#card-title").classList.remove("invalid");
    $("#card-title-err").textContent = "";
    $("#card-desc").value = found.card.description || "";
    $("#card-due").value = found.card.dueDate || "";
    $("#card-priority").value = found.card.priority || "";
    const asel = $("#card-assignee");
    asel.innerHTML = "";
    const o0 = document.createElement("option");
    o0.value = ""; o0.textContent = "Sin responsable";
    asel.appendChild(o0);
    // poblar responsables en background (no bloquea la apertura)
    api.members(activeWorkspace().id).then(members => {
      if (this.editingCard !== cardId) return; // ya cerraron el modal
      // guardar en el workspace para que updateCard pueda resolver el nombre
      activeWorkspace()._members = members;
      members.forEach(m => {
        const o = document.createElement("option");
        o.value = m.id; o.textContent = m.name;
        asel.appendChild(o);
      });
      asel.value = found.card.assignee || "";
      if (asel.value !== (found.card.assignee || "")) asel.value = "";
    }).catch(() => {});
    const sel = $("#card-move");
    sel.innerHTML = "";
    activeWorkspace().columns.forEach(c => {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.title;
      if (c.id === found.col.id) o.selected = true;
      sel.appendChild(o);
    });
    this.cardLabelSel = new Set(found.card.labels || []);
    this.renderCardLabels();
    this.cardSubtasks = (found.card.subtasks || []).map(s => ({ ...s }));
    this.renderCardSubtasks();
    this.cardComments = (found.card.comments || []).map(c => ({ ...c }));
    this.renderCardComments();
    $("#card-delete").classList.remove("d-none");
    $("#card-delete-confirm").classList.add("d-none");
    this.bsModal($("#card-modal")).show();
    setTimeout(() => $("#card-title").focus(), 300);
  },

  renderCardLabels() {
    const box = $("#card-labels");
    box.innerHTML = "";
    const wsLabels = activeWorkspace().labels || [];
    wsLabels.forEach(l => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "label-chip label-edit";
      chip.style.background = l.color;
      chip.textContent = l.name;
      const on = this.cardLabelSel.has(l.id);
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-pressed", String(on));
      chip.addEventListener("click", () => {
        if (this.cardLabelSel.has(l.id)) this.cardLabelSel.delete(l.id);
        else this.cardLabelSel.add(l.id);
        this.renderCardLabels();
      });
      box.appendChild(chip);
    });
  },

  async addLabel() {
    const name = $("#label-name").value.trim();
    if (!name) { $("#label-name").focus(); return; }
    const color = $("#label-color").value || COLORS.azul;
    const ws = activeWorkspace();
    const id = await api.createLabel(ws.id, name, color);
    ws.labels = ws.labels || [];
    ws.labels.push({ id, name, color });
    this.cardLabelSel.add(id);
    $("#label-name").value = "";
    this.renderCardLabels();
  },

  renderCardSubtasks() {
    const box = $("#card-subtasks");
    box.innerHTML = "";
    this.cardSubtasks.forEach(s => {
      const li = document.createElement("label");
      li.className = "subtask";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = s.done;
      cb.addEventListener("change", () => { s.done = cb.checked; });
      const span = document.createElement("span");
      span.className = "subtask-text";
      span.textContent = s.title;
      span.classList.toggle("done", s.done);
      span.addEventListener("click", () => {
        s.done = !s.done;
        cb.checked = s.done;
        span.classList.toggle("done", s.done);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "subtask-del";
      del.textContent = "✕";
      del.setAttribute("aria-label", "Quitar subtarea");
      del.addEventListener("click", e => {
        e.preventDefault();
        this.cardSubtasks = this.cardSubtasks.filter(x => x.id !== s.id);
        this.renderCardSubtasks();
      });
      li.append(cb, span, del);
      box.appendChild(li);
    });
  },

  addSubtask() {
    const t = $("#subtask-name").value.trim();
    if (!t) { $("#subtask-name").focus(); return; }
    // id vacío = nueva: Supabase genera el UUID (no usar prefijos, la BD exige uuid)
    this.cardSubtasks.push({ id: null, title: t, done: false });
    $("#subtask-name").value = "";
    this.renderCardSubtasks();
    $("#subtask-name").focus();
  },

  renderCardComments() {
    const box = $("#card-comments");
    box.innerHTML = "";
    if (!this.cardComments.length) {
      const p = document.createElement("p");
      p.className = "comment-empty";
      p.textContent = "Sin comentarios todavía.";
      box.appendChild(p);
      return;
    }
    this.cardComments.forEach(c => {
      const item = document.createElement("div");
      item.className = "comment";
      const meta = document.createElement("div");
      meta.className = "comment-meta";
      const av = document.createElement("span");
      av.className = "comment-av";
      av.textContent = initials(c.author);
      const who = document.createElement("span");
      who.className = "comment-who";
      who.textContent = c.author;
      const when = document.createElement("span");
      when.className = "comment-when";
      when.textContent = fmtDate(c.at.slice(0, 10));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "comment-del";
      del.textContent = "✕";
      del.setAttribute("aria-label", "Eliminar comentario");
      del.addEventListener("click", () => {
        this.cardComments = this.cardComments.filter(x => x.id !== c.id);
        this.renderCardComments();
      });
      meta.append(av, who, when, del);
      const txt = document.createElement("p");
      txt.className = "comment-text";
      txt.textContent = c.text;
      item.append(meta, txt);
      box.appendChild(item);
    });
  },

  addComment() {
    const t = $("#comment-text").value.trim();
    if (!t) { $("#comment-text").focus(); return; }
    this.cardComments.push({
      id: null, // null = nuevo: Supabase genera el UUID (no usar prefijos, la BD exige uuid)
      author: state.user ? state.user.name : "Yo",
      text: t,
      at: new Date().toISOString()
    });
    $("#comment-text").value = "";
    this.renderCardComments();
    $("#comment-text").focus();
  },

  saveCard() {
    const t = $("#card-title").value.trim();
    if (!t) {
      $("#card-title").classList.add("invalid");
      $("#card-title-err").textContent = "El título no puede quedar vacío.";
      $("#card-title").focus();
      return;
    }
    const cardId = this.editingCard;
    const data = {
      title: t,
      description: $("#card-desc").value.trim(),
      dueDate: $("#card-due").value || null,
      colId: $("#card-move").value,
      priority: $("#card-priority").value || null,
      labels: [...this.cardLabelSel],
      assignee: $("#card-assignee").value || null,
      subtasks: this.cardSubtasks,
      comments: this.cardComments
    };
    // cerrar modal de inmediato
    const modalEl = $("#card-modal");
    this.bsModal(modalEl).hide();
    // guardar en background
    actions.updateCard(cardId, data).catch(err => {
      ui.toast(err.message || "No se pudo guardar la tarea.");
    });
    // animar la card cuando el modal termine de cerrarse
    modalEl.addEventListener("hidden.bs.modal", () => {
      const el = document.querySelector(`.card-item[data-id="${cardId}"]`);
      if (el) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            el.classList.add("card-updated");
            setTimeout(() => el.classList.remove("card-updated"), 850);
          });
        });
      }
    }, { once: true });
  },

  openColModal(colId) {
    const col = activeWorkspace().columns.find(c => c.id === colId);
    if (!col) return;
    this.editingCol = colId;
    $("#col-name").value = col.title;
    $("#col-name").classList.remove("invalid");
    $("#col-name-err").textContent = "";
    $("#col-wip").value = col.wipLimit || 0;
    this.colColorSel = col.color || null;
    this.renderColColors();
    this.bsModal($("#col-modal")).show();
    setTimeout(() => $("#col-name").focus(), 300);
  },

  renderColColors() {
    const box = $("#col-colors");
    box.innerHTML = "";
    const none = document.createElement("button");
    none.type = "button";
    none.className = "color-swatch color-none";
    none.textContent = "—";
    none.title = "Sin color";
    none.classList.toggle("on", this.colColorSel === null);
    none.addEventListener("click", () => {
      this.colColorSel = null;
      this.renderColColors();
    });
    box.appendChild(none);
    Object.entries(COLORS).forEach(([key, hex]) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "color-swatch";
      sw.style.background = hex;
      sw.title = key;
      sw.classList.toggle("on", this.colColorSel === hex);
      sw.addEventListener("click", () => {
        this.colColorSel = hex;
        this.renderColColors();
      });
      box.appendChild(sw);
    });
  },

  async saveCol() {
    const t = $("#col-name").value.trim();
    if (t.length < 2) {
      $("#col-name").classList.add("invalid");
      $("#col-name-err").textContent = "Poné un nombre de al menos 2 caracteres.";
      $("#col-name").focus();
      return;
    }
    const wip = parseInt($("#col-wip").value, 10) || 0;
    try {
      await actions.updateColumn(this.editingCol, {
        title: t,
        color: this.colColorSel,
        wipLimit: wip
      });
    } catch (err) {
      ui.toast(err.message || "No se pudo guardar la columna.");
      return;
    }
    this.bsModal($("#col-modal")).hide();
  },

  openInlineEditor(colId) {
    $$(".inline-editor").forEach(e => e.remove());
    const col = activeWorkspace().columns.find(c => c.id === colId);
    if (!col) return;
    const body = $(`.column[data-id="${colId}"] .col-cards`);
    const empty = body.querySelector(".col-empty");

    const ed = document.createElement("div");
    ed.className = "inline-editor";
    ed.innerHTML =
      `<div class="field">
         <label>Título</label>
         <input class="form-control ie-title" type="text" placeholder="Qué hay que hacer">
         <div class="field-error ie-err" aria-live="polite"></div>
       </div>
       <div class="field">
         <label>Descripción (opcional)</label>
         <textarea class="form-control ie-desc" rows="2"></textarea>
       </div>
       <div class="field">
         <label>Fecha de vencimiento (opcional)</label>
         <input type="date" class="form-control ie-due">
       </div>
       <div class="ie-actions">
         <button class="btn btn-primary btn-retro btn-sm ie-save" type="button">Guardar</button>
         <button class="btn btn-retro btn-sm ie-cancel" type="button">Cancelar</button>
       </div>`;
    body.prepend(ed);
    if (empty) empty.classList.add("d-none");

    const title = $(".ie-title", ed);
    const err = $(".ie-err", ed);
    title.focus();

    const save = () => {
      const t = title.value.trim();
      if (!t) {
        title.classList.add("invalid");
        err.textContent = "El título no puede quedar vacío.";
        title.focus();
        return;
      }
      actions.addCard(colId, {
        title: t,
        description: $(".ie-desc", ed).value.trim(),
        dueDate: $(".ie-due", ed).value || null
      });
    };
    $(".ie-save", ed).addEventListener("click", save);
    $(".ie-cancel", ed).addEventListener("click", () => ed.remove());
    title.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") ed.remove();
    });
  },

  openTextModal({ label, value = "", placeholder = "", onSave }) {
    $("#text-label").textContent = label;
    const inp = $("#text-input");
    inp.value = value;
    inp.placeholder = placeholder;
    inp.classList.remove("invalid");
    $("#text-err").textContent = "";
    this.textModalCb = async t => {
      const v = t.trim();
      if (v.length < 2) {
        inp.classList.add("invalid");
        $("#text-err").textContent = "Poné un nombre de al menos 2 caracteres.";
        inp.focus();
        return false;
      }
      if (v.length > 40) {
        inp.classList.add("invalid");
        $("#text-err").textContent = "El nombre no puede superar 40 caracteres.";
        return false;
      }
      try { await onSave(v); }
      catch (err) {
        $("#text-err").textContent = err.message || "Ocurrió un error.";
        return false;
      }
      return true;
    };
    this.bsModal($("#text-modal")).show();
    setTimeout(() => { inp.focus(); inp.select(); }, 300);
  },

  openConfirm({ title = "Confirmar", message = "", confirmLabel = "Eliminar", onConfirm }) {
    $("#confirm-title").textContent = title;
    $("#confirm-msg").textContent = message;
    const yes = $("#confirm-yes");
    yes.textContent = confirmLabel;
    this.confirmCb = onConfirm;
    this.bsModal($("#confirm-modal")).show();
    setTimeout(() => yes.focus(), 300);
  },

  async openMembersModal() {
    const wsId = activeWorkspace().id;
    const meId = state.user ? state.user.id : null;
    const list = $("#members-list");
    list.innerHTML = '<li class="text-muted">Cargando…</li>';
    this.bsModal($("#members-modal")).show();
    try {
      const members = await api.members(wsId);
      list.innerHTML = "";
      members.forEach(m => {
        const li = document.createElement("li");
        li.className = "d-flex align-items-center justify-content-between gap-2 py-1";
        const info = document.createElement("span");
        const roleTag = m.role === "owner" ? " (propietario)" : " (editor)";
        const meTag = m.id === meId ? " (Tú)" : "";
        info.textContent = m.name + roleTag + meTag;
        li.appendChild(info);
        if (m.id !== meId && m.role !== "owner") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn btn-sm btn-outline-danger";
          btn.textContent = "Expulsar";
          btn.addEventListener("click", () => {
            ui.openConfirm({
              title: "Expulsar miembro",
              message: `¿Expulsar a ${m.name} de este espacio?`,
              confirmLabel: "Expulsar",
              onConfirm: async () => {
                realtime._suppress++;
                try {
                  await api.removeMember(wsId, m.id);
                  ui.toast(`${m.name} fue expulsado del espacio.`);
                  ui.openMembersModal();
                  await actions._reloadActive();
                } finally {
                  setTimeout(() => { realtime._suppress--; }, 1500);
                }
              }
            });
          });
          li.appendChild(btn);
        }
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = `<li class="text-danger">${e.message}</li>`;
    }
  },

  exportWs() {
    const ws = activeWorkspace();
    const payload = { app: "ruta", version: 1, workspace: ws };
    const blob = new Blob([JSON.stringify(payload, null, 2)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ruta-${slug(ws.title)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  },

  importWs() {
    this.toast("La importación de copias se habilitará en una próxima versión (los datos viven en la base de datos).");
  },

  trapFocus(modalEl) {
    modalEl.addEventListener("keydown", e => {
      if (e.key !== "Tab") return;
      const focusables = $$("button, input, select, textarea, [tabindex]", modalEl)
        .filter(el => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }
};

/* ── vistas: auth / app ─────────────────────────────────── */
function replayViewIn(el) {
  el.classList.remove("view-in");
  void el.offsetWidth; // reflow para reiniciar la animación
  el.classList.add("view-in");
}

function animateHeight(content) {
  const from = content.offsetHeight;
  // altura natural real (con padding y borde) con el panel ya activo
  content.style.height = "auto";
  const to = content.offsetHeight;
  if (from === to) return;
  content.style.height = from + "px";
  void content.offsetWidth; // reflow para fijar el punto de partida
  content.style.transition = "height .3s ease";
  content.style.height = to + "px";
  setTimeout(() => {
    content.style.height = "";
    content.style.transition = "";
  }, 320);
}

function showAuth() {
  $("#app-view").classList.add("d-none");
  $("#auth-view").classList.remove("d-none");
  replayViewIn($("#auth-view .auth-terminal"));
  $("#login-form").reset();
  $("#register-form").reset();
  $$(".field-error").forEach(e => e.textContent = "");
}

async function enterApp(user) {
  state.user = user;
  const workspaces = await api.loadWorkspaces(user.id);
  const p = prefs.load(user.id);
  state.data = {
    activeWorkspace: p.activeWorkspace || (workspaces[0] && workspaces[0].id) || null,
    workspaces
  };
  if (!state.data.activeWorkspace && workspaces.length === 0) {
    const id = await api.createWorkspace(user.id, "Mi primer proyecto");
    state.data.workspaces.push({ id, title: "Mi primer proyecto", labels: [], columns: [] });
    state.data.activeWorkspace = id;
  }
  state.filter = "";
  state.filterPriority = "";
  state.filterLabel = "";
  $("#search").value = "";
  $("#filter-priority").value = "";
  $("#filter-label").value = "";
  applyTheme(getGlobalTheme() || p.theme || "claro");
  setGlobalTheme(state.theme); // sincroniza para la próxima vez en auth
  if (state.user) prefs.save(state.user.id, { ...p, theme: state.theme });
  $("#auth-view").classList.add("d-none");
  $("#app-view").classList.remove("d-none");
  replayViewIn($("#app-view"));
  realtime.subscribe(state.data.activeWorkspace);
  renderBoard();
}

async function doLogout() {
  withLoading("Cerrando sesión…", async () => {
    realtime.unsubscribe();
    await auth.logout();
    state.user = null;
    state.data = null;
    showAuth();
  });
}

/* ── pantalla de carga pseudo (2 s) ─────────────────────── */
function withLoading(msg, fn) {
  const ov = $("#loading-overlay");
  $("#loading-msg").textContent = msg;
  ov.classList.remove("show");
  void ov.offsetWidth; // reflow para reiniciar la barra de progreso
  ov.classList.add("show");
  setTimeout(() => {
    ov.classList.remove("show");
    fn();
  }, 2000);
}

/* ── bindings ───────────────────────────────────────────── */
function setFieldError(inputId, errId, msg) {
  $(inputId).classList.toggle("invalid", !!msg);
  $(errId).textContent = msg;
}

function bindAuth() {
  $("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("#login-email").value;
    const pass = $("#login-pass").value;
    const e1 = validators.email(email);
    const e2 = pass ? "" : "Ingresá tu contraseña.";
    setFieldError("#login-email", "#login-email-err", e1);
    setFieldError("#login-pass", "#login-pass-err", e2);
    if (e1 || e2) return;
    try {
      const user = await auth.login(email, pass);
      withLoading("Cargando tu tablero…", () => enterApp(user));
    } catch (err) {
      $("#login-form-err").textContent = err.message;
    }
  });

  $("#register-form").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#reg-name").value;
    const email = $("#reg-email").value;
    const pass = $("#reg-pass").value;
    const pass2 = $("#reg-pass2").value;
    const e1 = validators.name(name);
    const e2 = validators.email(email);
    const e3 = validators.pass(pass);
    const e4 = validators.confirm(pass2, pass);
    setFieldError("#reg-name", "#reg-name-err", e1);
    setFieldError("#reg-email", "#reg-email-err", e2);
    setFieldError("#reg-pass", "#reg-pass-err", e3);
    setFieldError("#reg-pass2", "#reg-pass2-err", e4);
    if (e1 || e2 || e3 || e4) return;
    try {
      const user = await auth.register(name, email, pass);
      withLoading("Preparando tu tablero…", () => enterApp(user));
    } catch (err) {
      $("#register-form-err").textContent = err.message;
    }
  });

  // animación de altura al alternar Ingresar / Crear cuenta
  document.addEventListener("shown.bs.tab", e => {
    if (!e.target.closest || !e.target.closest(".auth-tabs")) return;
    const content = $("#auth-view .auth-content");
    const pane = content.querySelector(".tab-pane.show");
    if (pane) animateHeight(content, pane);
  });

  $("#link-to-register").addEventListener("click", e => {
    e.preventDefault();
    bootstrap.Tab.getOrCreateInstance($("#tab-register")).show();
  });
  $("#link-to-login").addEventListener("click", e => {
    e.preventDefault();
    bootstrap.Tab.getOrCreateInstance($("#tab-login")).show();
  });

  // selector de tema en vista de acceso
  const authThemePicker = $(".auth-theme-picker");
  const authThemeBtn = $("#auth-theme-btn");
  authThemeBtn.addEventListener("click", e => {
    e.stopPropagation();
    authThemePicker.classList.toggle("show-menu");
  });
  document.addEventListener("click", e => {
    if (!e.target.closest(".auth-theme-picker"))
      authThemePicker.classList.remove("show-menu");
  });
  $$("#auth-theme-menu .dropdown-item").forEach(b =>
    b.addEventListener("click", e => {
      actions.setTheme(b.dataset.themeChoice, e.clientX, e.clientY);
      authThemePicker.classList.remove("show-menu");
    }));

  // mostrar / ocultar contraseña
  $$(".pass-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const inp = document.getElementById(btn.dataset.target);
      if (!inp) return;
      const showing = inp.type === "text";
      inp.type = showing ? "password" : "text";
      btn.classList.toggle("showing", !showing);
      btn.setAttribute("aria-pressed", String(!showing));
      btn.setAttribute("aria-label", showing ? "Mostrar contraseña" : "Ocultar contraseña");
    });
  });
}

function bindApp() {
  $("#logout").addEventListener("click", doLogout);
  $("#user-logout").addEventListener("click", doLogout);

  $$("#theme-menu .dropdown-item").forEach(b =>
    b.addEventListener("click", e =>
      actions.setTheme(b.dataset.themeChoice, e.clientX, e.clientY)));

  $("#search").addEventListener("input", e => actions.setFilter(e.target.value));
  $("#filter-priority").addEventListener("change", e => actions.setFilterPriority(e.target.value));
  $("#filter-label").addEventListener("change", e => actions.setFilterLabel(e.target.value));
  $("#filter-clear").addEventListener("click", () => actions.clearFilters());

  $("#user-export").addEventListener("click", () => ui.exportWs());
  $("#user-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", e => {
    const file = e.target.files[0];
    if (file) ui.importWs(file);
    e.target.value = "";
  });

  // modal de tarjeta
  $("#card-save").addEventListener("click", () => ui.saveCard());
  $("#card-form").addEventListener("submit", e => {
    e.preventDefault();
    ui.saveCard();
  });
  $("#card-delete").addEventListener("click", () => {
    $("#card-delete").classList.add("d-none");
    $("#card-delete-confirm").classList.remove("d-none");
    $("#card-delete-yes").focus();
  });
  $("#card-delete-yes").addEventListener("click", () => {
    const id = ui.editingCard;
    ui.bsModal($("#card-modal")).hide();
    actions.deleteCard(id);
  });
  $("#card-delete-no").addEventListener("click", () => {
    $("#card-delete").classList.remove("d-none");
    $("#card-delete-confirm").classList.add("d-none");
  });
  $("#label-add").addEventListener("click", () => ui.addLabel());
  $("#label-name").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); ui.addLabel(); }
  });
  $("#subtask-add").addEventListener("click", () => ui.addSubtask());
  $("#subtask-name").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); ui.addSubtask(); }
  });
  $("#comment-add").addEventListener("click", () => ui.addComment());

  // modal de columna
  $("#col-save").addEventListener("click", () => ui.saveCol());
  $("#col-form").addEventListener("submit", e => {
    e.preventDefault();
    ui.saveCol();
  });

  // modal de texto
  const textSave = async () => {
    if (ui.textModalCb && await ui.textModalCb($("#text-input").value))
      ui.bsModal($("#text-modal")).hide();
  };
  $("#text-save").addEventListener("click", textSave);
  $("#text-form").addEventListener("submit", e => { e.preventDefault(); textSave(); });

  // modal de confirmación (borrado de columna / espacio)
  $("#confirm-yes").addEventListener("click", () => {
    const cb = ui.confirmCb;
    ui.confirmCb = null;
    ui.bsModal($("#confirm-modal")).hide();
    if (cb) cb();
  });

  // atajos de teclado
  document.addEventListener("keydown", e => {
    if (!state.user) return;
    if (e.key === "Escape") {
      const ed = $(".inline-editor");
      if (ed) ed.remove();
      return;
    }
    const tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      const first = activeWorkspace().columns[0];
      if (first) ui.openInlineEditor(first.id);
    } else if (e.key === "/") {
      e.preventDefault();
      $("#search").focus();
    }
  });

  // (la sincronización en vivo llega en la Fase 3 con Supabase Realtime)

  // focus trap en modales
  ui.trapFocus($("#card-modal"));
  ui.trapFocus($("#text-modal"));
  ui.trapFocus($("#confirm-modal"));
  ui.trapFocus($("#col-modal"));
}

/* ── init ───────────────────────────────────────────────── */
async function init() {
  bindAuth();
  bindApp();
  dnd.init();

  // aplicar tema guardado (global o por usuario) antes de mostrar cualquier vista
  applyTheme(getGlobalTheme());

  const session = await auth.currentSession();
  if (session) {
    withLoading("Cargando tu tablero…", async () => {
      try {
        await enterApp(session.user);
      } catch {
        // Sesión inválida o perfil inexistente: limpiar y mostrar login
        await auth.logout();
        showAuth();
      }
    });
  } else {
    showAuth();
  }
}

document.addEventListener("DOMContentLoaded", init);

/* ------------------ test hooks ------------------ */
window.__test = { auth, state, actions, ui, renderBoard };
