# Guide de mise en service — Appli "40 ans Anaïs et Anne-Sophie, Rencontres et Retrouvailles"

> **Netlify seul ne suffit pas.** Netlify héberge les fichiers de l'appli (il donne l'adresse web) mais ne stocke aucune donnée partagée. Firebase est la base de données qui permet à toi et Anne-Sophie d'éditer la même liste en temps réel. Sans Firebase, chaque téléphone garde ses propres données séparément (mode démo local) — vous ne verriez pas les modifications de l'autre. **Les deux étapes sont nécessaires ensemble : Firebase (données partagées) + Netlify (mise en ligne).**

Cette appli fonctionne dès maintenant en **mode démo local** (les données restent sur ton téléphone, non partagées avec Anne-Sophie). Pour la rendre **vraiment partagée**, il faut environ 10 minutes et un compte Google gratuit. Suis les étapes dans l'ordre.

## Étape 1 — Créer le projet Firebase (gratuit, 2 minutes)

1. Va sur https://console.firebase.google.com avec un compte Google (créer un compte Google gratuit si besoin, ça ne demande pas de carte bancaire).
2. Clique sur **"Ajouter un projet"**, donne-lui un nom (ex : `bolandoz-40-ans`), continue avec les options par défaut (tu peux désactiver Google Analytics, pas nécessaire ici).
3. Une fois le projet créé, dans le menu de gauche va dans **Compilation > Firestore Database**, clique **"Créer une base de données"**, choisis l'emplacement `eur3 (europe-west)`, et démarre en **mode production**.
4. Toujours dans le menu de gauche, va dans **Compilation > Authentication**, onglet **"Sign-in method"**, active le fournisseur **"Anonyme"**.
5. Va dans **Paramètres du projet** (icône ⚙️ en haut à gauche) > onglet **Général** > section **"Vos applications"** > clique l'icône **`</>`** (Web) pour ajouter une application web. Donne-lui un nom (ex : `app-mobile`), pas besoin de cocher "Firebase Hosting".
6. Firebase affiche un bloc de code avec un objet `firebaseConfig` (apiKey, authDomain, projectId, etc.). **Copie ces 6 valeurs.**

## Étape 2 — Coller la configuration dans l'appli

1. Ouvre le fichier `firebase-init.js` (avec un éditeur de texte, ou même le Bloc-notes).
2. Remplace les 6 valeurs `"REMPLACER_..."` par celles copiées à l'étape 1. Exemple :
   ```js
   export const firebaseConfig = {
     apiKey: "AIzaSyABCDEF...",
     authDomain: "bolandoz-40-ans.firebaseapp.com",
     projectId: "bolandoz-40-ans",
     storageBucket: "bolandoz-40-ans.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef123456"
   };
   ```
3. Enregistre le fichier.

## Étape 3 — Sécuriser la base de données

1. Retour dans la console Firebase > **Firestore Database > Règles**.
2. Remplace le contenu par :
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /bolandoz40/{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
3. Clique **"Publier"**.

*(Cette règle autorise la lecture/écriture à toute personne qui ouvre l'appli avec le bon lien — c'est suffisant pour un usage familial privé, mais ne partage pas le lien publiquement.)*

## Étape 4 — Mettre l'appli en ligne

La façon la plus simple, sans rien installer :

1. Va sur https://app.netlify.com/drop
2. Fais glisser le dossier de l'appli (le dossier complet, avec `index.html` dedans) directement sur la page.
3. Netlify te donne une adresse (ex : `https://bolandoz-40-ans.netlify.app`) en quelques secondes. C'est ton lien à partager avec Anne-Sophie.
4. (Optionnel mais conseillé) Crée un compte Netlify gratuit pour que le site reste en ligne durablement et que tu puisses le remettre à jour plus tard en refaisant un glisser-déposer.

## Étape 5 — Installer l'appli sur vos téléphones

1. Ouvre le lien Netlify dans Safari (iPhone) ou Chrome (Android).
2. iPhone : bouton Partager (carré avec flèche) > **"Sur l'écran d'accueil"**.
3. Android : menu ⋮ (trois points) > **"Ajouter à l'écran d'accueil"** / **"Installer l'application"**.
4. Une icône "40 ans A&AS" apparaît sur l'écran d'accueil, comme une vraie appli.
5. Fais pareil sur le téléphone d'Anne-Sophie avec le même lien — vous éditez alors la même base de données en temps réel.

## Étape 6 — Importer les données de départ

Dans l'appli, onglet **"Plus" > "🌱 Importer les données de départ"**. Cela préremplit le budget et la liste **"À faire"** (qui regroupe désormais tâches et matériel/courses en une seule liste) avec tout ce qu'on a déjà défini ensemble. À faire une seule fois (si des données existent déjà, rien n'est écrasé — et si vous aviez déjà des tâches/articles enregistrés avant cette mise à jour, ils sont repris automatiquement dans la nouvelle liste "À faire" au premier lancement, rien n'est perdu).

---

## Et pour la convertir en appli Google Play ?

Une fois l'appli en ligne (étape 4 faite) :

1. Va sur https://www.pwabuilder.com et colle l'adresse de ton appli (ex : `https://bolandoz-40-ans.netlify.app`).
2. PWABuilder analyse l'appli et génère un **package Android (.aab)** prêt à publier.
3. Pour le publier sur le Play Store, il te faut un **compte développeur Google Play** (25 $ payés une seule fois, à vie, à créer sur https://play.google.com/console avec ton propre compte Google) — c'est une étape que je ne peux pas faire à ta place car elle demande ton identité et un paiement.
4. Une fois le compte créé, tu envoies le fichier `.aab` généré par PWABuilder dans la console Play Console, tu remplis la fiche (description, captures d'écran, icône — déjà prêtes dans le dossier `icons/`), et tu publies. Le délai de validation par Google est généralement de quelques heures à 2-3 jours.

Pour un événement privé entre vous, l'étape 5 (icône sur l'écran d'accueil) suffit largement et donne déjà 95% de l'expérience d'une appli native — je recommande de ne passer par le Play Store que si tu veux vraiment une distribution "officielle".

## En cas de souci

- L'appli affiche un bandeau orange "Firebase n'est pas encore configuré" → les valeurs `REMPLACER_...` sont encore présentes dans `firebase-init.js`.
- Les données ne se synchronisent pas entre les deux téléphones → vérifiez que vous avez bien ouvert le **même lien Netlify** sur les deux appareils, et que l'étape 3 (règles Firestore) a bien été publiée.
- Pour tout repartir de zéro : supprime les documents dans Firestore Database (console Firebase) et relance l'import depuis "Plus".
