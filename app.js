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
  try {
    await migrateOrSeedTodos();
    await renameOldCategories();
    await migrateOrSeedGuests();
    await migrateGuestFieldsOnce();
    await applyMealPollOnce();
    await fixMeatLambOverlapOnce();
    await convertMealBooleansToCountsOnce();
    await applySamuelHouseholdDetailsOnce();
    await applyFridayPollOnce();
    await applySaturdayPollOnce();
    await applyConversationUpdate1Once();
    await assignGroupsOnce();
    await convertLodgingBooleansToCountsOnce();
    await seedOrConvertProgrammeOnce();
  } catch (e) {
    console.error("Erreur pendant la mise à jour des données (l'appli continue quand même)", e);
  }
  initNav();
  initCountdown();
  const seedBtn = document.getElementById("btn-seed");
  if (seedBtn) seedBtn.addEventListener("click", runSeed);
  const forceBtn = document.getElementById("btn-force-refresh");
  if (forceBtn) forceBtn.addEventListener("click", forceRefresh);

  function safeInit(fn, label) {
    try { fn(); } catch (e) {
      console.error(`Erreur d'initialisation (${label}) — l'appli continue quand même.`, e);
    }
  }
  safeInit(initGuests, "invités");
  safeInit(initRooms, "chambres");
  safeInit(initBudget, "budget");
  safeInit(initTasks, "tâches");
  safeInit(initProgramme, "programme");
  safeInit(initNotes, "notes");
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
const guestsSeed = [
  { name: "Aline", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Arnaud Heinselin", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Bernadette Fongaufier", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Voisine · Couchage samedi" },
  { name: "Céline Fieux", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Eliane Menegain", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Maman d'Anne-Sophie" },
  { name: "Émilie", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Jean Menegain", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Joanne Leroy", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Marie", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Copine d'Anne-Sophie · Couchage samedi" },
  { name: "Mathéo Bénéteau de Laprairie", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Nadège", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Copine de Samuel" },
  { name: "Nelly Guilbert", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Cras'Tier" },
  { name: "Nicolas", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Papa de Marius" },
  { name: "Papa", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Pauline Grandmottet", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Copine d'Anne-Sophie · Couchage samedi" },
  { name: "Raphaële Masure", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Copine d'Anne-Sophie · Couchage vendredi et samedi" },
  { name: "Samuel Guyon", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Sonia Millesse", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Stéphanie Masini", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Thana", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Maman de Jade, copine de Lola" },
  { name: "Valérie Heinselin", phone: "", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Alexis", phone: "+33 6 65 91 07 00", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Aurélie Robin", phone: "+33 6 89 12 35 56", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Charles C", phone: "+33 7 86 14 84 32", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Clémence", phone: "+33 6 37 21 53 18", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Corinne", phone: "+33 6 74 76 64 56", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Delphine Pommier", phone: "+49 177 4308415", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage vendredi et samedi" },
  { name: "Elise", phone: "+33 6 72 16 72 67", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Emilie", phone: "+33 6 68 23 16 59", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage vendredi et samedi" },
  { name: "Emy", phone: "+33 7 70 70 46 44", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Estelle", phone: "+33 7 69 33 90 41", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "François", phone: "+33 6 78 82 45 72", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Guillaume", phone: "+33 6 30 05 60 24", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "jacquenotjulien", phone: "+33 6 30 60 07 44", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Jocelyne", phone: "+33 6 37 45 09 89", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Laetitia Tremel", phone: "+33 6 51 00 66 50", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage vendredi" },
  { name: "Marie Gillard", phone: "+33 6 85 34 90 94", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Marion", phone: "+33 6 72 73 00 28", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Mathilde", phone: "+33 7 69 28 69 17", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Mélissa", phone: "+33 6 06 80 26 22", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Menegain", phone: "+33 6 43 07 51 37", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Michel", phone: "+33 6 88 45 40 44", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Nicole Prin", phone: "+33 6 58 00 58 42", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Pierre", phone: "+33 6 52 69 16 04", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Sainte-cluque", phone: "+33 6 35 80 76 11", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Samuel Sugirtharaj", phone: "+33 6 99 57 70 44", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Simon", phone: "+33 6 29 40 76 51", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Steph", phone: "+33 6 35 59 71 97", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage vendredi et samedi" },
  { name: "Steven", phone: "+33 6 43 54 17 32", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage vendredi et samedi" },
  { name: "Sylvain", phone: "+33 6 31 89 94 82", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Thibault", phone: "+33 7 69 98 28 99", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Couchage samedi" },
  { name: "Thomas", phone: "+33 6 77 43 10 94", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "Veronique", phone: "+33 6 80 54 19 64", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "" },
  { name: "+33 6 32 88 79 69", phone: "+33 6 32 88 79 69", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Nom à identifier" },
  { name: "+33 6 59 74 00 15", phone: "+33 6 59 74 00 15", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Nom à identifier" },
  { name: "+33 6 77 20 69 23", phone: "+33 6 77 20 69 23", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Nom à identifier" },
  { name: "+33 7 88 48 28 64", phone: "+33 7 88 48 28 64", group: "Les deux", adults: 0, kids: 0, room: "", team: "", notes: "Nom à identifier" },
];

async function migrationRan(key) {
  const all = await Store.getAllOnce("meta");
  return all.some(d => d.key === key);
}
async function markMigrationRan(key) {
  await Store.add("meta", { key });
}

async function migrateOrSeedGuests() {
  const existing = await Store.getAllOnce("guests");
  const existingKeys = new Set(existing.map(g => (g.name || "").trim().toLowerCase() + "|" + (g.phone || "").trim()));
  for (const g of guestsSeed) {
    const key = (g.name || "").trim().toLowerCase() + "|" + (g.phone || "").trim();
    if (existingKeys.has(key)) continue;
    try { await Store.add("guests", g); } catch (e) { console.error("Erreur ajout invité", g.name, e); }
  }
}

// Migration ponctuelle (une seule fois, peu importe quel téléphone démarre en premier) :
// - tous les invités passent en "Confirmé" par défaut
// - la mention "Couchage vendredi/samedi" dans les notes devient des cases à cocher dédiées
async function migrateGuestFieldsOnce() {
  const KEY = "guest-fields-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  for (const g of all) {
    let notes = g.notes || "";
    const both = /couchage vendredi et samedi/i.test(notes);
    const fri = both || /couchage vendredi/i.test(notes);
    const sat = both || /couchage samedi/i.test(notes);
    notes = notes
      .replace(/couchage vendredi et samedi/i, "")
      .replace(/couchage vendredi/i, "")
      .replace(/couchage samedi/i, "")
      .replace(/\s*·\s*·\s*/g, " · ")
      .replace(/^\s*·\s*|\s*·\s*$/g, "")
      .trim();
    await Store.update("guests", g.id, {
      status: "Confirmé",
      lodgingFriday: !!fri,
      lodgingSaturday: !!sat,
      noLamb: g.noLamb === undefined ? false : g.noLamb,
      noMeat: g.noMeat === undefined ? false : g.noMeat,
      notes
    });
  }
  await markMigrationRan(KEY);
}

async function migrateOrSeedTodos() {
  const existingTodos = await Store.getAllOnce("todos");
  const oldTasks = await Store.getAllOnce("tasks");
  const oldSupplies = await Store.getAllOnce("supplies");
  let merged;
  if (oldTasks.length || oldSupplies.length) {
    merged = [...oldTasks.map(taskToTodo), ...oldSupplies.map(supplyToTodo)];
  } else {
    merged = todosSeed;
  }
  const existingKeys = new Set(existingTodos.map(t => (t.title || "").trim().toLowerCase()));
  for (const item of merged) {
    const key = (item.title || "").trim().toLowerCase();
    if (existingKeys.has(key)) continue;
    try { await Store.add("todos", item); } catch (e) { console.error("Erreur ajout tâche", item.title, e); }
  }
}

// Catégories renommées : "Menu" et "Cuisine/Buffet" -> "Repas".
// Ne touche que les éléments existants qui portent encore l'ancien nom.
const CATEGORY_RENAMES = { "Menu": "Repas", "Cuisine/Buffet": "Repas" };
async function renameOldCategories() {
  const all = await Store.getAllOnce("todos");
  for (const item of all) {
    const renamed = CATEGORY_RENAMES[item.category];
    if (renamed) await Store.update("todos", item.id, { category: renamed });
  }
}

// ------------------------------------------------------------------
// NOTES EN VRAC — bloc-notes partagé, un seul document, autosave
// ------------------------------------------------------------------
let notesDoc = null;
let notesSaveTimer = null;

// ------------------------------------------------------------------
// PROGRAMME DU WEEK-END — liste éditable par ligne (heure + description).
// ------------------------------------------------------------------
let programmeData = [];

function initProgramme() {
  Store.subscribe("programme", (arr) => { programmeData = arr; renderProgramme(); });
  const wireAddBtn = (id, day) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => openProgrammeModal(null, day));
  };
  wireAddBtn("btn-add-prog-jeudi", "Jeudi");
  wireAddBtn("btn-add-prog-vendredi", "Vendredi");
  wireAddBtn("btn-add-prog-samedi", "Samedi");
  wireAddBtn("btn-add-prog-dimanche", "Dimanche");
}

function renderProgrammeDay(day, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const items = programmeData.filter(p => p.day === day).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!items.length) { container.innerHTML = `<div class="empty-state">Rien pour l'instant.</div>`; return; }
  container.innerHTML = items.map(p => `
    <div class="list-item" data-id="${p.id}">
      <div class="list-item-main">
        <div class="list-item-title"><span class="prog-time">${escapeHtml(p.time || "")}</span></div>
        <div class="list-item-sub">${escapeHtml(p.text || "")}</div>
      </div>
      <div class="list-item-actions"><button class="icon-btn edit-prog" title="Modifier">⋯</button></div>
    </div>`).join("");
  container.querySelectorAll(".list-item").forEach(el => {
    el.querySelector(".edit-prog").addEventListener("click", () => openProgrammeModal(programmeData.find(p => p.id === el.dataset.id), day));
  });
}

function renderProgramme() {
  renderProgrammeDay("Jeudi", "programme-jeudi-list");
  renderProgrammeDay("Vendredi", "programme-vendredi-list");
  renderProgrammeDay("Samedi", "programme-samedi-list");
  renderProgrammeDay("Dimanche", "programme-dimanche-list");
}

function openProgrammeModal(item, day) {
  const dayItems = programmeData.filter(p => p.day === day);
  const nextOrder = dayItems.length ? Math.max(...dayItems.map(p => p.order || 0)) + 1 : 0;
  const fields = `
    <div class="field"><label>Heure</label><input name="time" value="${item ? escapeAttr(item.time) : ""}" placeholder="ex. 14h00 ou 15h00–17h00" required></div>
    <div class="field"><label>Description</label><textarea name="text" rows="2">${item ? escapeHtml(item.text || "") : ""}</textarea></div>
    <div class="field"><label>Ordre d'affichage</label><input type="number" name="order" value="${item ? item.order || 0 : nextOrder}"></div>
    <input type="hidden" name="day" value="${day}">
  `;
  openModal(item ? "Modifier le programme" : "Ajouter au programme", fields, {
    saveLabel: "Enregistrer",
    onSave: async (data) => {
      if (item) await Store.update("programme", item.id, data);
      else await Store.add("programme", data);
    },
    onDelete: item ? async () => Store.remove("programme", item.id) : null
  });
}

// Reprend le planning déjà défini comme données de départ éditables, une seule fois.
const programmeSeed = [
  { day: "Samedi", order: 0, time: "11h00–13h30", text: "Installation logistique (déco, tables, buffet)" },
  { day: "Samedi", order: 1, time: "14h00", text: "Ouverture des portes, accueil, installation chambres/dortoirs" },
  { day: "Samedi", order: 2, time: "14h30–15h00", text: "Constitution des 4 équipes, ateliers blason/chanson, briefing Olympiades" },
  { day: "Samedi", order: 3, time: "15h00–17h00", text: "Olympiades — 4 épreuves x 15 min, 3 pôles (rotation)" },
  { day: "Samedi", order: 4, time: "16h00", text: "Lancement de la cuisson du méchoui (prestataire)" },
  { day: "Samedi", order: 5, time: "17h00–17h30", text: "Grand Final \"Inter-Chambrées\"" },
  { day: "Samedi", order: 6, time: "17h30–18h00", text: "Résultats, remise des prix, détente" },
  { day: "Samedi", order: 7, time: "18h30", text: "Apéritif officiel (parents) — Crémant, bières locales" },
  { day: "Samedi", order: 8, time: "20h30", text: "Banquet — méchoui + accompagnements maison" },
  { day: "Samedi", order: 9, time: "22h00", text: "Fromages & gâteau d'anniversaire" },
  { day: "Samedi", order: 10, time: "23h00…", text: "Soirée dansante (DJ)" },
  { day: "Dimanche", order: 0, time: "~9h30–11h30", text: "Brunch" },
  { day: "Dimanche", order: 1, time: "Fin de matinée", text: "Rangement, ménage, restitution de la salle" },
  { day: "Dimanche", order: 2, time: "Début d'après-midi", text: "Départ de Bolandoz" }
];

// Convertit d'anciens documents "un bloc de texte par jour" (format
// intermédiaire) en lignes individuelles si besoin, sinon sème le
// planning de départ si la liste est complètement vide.
async function seedOrConvertProgrammeOnce() {
  const existing = await Store.getAllOnce("programme");
  const blobDocs = existing.filter(p => p.text !== undefined && p.time === undefined);
  if (blobDocs.length) {
    for (const doc of blobDocs) {
      const lines = (doc.text || "").split("\n").map(l => l.trim()).filter(Boolean);
      let order = 0;
      for (const line of lines) {
        const sep = line.indexOf(" — ");
        const time = sep !== -1 ? line.slice(0, sep) : "";
        const text = sep !== -1 ? line.slice(sep + 3) : line;
        await Store.add("programme", { day: doc.day, time, text, order: order++ });
      }
      await Store.remove("programme", doc.id);
    }
    return;
  }
  if (!existing.length) {
    for (const item of programmeSeed) await Store.add("programme", item);
  }
}

function initNotes() {
  const ta = document.getElementById("notes-textarea");
  Store.subscribe("scratchnotes", (arr) => {
    notesDoc = arr[0] || null;
    // Ne pas écraser ce que la personne est en train de taper si une mise à
    // jour arrive de l'autre téléphone pendant qu'elle écrit.
    if (document.activeElement !== ta) {
      ta.value = notesDoc ? (notesDoc.text || "") : "";
    }
  });
  ta.addEventListener("input", () => {
    clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(saveNotes, 600);
  });
}

async function saveNotes() {
  const ta = document.getElementById("notes-textarea");
  const text = ta.value;
  if (notesDoc) {
    await Store.update("scratchnotes", notesDoc.id, { text });
  } else {
    await Store.add("scratchnotes", { text });
  }
  const ind = document.getElementById("notes-saved-indicator");
  if (ind) {
    ind.textContent = "Enregistré ✓";
    setTimeout(() => { if (ind.textContent === "Enregistré ✓") ind.textContent = ""; }, 1500);
  }
}

// Résultats du sondage WhatsApp sur l'agneau/la viande, appliqués une seule fois.
const MEAL_POLL_NO_LAMB = ["Simon", "Steven", "Jean Menegain", "Marion", "Emy", "Thana", "Laetitia Tremel", "Samuel Guyon", "Estelle", "Emilie", "Mathilde", "Marie Gillard", "Samuel Sugirtharaj"];
const MEAL_POLL_NO_MEAT = ["Jocelyne", "Valérie Heinselin", "Thibault"];
async function applyMealPollOnce() {
  const KEY = "meal-poll-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  for (const g of all) {
    if (MEAL_POLL_NO_MEAT.includes(g.name)) {
      await Store.update("guests", g.id, { noMeat: true });
    } else if (MEAL_POLL_NO_LAMB.includes(g.name)) {
      await Store.update("guests", g.id, { noLamb: true });
    }
  }
  await markMigrationRan(KEY);
}

// Sondage WhatsApp "dort le vendredi ?" — réponses "Oui", appliqué une seule fois.
const FRIDAY_POLL_YES = ["Raphaële Masure", "Laetitia Tremel", "jacquenotjulien", "Emilie", "Steven", "Delphine Pommier"];
// Correction : "Sans viande" et "Sans agneau" sont désormais deux infos
// distinctes — quelqu'un qui ne mange pas de viande du tout n'a pas besoin
// d'avoir aussi "Sans agneau" coché (ça reste réservé à ceux qui mangent de
// la viande mais évitent l'agneau).
async function fixMeatLambOverlapOnce() {
  const KEY = "meat-lamb-fix-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  for (const g of all) {
    if (g.noMeat && g.noLamb) {
      await Store.update("guests", g.id, { noLamb: false });
    }
  }
  await markMigrationRan(KEY);
}

// Passage des cases "Sans agneau/Sans viande" (oui/non pour toute la fiche)
// à un nombre de personnes concernées dans le foyer — une fiche peut
// représenter plusieurs personnes (accompagnants), qui n'ont pas
// forcément toutes la même restriction.
async function convertMealBooleansToCountsOnce() {
  const KEY = "meal-counts-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  for (const g of all) {
    if (g.noLambCount === undefined || g.noMeatCount === undefined) {
      await Store.update("guests", g.id, {
        noLambCount: g.noLambCount !== undefined ? g.noLambCount : (g.noLamb ? 1 : 0),
        noMeatCount: g.noMeatCount !== undefined ? g.noMeatCount : (g.noMeat ? 1 : 0)
      });
    }
  }
  await markMigrationRan(KEY);
}

// Passage des cases "Couchage vendredi/samedi" (oui/non pour toute la
// fiche) à un nombre de personnes du foyer concernées — par défaut,
// on reporte tout le foyer (1 + accompagnants + enfants) sur la nuit
// cochée ; à ajuster à la main si une partie du foyer seulement reste.
async function convertLodgingBooleansToCountsOnce() {
  const KEY = "lodging-counts-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  for (const g of all) {
    if (g.lodgingFridayCount === undefined || g.lodgingSaturdayCount === undefined) {
      const householdSize = 1 + (g.adults || 0) + (g.kids || 0);
      await Store.update("guests", g.id, {
        lodgingFridayCount: g.lodgingFridayCount !== undefined ? g.lodgingFridayCount : (g.lodgingFriday ? householdSize : 0),
        lodgingSaturdayCount: g.lodgingSaturdayCount !== undefined ? g.lodgingSaturdayCount : (g.lodgingSaturday ? householdSize : 0)
      });
    }
  }
  await markMigrationRan(KEY);
}

// Détails donnés par Samuel Sugirtharaj par message : vient avec sa
// compagne (qui ne mange pas d'agneau) et sa fille, arrivée le samedi.
async function applySamuelHouseholdDetailsOnce() {
  const KEY = "samuel-household-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  const samuel = all.find(g => g.name === "Samuel Sugirtharaj");
  if (samuel) {
    await Store.update("guests", samuel.id, {
      adults: 1,
      kids: 1,
      lodgingSaturday: true,
      noLambCount: 1,
      notes: [samuel.notes, "Vient avec sa compagne et sa fille"].filter(Boolean).join(" · ")
    });
  }
  await markMigrationRan(KEY);
}

// Détails tirés du fil WhatsApp "J'arrive dès le vendredi", appliqués une seule fois.
// Attribution Anaïs / Anne-Sophie d'après le repérage des contacts barrés
// dans la capture WhatsApp. Céline, Sonia et Thana restent "Les deux"
// (exception demandée). Aline confirmée par message -> Anne-Sophie.
const GROUP_ANAIS = ["Arnaud Heinselin", "Bernadette Fongaufier", "Émilie", "Joanne Leroy", "Mathéo Bénéteau de Laprairie", "Nadège", "Papa", "Samuel Guyon", "Stéphanie Masini", "Valérie Heinselin"];
const GROUP_ANNE_SOPHIE = ["Aline", "Eliane Menegain", "Jean Menegain", "Marie", "Nelly Guilbert", "Nicolas", "Pauline Grandmottet", "Raphaële Masure", "Alexis", "Aurélie Robin", "Charles C", "Clémence", "Corinne", "Delphine Pommier", "Elise", "Emilie", "Emy", "Estelle", "François", "Guillaume", "jacquenotjulien", "Jocelyne", "Laetitia Tremel", "Marie Gillard", "Marion", "Mathilde", "Mélissa", "Menegain", "Michel", "Nicole Prin", "Pierre", "Sainte-cluque", "Samuel Sugirtharaj", "Simon", "Steph", "Steven", "Sylvain", "Thibault", "Thomas", "Veronique", "+33 6 32 88 79 69", "+33 6 59 74 00 15", "+33 6 77 20 69 23", "+33 7 88 48 28 64"];
async function assignGroupsOnce() {
  const KEY = "assign-groups-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  for (const g of all) {
    if (GROUP_ANAIS.includes(g.name)) await Store.update("guests", g.id, { group: "Anaïs" });
    else if (GROUP_ANNE_SOPHIE.includes(g.name)) await Store.update("guests", g.id, { group: "Anne-Sophie" });
    // Céline Fieux, Sonia Millesse, Thana, Aline : non touchés.
  }
  await markMigrationRan(KEY);
}

async function applyConversationUpdate1Once() {
  const KEY = "conv-update-1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  const byName = (n) => all.find(g => g.name === n);

  const melissa = byName("Mélissa");
  if (melissa) {
    await Store.update("guests", melissa.id, {
      adults: 1,
      notes: [melissa.notes, "Vient avec Julian (mêmes réponses : couchage samedi, sans agneau)"].filter(Boolean).join(" · ")
    });
  }

  const aline = byName("Aline");
  if (aline) {
    await Store.update("guests", aline.id, {
      adults: 1,
      kids: 2,
      notes: [aline.notes, "Vient avec Gilles et 2 enfants (mêmes réponses : couchage samedi, aime l'agneau)"].filter(Boolean).join(" · ")
    });
  }

  const nelly = byName("Nelly Guilbert");
  if (nelly) {
    await Store.update("guests", nelly.id, { kids: 1 });
  }

  const steph = byName("Steph");
  if (steph) {
    await Store.update("guests", steph.id, { kids: 2, lodgingFriday: true });
  }

  const corinne = byName("Corinne");
  if (corinne) {
    await Store.update("guests", corinne.id, { kids: 3 });
  }

  await markMigrationRan(KEY);
}

async function applyFridayPollOnce() {
  const KEY = "friday-poll-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  for (const g of all) {
    if (FRIDAY_POLL_YES.includes(g.name) && !g.lodgingFriday) {
      await Store.update("guests", g.id, { lodgingFriday: true });
    }
  }
  await markMigrationRan(KEY);
}

