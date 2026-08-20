import { isConfigured, initFirebase } from "./firebase-init.js";

// ------------------------------------------------------------------
// STORE — abstraction Firestore (partagé) ou localStorage (démo locale)
// ------------------------------------------------------------------
let db = null;
let fs = null; // firestore module functions, loaded lazily only if configured
let useFirestore = false;

const LOCAL_PREFIX = "bolandoz40_";

function localGetAll(coll) {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_PREFIX + coll) || "[]");
  } catch { return []; }
}
function localSetAll(coll, arr) {
  localStorage.setItem(LOCAL_PREFIX + coll, JSON.stringify(arr));
}
function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const localListeners = {}; // coll -> Set(callback)
function localNotify(coll) {
  (localListeners[coll] || []).forEach(cb => cb(localGetAll(coll)));
}

const Store = {
  subscribe(coll, cb) {
    if (useFirestore) {
      const colRef = fs.collection(db, "bolandoz40", "data", coll);
      return fs.onSnapshot(colRef, (snap) => {
        const arr = [];
        snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
        cb(arr);
      }, (err) => console.error("Firestore onSnapshot error", coll, err));
    } else {
      localListeners[coll] = localListeners[coll] || new Set();
      localListeners[coll].add(cb);
      cb(localGetAll(coll));
      return () => localListeners[coll].delete(cb);
    }
  },
  async add(coll, data) {
    if (useFirestore) {
      const colRef = fs.collection(db, "bolandoz40", "data", coll);
      await fs.addDoc(colRef, { ...data, createdAt: Date.now() });
    } else {
      const arr = localGetAll(coll);
      arr.push({ id: uid(), ...data, createdAt: Date.now() });
      localSetAll(coll, arr);
      localNotify(coll);
    }
  },
  async update(coll, id, data) {
    if (useFirestore) {
      const docRef = fs.doc(db, "bolandoz40", "data", coll, id);
      await fs.updateDoc(docRef, data);
    } else {
      const arr = localGetAll(coll).map(x => x.id === id ? { ...x, ...data } : x);
      localSetAll(coll, arr);
      localNotify(coll);
    }
  },
  async remove(coll, id) {
    if (useFirestore) {
      const docRef = fs.doc(db, "bolandoz40", "data", coll, id);
      await fs.deleteDoc(docRef);
    } else {
      const arr = localGetAll(coll).filter(x => x.id !== id);
      localSetAll(coll, arr);
      localNotify(coll);
    }
  },
  async seedIfEmpty(coll, items) {
    if (useFirestore) {
      const colRef = fs.collection(db, "bolandoz40", "data", coll);
      const snap = await fs.getDocs(colRef);
      if (!snap.empty) return false;
      for (const item of items) await fs.addDoc(colRef, { ...item, createdAt: Date.now() });
      return true;
    } else {
      const existing = localGetAll(coll);
      if (existing.length) return false;
      const arr = items.map(it => ({ id: uid(), ...it, createdAt: Date.now() }));
      localSetAll(coll, arr);
      localNotify(coll);
      return true;
    }
  },
  async getAllOnce(coll) {
    if (useFirestore) {
      const colRef = fs.collection(db, "bolandoz40", "data", coll);
      const snap = await fs.getDocs(colRef);
      const arr = [];
      snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
      return arr;
    } else {
      return localGetAll(coll);
    }
  }
};

// ------------------------------------------------------------------
// INIT
// ------------------------------------------------------------------
async function boot() {
  if (isConfigured) {
    try {
      const result = await initFirebase();
      db = result.db;
      fs = result.fs;
      await new Promise((resolve) => {
        result.onAuthStateChanged(result.auth, (user) => {
          if (user) resolve();
          else result.signInAnonymously(result.auth).catch((err) => { console.error(err); resolve(); });
        });
      });
      useFirestore = true;
    } catch (e) {
      console.error("Firebase indisponible, bascule en mode local.", e);
      useFirestore = false;
      document.getElementById("config-banner").classList.remove("hidden");
    }
  } else {
    document.getElementById("config-banner").classList.remove("hidden");
  }
  await migrateOrSeedTodos();
  initNav();
  initCountdown();
  initGuests();
  initBudget();
  initTasks();
  document.getElementById("btn-seed").addEventListener("click", runSeed);
}

