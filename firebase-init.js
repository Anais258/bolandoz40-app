// ============================================================
// Configuration Firebase — À REMPLIR avec vos propres clés.
// Voir GUIDE-MISE-EN-SERVICE.md pour la marche à suivre (2 minutes, gratuit).
// Tant que ces valeurs ne sont pas remplacées, l'appli fonctionne
// automatiquement en mode démo local (données stockées sur ce seul
// téléphone, non partagées) — aucun appel réseau n'est fait vers Firebase.
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyDGbhZSKI77uAuHGysitl_Xtpfu_OCsGNM",
  authDomain: "bolandoz-40ans.firebaseapp.com",
  projectId: "bolandoz-40ans",
  storageBucket: "bolandoz-40ans.firebasestorage.app",
  messagingSenderId: "690483139691",
  appId: "1:690483139691:web:a325ee4e0bd3534df8cd2e"
};

export const isConfigured = !Object.values(firebaseConfig).some(v => String(v).startsWith("REMPLACER"));

let app, db, auth;

// Les imports Firebase ne sont chargés que si l'appli est configurée,
// pour que le mode démo local fonctionne 100% hors-ligne, sans aucune
// requête réseau vers gstatic.com/firebase.
export async function initFirebase() {
  if (!isConfigured) return null;
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const firestoreMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const { getAuth, signInAnonymously, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
  app = initializeApp(firebaseConfig);
  db = firestoreMod.getFirestore(app);
  auth = getAuth(app);
  return { app, db, auth, fs: firestoreMod, signInAnonymously, onAuthStateChanged };
}