// Sondage WhatsApp "dort le samedi ?" — réponses "Oui", appliqué une seule fois.
const SATURDAY_POLL_YES = ["Sonia Millesse", "Nicolas", "Marie", "Aline", "Samuel Guyon", "Nadège", "Mélissa", "Emy", "Laetitia Tremel", "Nelly Guilbert", "Estelle", "jacquenotjulien", "François", "Emilie", "Jean Menegain", "Aurélie Robin", "Marie Gillard", "Raphaële Masure", "Thibault", "Samuel Sugirtharaj", "Steven", "Delphine Pommier"];
async function applySaturdayPollOnce() {
  const KEY = "saturday-poll-v1";
  if (await migrationRan(KEY)) return;
  const all = await Store.getAllOnce("guests");
  for (const g of all) {
    if (SATURDAY_POLL_YES.includes(g.name) && !g.lodgingSaturday) {
      await Store.update("guests", g.id, { lodgingSaturday: true });
    }
  }
  await markMigrationRan(KEY);
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
// FORCER LA MISE À JOUR — équivalent de "Effacer et réinitialiser" dans
// les paramètres du site, mais depuis un bouton dans l'appli : désinstalle
// le service worker, vide son cache, puis recharge la page à neuf.
// ------------------------------------------------------------------
async function forceRefresh() {
  const btn = document.getElementById("btn-force-refresh");
  if (btn) btn.textContent = "⏳ Mise à jour en cours…";
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) await reg.unregister();
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
  } catch (e) {
    console.error("Erreur pendant le nettoyage du cache", e);
  }
  location.reload();
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
const STATUS_COLOR = { "À faire": "red", "En cours": "yellow", "Fait": "green", "Réservé": "blue", "Payé": "green" };