// ------------------------------------------------------------------
// MIGRATION — fusion des anciennes listes "tasks" + "supplies" en une
// seule liste "todos". Ne s'exécute qu'une fois (si "todos" est vide) :
// si des tâches/articles existaient déjà (même modifiés), ils sont
// repris tels quels ; sinon la liste fusionnée de départ est utilisée.
// ------------------------------------------------------------------
function taskToTodo(t) {
  return {
    title: t.title || "(sans titre)",
    category: t.category === "Déco/Matériel" ? "Déco" : (t.category || "Divers"),
    quantity: "",
    owner: t.assignee || "",
    due: t.due || "",
    status: t.status === "En cours" ? "Réservé" : (t.status || "À faire"),
    notes: t.notes || ""
  };
}
function supplyToTodo(s) {
  return {
    title: s.item || "(sans titre)",
    category: s.category || "Divers",
    quantity: s.quantity || "",
    owner: s.owner || "",
    due: "",
    status: s.purchased ? "Fait" : "À faire",
    notes: s.notes || ""
  };
}
async function migrateOrSeedTodos() {
  const existingTodos = await Store.getAllOnce("todos");
  if (existingTodos.length) return;
  const oldTasks = await Store.getAllOnce("tasks");
  const oldSupplies = await Store.getAllOnce("supplies");
  let merged;
  if (oldTasks.length || oldSupplies.length) {
    merged = [...oldTasks.map(taskToTodo), ...oldSupplies.map(supplyToTodo)];
  } else {
    merged = todosSeed;
  }
  for (const item of merged) await Store.add("todos", item);
}

// ------------------------------------------------------------------
// NAVIGATION
// ------------------------------------------------------------------
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  closeSheet();
  window.scrollTo(0, 0);
}
function openSheet() { document.getElementById("more-sheet").classList.remove("hidden"); }
function closeSheet() { document.getElementById("more-sheet").classList.add("hidden"); }

function initNav() {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.view === "more") { openSheet(); return; }
      showView(btn.dataset.view);
    });
  });
  document.querySelectorAll(".sheet-item[data-view]").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
  document.getElementById("more-backdrop").addEventListener("click", closeSheet);
  document.getElementById("btn-close-sheet").addEventListener("click", closeSheet);
}

// ------------------------------------------------------------------
// COUNTDOWN
// ------------------------------------------------------------------
function initCountdown() {
  const target = new Date("2026-09-26T14:00:00+02:00").getTime();
  function tick() {
    const now = Date.now();
    const diff = target - now;
    const el = document.getElementById("countdown");
    if (diff <= 0) { el.textContent = "C'est le grand jour ! 🎉"; return; }
    const days = Math.floor(diff / 86400000);
    el.textContent = `J-${days} avant Bolandoz`;
  }
  tick();
  setInterval(tick, 3600000);
}