function renderTeamBalance() {
  const el = document.getElementById("team-balance-summary");
  if (!el) return;
  const teams = ["Équipe 1", "Équipe 2", "Équipe 3", "Équipe 4"];
  const counts = {};
  teams.forEach(t => counts[t] = 0);
  let unassigned = 0;
  guestsData.forEach(g => {
    const heads = 1 + (g.adults || 0) + (g.kids || 0);
    if (teams.includes(g.team)) counts[g.team] += heads;
    else unassigned += heads;
  });
  el.innerHTML = teams.map(t => tag(`${t} : ${counts[t]} pers.`, "purple")).join("")
    + (unassigned ? tag(`Non assignés : ${unassigned} pers.`, "gray") : "");
}


// ------------------------------------------------------------------
// INVITÉS
// ------------------------------------------------------------------
let guestsData = [];
let guestCheckFilters = new Set();

const GUEST_CHECK_FILTERS = [
  { key: "lodgingFridayCount", label: "Couchage vendredi" },
  { key: "lodgingSaturdayCount", label: "Couchage samedi" },
  { key: "noLambCount", label: "Sans agneau" },
  { key: "noMeatCount", label: "Sans viande" }
];

function renderGuestCheckFilters() {
  const wrap = document.getElementById("guests-check-filters");
  wrap.innerHTML = GUEST_CHECK_FILTERS.map(f =>
    `<button class="chip ${guestCheckFilters.has(f.key) ? "active" : ""}" data-cf="${f.key}">${f.label}</button>`
  ).join("") + (guestCheckFilters.size ? `<button class="chip" id="guests-check-reset">✕ Réinitialiser</button>` : "");
  wrap.querySelectorAll(".chip[data-cf]").forEach(c => c.addEventListener("click", () => {
    const key = c.dataset.cf;
    if (guestCheckFilters.has(key)) guestCheckFilters.delete(key); else guestCheckFilters.add(key);
    renderGuests();
  }));
  const resetBtn = wrap.querySelector("#guests-check-reset");
  if (resetBtn) resetBtn.addEventListener("click", () => { guestCheckFilters.clear(); renderGuests(); });
}

function initGuests() {
  Store.subscribe("guests", (arr) => { guestsData = arr; renderGuests(); });
  document.getElementById("btn-add-guest").addEventListener("click", () => openGuestModal(null));
  document.getElementById("guests-search").addEventListener("input", renderGuests);
}

function renderGuests() {
  renderGuestCheckFilters();
  const q = (document.getElementById("guests-search").value || "").toLowerCase();
  const list = document.getElementById("guests-list");
  let items = guestsData.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (guestCheckFilters.size) items = items.filter(g => Array.from(guestCheckFilters).every(key => !!g[key]));
  if (q) items = items.filter(g => (g.name || "").toLowerCase().includes(q));

  const confirmedCount = guestsData.reduce((sum, g) => sum + 1 + (g.adults || 0) + (g.kids || 0), 0);
  const totalAdults = guestsData.length + guestsData.reduce((sum, g) => sum + (g.adults || 0), 0);
  const totalKids = guestsData.reduce((sum, g) => sum + (g.kids || 0), 0);
  document.getElementById("stat-guests").textContent = confirmedCount;
  const cadreCountEl = document.getElementById("cadre-guest-count");
  if (cadreCountEl) cadreCountEl.textContent = `${confirmedCount} invité${confirmedCount === 1 ? "" : "s"}.`;
  const menuCountEl = document.getElementById("menu-guest-count");
  if (menuCountEl) menuCountEl.textContent = confirmedCount;
  renderTeamBalance();
  const breakdownEl = document.getElementById("stat-guests-breakdown");
  if (breakdownEl) {
    breakdownEl.textContent = (totalAdults || totalKids)
      ? `dont ${totalAdults} adulte${totalAdults === 1 ? "" : "s"} et ${totalKids} enfant${totalKids === 1 ? "" : "s"}`
      : "";
  }

  let countLine = "";
  if (guestCheckFilters.size) {
    const ficheLine = `${items.length} fiche${items.length === 1 ? "" : "s"} correspondante${items.length === 1 ? "" : "s"}`;
    const perFilterTotals = Array.from(guestCheckFilters).map(key => {
      const f = GUEST_CHECK_FILTERS.find(x => x.key === key);
      const total = items.reduce((sum, g) => sum + (Number(g[key]) || 0), 0);
      return `${total} pers. — ${f ? f.label : key}`;
    }).join(" · ");
    countLine = `<div style="font-size:12.5px;color:var(--muted);margin-bottom:8px;">${ficheLine}${perFilterTotals ? "<br>" + perFilterTotals : ""}</div>`;
  }

  if (!items.length) {
    const msg = guestsData.length
      ? `<div class="empty-state">Aucun invité ne correspond à ces filtres.</div>`
      : `<div class="empty-state">Aucun invité pour l'instant.<br>Touchez "+ Ajouter" pour commencer.</div>`;
    list.innerHTML = countLine + msg;
    return;
  }
  list.innerHTML = countLine + items.map(g => `
    <div class="list-item" data-id="${g.id}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(g.name || "(sans nom)")}</div>
        <div class="list-item-sub">${g.group || ""}${g.phone ? ` · ${escapeHtml(g.phone)}` : ""}${g.adults ? ` · +${g.adults} adulte(s)` : ""}${g.kids ? ` · ${g.kids} enfant(s)` : ""}${g.room ? ` · Chambre ${escapeHtml(g.room)}` : ""}</div>
        <div class="list-item-tags">
          ${g.lodgingFridayCount ? tag(`${g.lodgingFridayCount} couchage vendredi`, "blue") : ""}
          ${g.lodgingSaturdayCount ? tag(`${g.lodgingSaturdayCount} couchage samedi`, "blue") : ""}
          ${g.team ? tag(g.team, "purple") : ""}
          ${g.noLambCount ? tag(`${g.noLambCount} sans agneau`, "orange") : ""}
          ${g.noMeatCount ? tag(`${g.noMeatCount} sans viande`, "orange") : ""}
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
    <div class="field"><label class="field-label-accent">Nom</label><input name="name" value="${guest ? escapeAttr(guest.name) : ""}" required></div>
    <div class="field"><label>Téléphone</label><input type="tel" name="phone" value="${guest ? escapeAttr(guest.phone) : ""}"></div>
    <div class="field"><label>Groupe</label>
      <select name="group">
        ${["Anaïs", "Anne-Sophie", "Les deux"].map(s => `<option ${guest && guest.group === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
    <div class="field-row">
      <div class="field"><label>Accompagnants adultes</label><input type="number" name="adults" min="0" value="${guest ? guest.adults || 0 : 0}"></div>
      <div class="field"><label>Enfants</label><input type="number" name="kids" min="0" value="${guest ? guest.kids || 0 : 0}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Chambre / dortoir</label><select name="room">
        <option value="">– Aucune / à définir –</option>
        ${(roomsData || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(r => `<option value="${escapeAttr(r.name)}" ${guest && guest.room === r.name ? "selected" : ""}>${escapeHtml(r.name)}${r.capacity ? ` (${r.capacity} places)` : ""}</option>`).join("")}
      </select></div>
      <div class="field"><label>Équipe Olympiades</label>
        <select name="team"><option value="">–</option>${["Équipe 1", "Équipe 2", "Équipe 3", "Équipe 4"].map(s => `<option ${guest && guest.team === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      </div>
    </div>
    <div class="field">
      <label class="field-label-accent">Couchage à la Colo <span style="font-weight:400;color:var(--muted);font-size:12px;">(nombre de personnes du foyer concernées)</span></label>
      <div class="counter-row">
        <span class="counter-label">Vendredi</span>
        <div class="counter-control">
          <button type="button" class="counter-btn counter-minus">−</button>
          <span class="counter-value">${guest ? guest.lodgingFridayCount || 0 : 0}</span>
          <button type="button" class="counter-btn counter-plus">+</button>
          <input type="number" name="lodgingFridayCount" value="${guest ? guest.lodgingFridayCount || 0 : 0}" style="display:none;">
        </div>
      </div>
      <div class="counter-row">
        <span class="counter-label">Samedi</span>
        <div class="counter-control">
          <button type="button" class="counter-btn counter-minus">−</button>
          <span class="counter-value">${guest ? guest.lodgingSaturdayCount || 0 : 0}</span>
          <button type="button" class="counter-btn counter-plus">+</button>
          <input type="number" name="lodgingSaturdayCount" value="${guest ? guest.lodgingSaturdayCount || 0 : 0}" style="display:none;">
        </div>
      </div>
    </div>
    <div class="field">
      <label class="field-label-accent">Repas <span style="font-weight:400;color:var(--muted);font-size:12px;">(nombre de personnes du foyer concernées)</span></label>
      <div class="counter-row">
        <span class="counter-label">Ne mangent pas d'agneau</span>
        <div class="counter-control">
          <button type="button" class="counter-btn counter-minus">−</button>
          <span class="counter-value">${guest ? guest.noLambCount || 0 : 0}</span>
          <button type="button" class="counter-btn counter-plus">+</button>
          <input type="number" name="noLambCount" value="${guest ? guest.noLambCount || 0 : 0}" style="display:none;">
        </div>
      </div>
      <div class="counter-row">
        <span class="counter-label">Ne mangent pas de viande</span>
        <div class="counter-control">
          <button type="button" class="counter-btn counter-minus">−</button>
          <span class="counter-value">${guest ? guest.noMeatCount || 0 : 0}</span>
          <button type="button" class="counter-btn counter-plus">+</button>
          <input type="number" name="noMeatCount" value="${guest ? guest.noMeatCount || 0 : 0}" style="display:none;">
        </div>
      </div>
    </div>
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
  initCounterControls();
}

function initCounterControls() {
  document.querySelectorAll("#modal-form .counter-control").forEach(ctrl => {
    const hidden = ctrl.querySelector('input[type="number"]');
    const valueEl = ctrl.querySelector(".counter-value");
    ctrl.querySelector(".counter-minus").addEventListener("click", () => {
      hidden.value = Math.max(0, Number(hidden.value) - 1);
      valueEl.textContent = hidden.value;
    });
    ctrl.querySelector(".counter-plus").addEventListener("click", () => {
      hidden.value = Number(hidden.value) + 1;
      valueEl.textContent = hidden.value;
    });
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
// CHAMBRES / DORTOIRS
// Chaque chambre a un nom + une capacité. L'occupation est calculée
// automatiquement à partir des invités dont la fiche pointe vers cette
// chambre (foyer entier : 1 + accompagnants adultes + enfants).
// ------------------------------------------------------------------
let roomsData = [];
function initRooms() {
  Store.subscribe("rooms", (arr) => { roomsData = arr; renderRooms(); renderGuests(); });
  const btn = document.getElementById("btn-add-room");
  if (btn) btn.addEventListener("click", () => openRoomModal(null));
}

function renderRooms() {
  const list = document.getElementById("rooms-list");
  if (!list) return;
  const items = roomsData.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (!items.length) { list.innerHTML = `<div class="empty-state">Aucune chambre définie. Ajoutez vos chambres/dortoirs avec leur capacité.</div>`; return; }
  list.innerHTML = items.map(r => {
    const occupants = guestsData.filter(g => g.room === r.name);
    const occupancy = occupants.reduce((sum, g) => sum + 1 + (g.adults || 0) + (g.kids || 0), 0);
    const capacity = Number(r.capacity) || 0;
    const remaining = capacity - occupancy;
    const over = capacity > 0 && remaining < 0;
    const namesLine = occupants.length
      ? occupants.map(g => g.name).join(", ")
      : "Personne assigné pour l'instant";
    return `
    <div class="list-item" data-id="${r.id}">
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(r.name)}</div>
        <div class="list-item-sub">${occupancy} / ${capacity || "?"} occupé${occupancy === 1 ? "" : "s"}${capacity ? ` · ${over ? "dépassement de " + Math.abs(remaining) : remaining + " place" + (remaining === 1 ? "" : "s") + " restante" + (remaining === 1 ? "" : "s")}` : ""}</div>
        <div class="list-item-sub" style="margin-top:3px;">${escapeHtml(namesLine)}</div>
        ${r.notes ? `<div class="list-item-tags">${tag(r.notes, "gray")}</div>` : ""}
      </div>
      <div class="list-item-actions">${over ? `<span style="font-size:11px;color:#c0392b;font-weight:700;">⚠️ complet</span>` : ""}<button class="icon-btn edit-room">✏️</button></div>
    </div>`;
  }).join("");
  list.querySelectorAll(".list-item").forEach(el => {
    el.querySelector(".edit-room").addEventListener("click", () => openRoomModal(roomsData.find(r => r.id === el.dataset.id)));
  });
}

function openRoomModal(room) {
  const fields = `
    <div class="field"><label>Nom de la chambre / du dortoir</label><input name="name" value="${room ? escapeAttr(room.name) : ""}" required></div>
    <div class="field"><label>Capacité (nombre de places)</label><input type="number" name="capacity" value="${room ? room.capacity || 0 : 0}"></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="2">${room ? escapeHtml(room.notes || "") : ""}</textarea></div>
  `;
  openModal(room ? "Modifier la chambre" : "Nouvelle chambre / dortoir", fields, {
    onSave: async (data) => { if (room) await Store.update("rooms", room.id, data); else await Store.add("rooms", data); },
    onDelete: room ? async () => Store.remove("rooms", room.id) : null
  });
}

// ------------------------------------------------------------------
// À FAIRE (fusion tâches + matériel & courses)
// Catégories combinées des deux anciennes listes.
// Statuts : À faire / Réservé / Fait.
// ------------------------------------------------------------------
const TODO_CATEGORIES = ["Lieu", "Repas", "Brunch", "Boissons", "Déco", "Olympiades", "Activités", "Hébergement", "Invités", "Communication", "Hygiène/Logistique", "Divers"];
const TODO_STATUSES = ["À faire", "Réservé", "Fait"];
const TODO_STATUS_ICON = { "À faire": "⬜️", "Réservé": "🟡", "Fait": "✅" };
let tasksData = [];
let taskGroupMode = localStorage.getItem("bolandoz40_taskGroupMode") || "due";
let collapsedTaskGroups = new Set();

function initTasks() {
  Store.subscribe("todos", (arr) => { tasksData = arr; renderTasks(); renderHomeTasks(); });
  document.getElementById("btn-add-task").addEventListener("click", () => openTaskModal(null));
  document.getElementById("task-group-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    taskGroupMode = btn.dataset.mode;
    localStorage.setItem("bolandoz40_taskGroupMode", taskGroupMode);
    document.querySelectorAll("#task-group-toggle button").forEach(b => b.classList.toggle("active", b === btn));
    collapsedTaskGroups.clear();
    renderTasks();
  });
}

function renderTasks() {
  const list = document.getElementById("tasks-list");
  const remaining = tasksData.filter(t => t.status !== "Fait").length;
  document.getElementById("stat-tasks").textContent = remaining;

  // sync toggle buttons in case render is called after a data change (not a mode change)
  document.querySelectorAll("#task-group-toggle button").forEach(b => b.classList.toggle("active", b.dataset.mode === taskGroupMode));

  if (!tasksData.length) { list.innerHTML = `<div class="empty-state">Rien pour l'instant. Importez les données de départ depuis "Plus".</div>`; return; }

  const groups = groupTasks(tasksData, taskGroupMode);
  list.innerHTML = groups.map(g => renderTaskGroup(g)).join("");

  list.querySelectorAll(".task-group-head").forEach(head => {
    head.addEventListener("click", () => {
      const key = head.closest(".task-group").dataset.key;
      if (collapsedTaskGroups.has(key)) collapsedTaskGroups.delete(key); else collapsedTaskGroups.add(key);
      renderTasks();
    });
  });
  list.querySelectorAll(".list-item").forEach(el => {
    el.querySelector(".edit-task").addEventListener("click", (e) => { e.stopPropagation(); openTaskModal(tasksData.find(t => t.id === el.dataset.id)); });
    const remindBtn = el.querySelector(".add-reminder");
    if (remindBtn) remindBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = tasksData.find(t => t.id === el.dataset.id);
      window.open(calendarUrlFor(t), "_blank");
    });
    el.querySelector(".toggle-task").addEventListener("click", (e) => {
      e.stopPropagation();
      const t = tasksData.find(t => t.id === el.dataset.id);
      const next = TODO_STATUSES[(TODO_STATUSES.indexOf(t.status) + 1) % TODO_STATUSES.length];
      Store.update("todos", t.id, { status: next });
    });
  });
}

const OWNER_PRIORITY = ["Les deux", "Anaïs", "Anne-Sophie"];

function groupTasks(items, mode) {
  const sorted = items.slice().sort((a, b) => {
    if ((a.status === "Fait") !== (b.status === "Fait")) return a.status === "Fait" ? 1 : -1;
    const dueCmp = (a.due || "9999").localeCompare(b.due || "9999");
    if (dueCmp !== 0) return dueCmp;
    return (a.title || "").localeCompare(b.title || "");
  });

  const buckets = new Map();
  if (mode === "category") {
    TODO_CATEGORIES.forEach(c => buckets.set(c, []));
    sorted.forEach(t => {
      const cat = TODO_CATEGORIES.includes(t.category) ? t.category : "Divers";
      buckets.get(cat).push(t);
    });
  } else if (mode === "owner") {
    sorted.forEach(t => {
      const key = t.owner && t.owner.trim() ? t.owner.trim() : "__noowner__";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    });
  } else {
    sorted.forEach(t => {
      const key = t.due || "__nodue__";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    });
  }

  let entries = Array.from(buckets.entries()).filter(([, items]) => items.length);
  if (mode === "due") {
    entries.sort(([a], [b]) => {
      if (a === "__nodue__") return 1;
      if (b === "__nodue__") return -1;
      return a.localeCompare(b);
    });
  } else if (mode === "owner") {
    entries.sort(([a], [b]) => {
      if (a === "__noowner__") return 1;
      if (b === "__noowner__") return -1;
      const pa = OWNER_PRIORITY.indexOf(a), pb = OWNER_PRIORITY.indexOf(b);
      if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      return a.localeCompare(b);
    });
  }
  return entries.map(([key, items]) => ({
    key,
    label: mode === "category" ? key : mode === "owner" ? (key === "__noowner__" ? "Non assigné" : key) : (key === "__nodue__" ? "Sans échéance" : formatDate(key)),
    items
  }));
}

function renderTaskGroup(g) {
  const collapsed = collapsedTaskGroups.has(g.key);
  const doneCount = g.items.filter(t => t.status === "Fait").length;
  return `
    <div class="task-group${collapsed ? " collapsed" : ""}" data-key="${escapeAttr(g.key)}">
      <div class="task-group-head">
        <h3>${escapeHtml(g.label)}</h3>
        <div style="display:flex;align-items:center;">
          <span class="task-group-count">${doneCount}/${g.items.length}</span>
          <span class="task-group-chev"></span>
        </div>
      </div>
      <div class="list">
        ${g.items.map(t => renderTaskRow(t)).join("")}
      </div>
    </div>`;
}

function renderTaskRow(t) {
  return `
    <div class="list-item" data-id="${t.id}" style="${t.status === "Fait" ? "opacity:.55;" : ""}">
      <button class="checkbox-btn toggle-task">${TODO_STATUS_ICON[t.status] || "⬜️"}</button>
      <div class="list-item-main">
        <div class="list-item-title">${escapeHtml(t.title)}</div>
        <div class="list-item-sub">${[t.quantity, t.owner, t.due ? "Échéance : " + formatDate(t.due) : ""].filter(Boolean).map(escapeHtml).join(" · ")}</div>
        <div class="list-item-tags">${tag(t.category || "Divers", "gray")}${tag(t.status || "À faire", STATUS_COLOR[t.status] || "gray")}</div>
        ${t.notes ? `<div class="list-item-sub" style="margin-top:3px;font-style:italic;">${escapeHtml(t.notes)}</div>` : ""}
      </div>
      <div class="list-item-actions">
        ${t.due ? `<button class="icon-btn add-reminder" data-id="${t.id}" title="Ajouter un rappel au calendrier">🔔</button>` : ""}
        <button class="icon-btn edit-task">✏️</button>
      </div>
    </div>`;
}

function calendarUrlFor(t) {
  const start = t.due.replace(/-/g, "");
  const endDate = new Date(t.due + "T00:00:00");
  endDate.setDate(endDate.getDate() + 1);
  const end = endDate.toISOString().slice(0, 10).replace(/-/g, "");
  const text = encodeURIComponent(t.title);
  const details = encodeURIComponent([t.category, t.owner, t.notes].filter(Boolean).join(" · "));
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${start}/${end}&details=${details}`;
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
  { title: "Confirmer le prestataire méchoui (nom, horaire, matériel)", category: "Repas", quantity: "", owner: "Les deux", due: "2026-08-24", status: "Fait", notes: "Belhadje 0662630915, service par la fille d'Alima 0660399568." },
  { title: "Coordonner l'apéritif avec les parents", category: "Repas", quantity: "", owner: "Les deux", due: "2026-08-24", status: "À faire", notes: "" },
  { title: "Finaliser le nombre définitif d'invités", category: "Invités", quantity: "", owner: "Les deux", due: "2026-08-31", status: "À faire", notes: "" },
  { title: "Envoyer le rappel draps/duvets + tenue décontractée & baskets", category: "Communication", quantity: "", owner: "Les deux", due: "2026-08-31", status: "À faire", notes: "" },
  { title: "Attribuer les chambrées/dortoirs à la Colo", category: "Hébergement", quantity: "", owner: "Les deux", due: "2026-09-07", status: "À faire", notes: "" },
  { title: "Recalculer les quantités pour l'effectif final", category: "Repas", quantity: "", owner: "Les deux", due: "2026-09-07", status: "À faire", notes: "" },
  { title: "Réunir le matériel Olympiades", category: "Olympiades", quantity: "", owner: "Les deux", due: "2026-09-14", status: "À faire", notes: "" },
  { title: "Former les 4 équipes et préparer les brassards", category: "Olympiades", quantity: "", owner: "Les deux", due: "2026-09-14", status: "À faire", notes: "" },
  { title: "Acheter/commander la décoration", category: "Déco", quantity: "", owner: "Les deux", due: "2026-09-14", status: "À faire", notes: "" },
  { title: "Solder le paiement de la Colo (900 €)", category: "Lieu", quantity: "", owner: "Les deux", due: "2026-09-19", status: "À faire", notes: "" },
  { title: "Acheter le fromage et les ingrédients du riz tchouchouka", category: "Repas", quantity: "", owner: "Les deux", due: "2026-09-24", status: "À faire", notes: "" },
  { title: "Acheter les boissons", category: "Repas", quantity: "", owner: "Les deux", due: "2026-09-24", status: "À faire", notes: "" },
  { title: "Installation salle, déco et matériel Olympiades", category: "Déco", quantity: "", owner: "Les deux", due: "2026-09-26", status: "À faire", notes: "" },
  // — matériel / courses —
  { title: "Guirlandes guinguette + lampions", category: "Déco", quantity: "~30 m", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Nappes (tissu / kraft / vichy)", category: "Déco", quantity: "10-12 tables", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Panneau \"Bienvenue aux 40 ans\"", category: "Déco", quantity: "1", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Grands saladiers + couverts de service", category: "Repas", quantity: "4-6", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Plats à gratin XXL", category: "Repas", quantity: "Vérifier avec les fours de la Colo", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Planches à découper + couteaux de boucher", category: "Repas", quantity: "2-3", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Plat de présentation fromage", category: "Repas", quantity: "1-2", owner: "", due: "", status: "À faire", notes: "" },
  { title: "Cafetière grande capacité", category: "Brunch", quantity: "1", owner: "", due: "", status: "À faire", notes: "Pour le brunch du dimanche" },
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

// Service worker — installation + vérification automatique d'une
// nouvelle version à chaque lancement de l'appli (sans bouton à taper).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      // Force une vérification immédiate d'une nouvelle version au lancement,
      // au lieu d'attendre la vérification périodique par défaut du navigateur.
      reg.update().catch(() => {});
    } catch (e) { /* pas grave, l'appli fonctionne quand même */ }
  });

  // Dès qu'une nouvelle version prend le contrôle (après mise à jour des
  // fichiers), on recharge la page une seule fois pour l'appliquer.
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    location.reload();
  });
}

boot();