// ------------------------------------------------------------------
// MODAL HELPER
// ------------------------------------------------------------------
function openModal(title, fieldsHtml, { onSave, onDelete, saveLabel = "Enregistrer" }) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box">
        <h3>${title}</h3>
        <form id="modal-form">${fieldsHtml}</form>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="modal-cancel">Annuler</button>
          <button type="button" class="btn-primary" id="modal-save">${saveLabel}</button>
        </div>
        ${onDelete ? `<button type="button" class="btn-danger" id="modal-delete">🗑️ Supprimer</button>` : ""}
      </div>
    </div>`;
  const close = () => { root.innerHTML = ""; };
  root.querySelector(".modal-backdrop").addEventListener("click", (e) => { if (e.target.classList.contains("modal-backdrop")) close(); });
  root.querySelector("#modal-cancel").addEventListener("click", close);
  root.querySelector("#modal-save").addEventListener("click", async () => {
    const form = root.querySelector("#modal-form");
    const data = {};
    form.querySelectorAll("[name]").forEach(el => {
      if (el.type === "checkbox") data[el.name] = el.checked;
      else if (el.type === "number") data[el.name] = el.value === "" ? 0 : Number(el.value);
      else data[el.name] = el.value;
    });
    await onSave(data);
    close();
  });
  if (onDelete) {
    root.querySelector("#modal-delete").addEventListener("click", async () => {
      if (confirm("Supprimer cet élément ?")) { await onDelete(); close(); }
    });
  }
}

function tag(text, color) { return `<span class="tag tag-${color}">${text}</span>`; }
const STATUS_COLOR = { "Confirmé": "green", "En attente": "yellow", "Décliné": "red", "À faire": "red", "En cours": "yellow", "Fait": "green", "Réservé": "blue", "Payé": "green" };

// ------------------------------------------------------------------
// INVITÉS
// ------------------------------------------------------------------
let guestsData = [];
let guestFilter = "Tous";

function initGuests() {
  Store.subscribe("guests", (arr) => { guestsData = arr; renderGuests(); });
  document.getElementById("btn-add-guest").addEventListener("click", () => openGuestModal(null));
  document.getElementById("guests-search").addEventListener("input", renderGuests);
}

function renderGuestFilters() {
  const wrap = document.getElementById("guests-filters");
  const options = ["Tous", "Confirmé", "En attente", "Décliné"];
  wrap.innerHTML = options.map(o => `<button class="chip ${o === guestFilter ? "active" : ""}" data-f="${o}">${o}</button>`).join("");
  wrap.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => { guestFilter = c.dataset.f; renderGuests(); }));
}

function renderGuests() {
  renderGuestFilters();
  const q = (document.getElementById("guests-search").value || "").toLowerCase();
  const list = document.getElementById("guests-list");
  let items = guestsData.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (guestFilter !== "Tous") items = items.filter(g => g.status === guestFilter);
  if (q) items = items.filter(g => (g.name || "").toLowerCase().includes(q));

  const confirmedCount = guestsData.filter(g => g.status === "Confirmé")
    .reduce((sum, g) => sum + 1 + (g.adults || 0) + (g.kids || 0), 0);
  document.getElementById("stat-guests").textContent = confirmedCount;

  if (!items.length) { list.innerHTML = `<div class="empty-state">Aucun invité pour l'instant.<br>Touchez "+ Ajouter" pour commencer.</div>`; return; }
  list.innerHTML = items.map(g => `
    <div class="list-item" data-id="${g.id}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(g.name || "(sans nom)")}</div>
        <div class="list-item-sub">${g.group || ""}${g.adults ? ` · +${g.adults} adulte(s)` : ""}${g.kids ? ` · ${g.kids} enfant(s)` : ""}${g.room ? ` · Chambre ${escapeHtml(g.room)}` : ""}</div>
        <div class="list-item-tags">
          ${tag(g.status || "En attente", STATUS_COLOR[g.status] || "gray")}
          ${g.lodging ? tag("Couchage Colo", "blue") : ""}
          ${g.team ? tag(g.team, "purple") : ""}
          ${g.diet ? tag(escapeHtml(g.diet), "orange") : ""}
        </div>
      </div>
      <div class="list-item-actions">
        <button class="icon-btn edit-guest">✏️</button>
      </div>
    </div>`).join("");
  list.querySelectorAll(".list-item").forEach(el => {
    el.querySelector(".edit-guest").addEventListener("click", () => openGuestModal(guestsData.find(g => g.id === el.dataset.id)));
  });
}

function openGuestModal(guest) {
  const fields = `
    <div class="field"><label>Nom</label><input name="name" value="${guest ? escapeAttr(guest.name) : ""}" required></div>
    <div class="field-row">
      <div class="field"><label>Statut</label>
        <select name="status">
          ${["En attente", "Confirmé", "Décliné"].map(s => `<option ${guest && guest.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
      <div class="field"><label>Groupe</label>
        <select name="group">
          ${["Anaïs", "Anne-Sophie", "Les deux"].map(s => `<option ${guest && guest.group === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Accompagnants adultes</label><input type="number" name="adults" min="0" value="${guest ? guest.adults || 0 : 0}"></div>
      <div class="field"><label>Enfants</label><input type="number" name="kids" min="0" value="${guest ? guest.kids || 0 : 0}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Chambre / dortoir</label><input name="room" value="${guest ? escapeAttr(guest.room) : ""}"></div>
      <div class="field"><label>Équipe Olympiades</label>
        <select name="team"><option value="">–</option>${["Équipe 1", "Équipe 2", "Équipe 3", "Équipe 4"].map(s => `<option ${guest && guest.team === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field"><label>Régime / allergies</label><input name="diet" value="${guest ? escapeAttr(guest.diet) : ""}"></div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" name="lodging" style="width:auto;" ${guest && guest.lodging ? "checked" : ""}> Couchage à la Colo</label></div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" name="reminderSent" style="width:auto;" ${guest && guest.reminderSent ? "checked" : ""}> Rappel draps + tenue envoyé</label></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${guest ? escapeHtml(guest.notes || "") : ""}</textarea></div>
  `;
  openModal(guest ? "Modifier l'invité" : "Ajouter un invité", fields, {
    saveLabel: "Enregistrer",
    onSave: async (data) => {
      if (guest) await Store.update("guests", guest.id, data);
      else await Store.add("guests", data);
    },
    onDelete: guest ? async () => Store.remove("guests", guest.id) : null
  });
}

// ------------------------------------------------------------------
// BUDGET
// ------------------------------------------------------------------
let budgetData = [];
function initBudget() {
  Store.subscribe("budget", (arr) => { budgetData = arr; renderBudget(); });
  document.getElementById("btn-add-budget").addEventListener("click", () => openBudgetModal(null));
}

function renderBudget() {
  const list = document.getElementById("budget-list");
  const items = budgetData.slice().sort((a, b) => (b.estimated || 0) - (a.estimated || 0));
  const totalEst = budgetData.reduce((s, b) => s + (Number(b.estimated) || 0), 0);
  const totalReal = budgetData.reduce((s, b) => s + (Number(b.actual) || 0), 0);
  document.getElementById("budget-total-estime").textContent = totalEst.toLocaleString("fr-FR") + " €";
  document.getElementById("budget-total-reel").textContent = totalReal.toLocaleString("fr-FR") + " €";
  document.getElementById("budget-total-ecart").textContent = (totalReal - totalEst).toLocaleString("fr-FR") + " €";
  document.getElementById("stat-budget").textContent = totalReal.toLocaleString("fr-FR");

  if (!items.length) { list.innerHTML = `<div class="empty-state">Aucun poste de budget. Importez les données de départ depuis "Plus".</div>`; return; }
  list.innerHTML = items.map(b => `
    <div class="list-item" data-id="${b.id}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(b.label)}</div>
        <div class="list-item-sub">Estimé ${Number(b.estimated || 0).toLocaleString("fr-FR")} € · Réel ${Number(b.actual || 0).toLocaleString("fr-FR")} €</div>
        <div class="list-item-tags">
          ${tag(b.category || "Divers", "gray")}
          ${tag(b.status || "À faire", STATUS_COLOR[b.status] || "gray")}
        </div>
      </div>
      <div class="list-item-actions"><button class="icon-btn edit-budget">✏️</button></div>
    </div>`).join("");
  list.querySelectorAll(".list-item").forEach(el => {
    el.querySelector(".edit-budget").addEventListener("click", () => openBudgetModal(budgetData.find(b => b.id === el.dataset.id)));
  });
}

function openBudgetModal(item) {
  const cats = ["Lieu", "Méchoui/Traiteur", "Boissons", "Déco", "DJ/Photobooth", "Olympiades", "Divers"];
  const fields = `
    <div class="field"><label>Poste</label><input name="label" value="${item ? escapeAttr(item.label) : ""}" required></div>
    <div class="field"><label>Catégorie</label><select name="category">${cats.map(c => `<option ${item && item.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
    <div class="field-row">
      <div class="field"><label>Estimé (€)</label><input type="number" name="estimated" value="${item ? item.estimated || 0 : 0}"></div>
      <div class="field"><label>Réel (€)</label><input type="number" name="actual" value="${item ? item.actual || 0 : 0}"></div>
    </div>
    <div class="field"><label>Statut</label><select name="status">${["À faire", "Réservé", "Payé"].map(s => `<option ${item && item.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${item ? escapeHtml(item.notes || "") : ""}</textarea></div>
  `;
  openModal(item ? "Modifier le poste" : "Nouveau poste de budget", fields, {
    onSave: async (data) => { if (item) await Store.update("budget", item.id, data); else await Store.add("budget", data); },
    onDelete: item ? async () => Store.remove("budget", item.id) : null
  });
}

// ------------------------------------------------------------------
// À FAIRE (fusion tâches + matériel & courses)
// Catégories combinées des deux anciennes listes.
// Statuts : À faire / Réservé / Fait.
// ------------------------------------------------------------------
const TODO_CATEGORIES = ["Lieu", "Menu", "Boissons", "Déco", "Cuisine/Buffet", "Olympiades", "Hébergement", "Invités", "Communication", "Hygiène/Logistique", "Divers"];
const TODO_STATUSES = ["À faire", "Réservé", "Fait"];
const TODO_STATUS_ICON = { "À faire": "⬜️", "Réservé": "🟡", "Fait": "✅" };
let tasksData = [];
function initTasks() {
  Store.subscribe("todos", (arr) => { tasksData = arr; renderTasks(); renderHomeTasks(); });
  document.getElementById("btn-add-task").addEventListener("click", () => openTaskModal(null));
}

function renderTasks() {
  const list = document.getElementById("tasks-list");
  const items = tasksData.slice().sort((a, b) => {
    if ((a.status === "Fait") !== (b.status === "Fait")) return a.status === "Fait" ? 1 : -1;
    return (a.due || "9999").localeCompare(b.due || "9999");
  });
  const remaining = tasksData.filter(t => t.status !== "Fait").length;
  document.getElementById("stat-tasks").textContent = remaining;
  if (!items.length) { list.innerHTML = `<div class="empty-state">Rien pour l'instant. Importez les données de départ depuis "Plus".</div>`; return; }
  list.innerHTML = items.map(t => `
    <div class="list-item" data-id="${t.id}" style="${t.status === "Fait" ? "opacity:.55;" : ""}">
      <button class="checkbox-btn toggle-task">${TODO_STATUS_ICON[t.status] || "⬜️"}</button>
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(t.title)}</div>
        <div class="list-item-sub">${[t.quantity, t.owner, t.due ? "Échéance : " + formatDate(t.due) : ""].filter(Boolean).map(escapeHtml).join(" · ")}</div>
        <div class="list-item-tags">${tag(t.category || "Divers", "gray")}${tag(t.status || "À faire", STATUS_COLOR[t.status] || "gray")}</div>
        ${t.notes ? `<div class="list-item-sub" style="margin-top:3px;font-style:italic;">${escapeHtml(t.notes)}</div>` : ""}
      </div>
      <div class="list-item-actions"><button class="icon-btn edit-task">✏️</button></div>
    </div>`).join("");
  list.querySelectorAll(".list-item").forEach(el => {
    el.querySelector(".edit-task").addEventListener("click", () => openTaskModal(tasksData.find(t => t.id === el.dataset.id)));
    el.querySelector(".toggle-task").addEventListener("click", () => {
      const t = tasksData.find(t => t.id === el.dataset.id);
      const next = TODO_STATUSES[(TODO_STATUSES.indexOf(t.status) + 1) % TODO_STATUSES.length];
      Store.update("todos", t.id, { status: next });
    });
  });
}

function renderHomeTasks() {
  const wrap = document.getElementById("home-next-tasks");
  const items = tasksData.filter(t => t.status !== "Fait").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).slice(0, 4);
  if (!items.length) { wrap.innerHTML = `<p style="font-size:13px;color:var(--muted);">Rien en attente 🎉</p>`; return; }
  wrap.innerHTML = items.map(t => `<p style="font-size:13.5px;margin:4px 0;">▸ <strong>${escapeHtml(t.title)}</strong>${t.due ? " — " + formatDate(t.due) : ""}</p>`).join("");
}

function formatDate(iso) {
  try { const d = new Date(iso); return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); } catch { return iso; }
}

function openTaskModal(item) {
  const fields = `
    <div class="field"><label>Titre</label><input name="title" value="${item ? escapeAttr(item.title) : ""}" required></div>
    <div class="field-row">
      <div class="field"><label>Catégorie</label><select name="category">${TODO_CATEGORIES.map(c => `<option ${item && item.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label>Quantité <span style="font-weight:400;">(optionnel)</span></label><input name="quantity" placeholder="ex. 30 m, 6 kg…" value="${item ? escapeAttr(item.quantity) : ""}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Qui s'en charge</label><input name="owner" list="owner-list" placeholder="Anaïs, Anne-Sophie…" value="${item ? escapeAttr(item.owner) : ""}"></div>
      <div class="field"><label>Échéance <span style="font-weight:400;">(optionnel)</span></label><input type="date" name="due" value="${item ? item.due || "" : ""}"></div>
    </div>
    <datalist id="owner-list"><option value="Anaïs"><option value="Anne-Sophie"><option value="Les deux"></datalist>
    <div class="field"><label>Statut</label><select name="status">${TODO_STATUSES.map(s => `<option ${item && item.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${item ? escapeHtml(item.notes || "") : ""}</textarea></div>
  `;
  openModal(item ? "Modifier l'élément" : "Nouvel élément", fields, {
    onSave: async (data) => { if (item) await Store.update("todos", item.id, data); else await Store.add("todos", data); },
    onDelete: item ? async () => Store.remove("todos", item.id) : null
  });
}

// ------------------------------------------------------------------
// SEED — données de départ (reprises du dossier Notion + PDF Tâches)
// La liste "À faire" fusionne les anciennes tâches et le matériel/courses.
// ------------------------------------------------------------------
const budgetSeed = [
  { label: "Colo de Bolandoz (salle + hébergement)", category: "Lieu", estimated: 1200, actual: 300, status: "Réservé", notes: "Acompte de 300 € versé, reste 900 € à régler." },
  { label: "Prestataire méchoui — Belhadje", category: "Méchoui/Traiteur", estimated: 2700, actual: 0, status: "Réservé", notes: "Belhadje : 0662630915. Service : fille d'Alima, 0660399568." },
  { label: "Accompagnements maison (riz tchouchouka)", category: "Méchoui/Traiteur", estimated: 150, actual: 0, status: "À faire", notes: "Préparé par vous — budget ingrédients à affiner." },
  { label: "Fromage (Comté, Cancoillotte, Morbier, Edel de Cléron/Bochet)", category: "Méchoui/Traiteur", estimated: 130, actual: 0, status: "À faire", notes: "Acheté par vous, ~6 kg pour 100 pers." },
  { label: "Apéritif", category: "Boissons", estimated: 0, actual: 0, status: "Réservé", notes: "Géré par les parents." },
  { label: "Boissons repas & soirée", category: "Boissons", estimated: 400, actual: 0, status: "À faire", notes: "Vin, crémant, bière, softs — à recalculer pour 100 pers." },
  { label: "DJ / animation", category: "DJ/Photobooth", estimated: 700, actual: 0, status: "Réservé" },
  { label: "Photobooth — Click & Smile", category: "DJ/Photobooth", estimated: 210, actual: 0, status: "Réservé", notes: "Click & Smile : 0760922674." },
  { label: "Décoration guinguette comtoise chic", category: "Déco", estimated: 250, actual: 0, status: "À faire" },
  { label: "Matériel Olympiades", category: "Olympiades", estimated: 150, actual: 0, status: "À faire" },
  { label: "Divers / imprévus", category: "Divers", estimated: 250, actual: 0, status: "À faire" }
];

const todosSeed = [
  // — tâches —
  { title: "Confirmer le prestataire méchoui (nom, horaire, matériel)", category: "Menu", quantity: "", owner: "Les deux", due: "2026-08-24", status: "Fait", notes: "Belhadje 0662630915, service par la fille d'Alima 0660399568." },
  { title: "Coordonner l'apéritif avec les parents", category: "Menu", quantity: "", owner: "Les deux", due: "2026-08-24", status: "À faire", notes: "" },
  { title: "Finaliser le nombre définitif d'invités", category: "Invités", quantity: "", owner: "Les deux", due: "2026-08-31", status: "À faire", notes: "" },
  { title: "Envoyer le rappel draps/duvets + tenue décontractée & baskets", category: "Communication", quantity: "", owner: "Les deux", due: "2026-08-31", status: "À faire", notes: "" },
  { title: "Attribuer les chambrées/dortoirs à la Colo", category: "Hébergement", quantity: "", owner: "Les deux", due: "2026-09-07", status: "À faire", notes: "" },
  { title: "Recalculer les quantités pour l'effectif final", category: "Menu", quantity: "", owner: "Les deux", due: "2026-09-07", status: "À faire", notes: "" },
  { title: "Réunir le matériel Olympiades", category: "Olympiades", quantity: "", owner: "Les deux", due: "2026-09-14", status: "À faire", notes: "" },
  { title: "Former les 4 équipes et préparer les brassards", category: "Olympiades", quantity: "", owner: "Les deux", due: "2026-09-14", status: "À faire", notes: "" },
  { title: "Acheter/commander la décoration", category: "Déco", quantity: "", owner: "Les deux", due: "2026-09-14", status: "À faire", notes: "" },
  { title: "Solder le paiement de la Colo (900 €)", category: "Lieu", quantity: "", owner: "Les deux", due: "2026-09-19", status: "À faire", notes: "" },
  { title: "Acheter le fromage et les ingrédients du riz tchouchouka", category: "Menu", quantity: "", owner: "Les deux", due: "2026-09-24", status: "À faire", notes: "" },
  { title: "Acheter les boissons", category: "Menu", quantity: "", owner: "Les deux", due: "2026-09-24", status: "À faire", notes: "" },
  { title: "Installation salle, déco et matériel Olympiades", category: "Déco", quantity: "", owner: "Les deux", due: "2026-09-26", status: "À faire", notes: "" },
  // — matériel / courses —
  { title: "Guirlandes guinguette + lampions", category: "Déco", quantity: "~30 m", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Nappes (tissu / kraft / vichy)", category: "Déco", quantity: "10-12 tables", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Panneau \"Bienvenue aux 40 ans\"", category: "Déco", quantity: "1", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Grands saladiers + couverts de service", category: "Cuisine/Buffet", quantity: "4-6", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Plats à gratin XXL", category: "Cuisine/Buffet", quantity: "Vérifier avec les fours de la Colo", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Planches à découper + couteaux de boucher", category: "Cuisine/Buffet", quantity: "2-3", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Plat de présentation fromage", category: "Cuisine/Buffet", quantity: "1-2", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Cafetière grande capacité", category: "Cuisine/Buffet", quantity: "1", owner: "", due: "", status: "À faire", notes: "Pour le brunch du dimanche" },
  { title: "Gobelets réutilisables (éco-cups)", category: "Boissons", quantity: "100+", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Glaçons", category: "Boissons", quantity: "10 kg", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Boîtes mystères, fiches quiz, buzzers, stylos, grilles", category: "Olympiades", quantity: "Pôle Culture", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Boîtes conserve, balles, pistolets à eau, cibles, verres percés, seaux", category: "Olympiades", quantity: "Pôle Sport & Défis", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Pâte à modeler, bandeaux yeux, polaroid, cartes Lynx", category: "Olympiades", quantity: "Pôle Artistique", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Fiches indices + mascottes de chambrée", category: "Olympiades", quantity: "1 par chambrée", owner: "", due: "", status: "À faire", notes: "Jeu Inter-Chambrées" },
  { title: "Brassards de couleur (4 équipes)", category: "Olympiades", quantity: "100", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Mégaphone / enceinte nomade", category: "Olympiades", quantity: "1", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Ardoise / paperboard scores", category: "Olympiades", quantity: "1", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Médailles, trophée, bonbons/lots enfants", category: "Olympiades", quantity: "100 + 1", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Sacs poubelle 100L", category: "Hygiène/Logistique", quantity: "1 rouleau x20", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Papier toilette, essuie-tout, éponges, liquide vaisselle", category: "Hygiène/Logistique", quantity: "Stock", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Rallonges & multiprises", category: "Hygiène/Logistique", quantity: "4-6", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Bar à Eaux & Citronnades", category: "Hygiène/Logistique", quantity: "1 stand", owner: "", due: "", status: "À faire", notes: "" }
];

async function runSeed() {
  const r1 = await Store.seedIfEmpty("budget", budgetSeed);
  const r2 = await Store.seedIfEmpty("todos", todosSeed);
  closeSheet();
  if (r1 || r2) alert("Données de départ importées ✅");
  else alert("Les données existent déjà — rien n'a été écrasé.");
}

// ------------------------------------------------------------------
// UTILS
// ------------------------------------------------------------------
function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function escapeAttr(str) { return escapeHtml(str); }

// Service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

boot();
