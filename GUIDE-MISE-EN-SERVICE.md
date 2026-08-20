# Guide — Appli "40 ans Anaïs et Anne-Sophie, Rencontres et Retrouvailles"

## État actuel

- **Firebase est déjà configuré** (`firebase-init.js` contient la vraie configuration du projet `bolandoz-40ans`) — la synchro en temps réel entre les deux téléphones fonctionne déjà, rien à faire de ce côté.
- **L'appli est en ligne via GitHub Pages**, pas Netlify (changement fait en cours de route suite à un bug côté Netlify) :
  👉 **https://anais258.github.io/bolandoz40-app/**
- Le code source est dans le dépôt GitHub **`bolandoz40-app`** (public, pour que GitHub Pages puisse le servir).

## Mettre à jour l'appli (après une modification)

1. Récupère les fichiers modifiés (ceux fournis dans la conversation).
2. Sur github.com, dans le dépôt `bolandoz40-app` : pour chaque fichier changé, **Add file → Upload files**, sélectionne le fichier téléchargé — GitHub le remplace automatiquement (même nom, même emplacement) → **Commit changes**.
3. Patiente 1-2 minutes (GitHub Pages republie automatiquement à chaque changement).
4. Ouvre l'appli sur ton téléphone, va dans **Plus → 🔄 Forcer la mise à jour de l'appli**. Ce bouton vide le cache et recharge tout à neuf — plus besoin de passer par les paramètres de Chrome.
5. Fais pareil sur le téléphone d'Anne-Sophie une fois qu'elle a ouvert l'appli.

## Installer l'appli sur vos téléphones (icône sur l'écran d'accueil)

1. Ouvre https://anais258.github.io/bolandoz40-app/ dans Chrome (Android) ou Safari (iPhone).
2. **Android (Chrome)** : ouvre le menu ⋮ → **"Ajouter à l'écran d'accueil"**.
3. **iPhone (Safari)** : bouton Partager (carré avec flèche) → **"Sur l'écran d'accueil"**.
4. Une icône rose "2AS" apparaît sur l'écran d'accueil, comme une vraie appli.

## Importer les données de départ

Dans l'appli, onglet **"Plus" → "🌱 Importer les données de départ"**. Préremplit le budget et la liste **"À faire"** si elles sont vides — sans rien écraser si des données existent déjà.

---

## Et pour la convertir en appli Google Play ?

Une fois l'appli en ligne (déjà le cas) :

1. Va sur https://www.pwabuilder.com et colle l'adresse : `https://anais258.github.io/bolandoz40-app/`.
2. PWABuilder analyse l'appli et génère un **package Android (.aab)** prêt à publier.
3. Pour le publier sur le Play Store, il te faut un **compte développeur Google Play** (25 $ payés une seule fois, à vie, à créer sur https://play.google.com/console avec ton propre compte Google) — étape que je ne peux pas faire à ta place car elle demande ton identité et un paiement.
4. Une fois le compte créé, envoie le fichier `.aab` généré par PWABuilder dans la Play Console, remplis la fiche (description, captures d'écran, icône — déjà prêtes dans le dossier `icons/`), et publie. Délai de validation par Google : généralement quelques heures à 2-3 jours.

Pour un usage privé entre vous deux, l'icône sur l'écran d'accueil suffit largement et donne déjà 95% de l'expérience d'une appli native — le Play Store n'est utile que pour une distribution "officielle".

## En cas de souci

- **Bandeau orange "Firebase n'est pas encore configuré"** en haut de l'appli → la connexion à Firebase échoue (vérifier que `anais258.github.io` est bien dans la liste des domaines autorisés : Firebase Console → Authentication → Paramètres → Domaines autorisés).
- **Les données ne se synchronisent pas entre les deux téléphones** → vérifiez que vous avez bien ouvert le **même lien** (`https://anais258.github.io/bolandoz40-app/`) sur les deux appareils.
- **L'appli reste bloquée sur un écran figé (tirets, "...")** → une mise à jour a peut-être introduit une erreur ; utiliser le bouton **🔄 Forcer la mise à jour de l'appli** dans Plus, ou en dernier recours Chrome → Paramètres des sites → `anais258.github.io` → Effacer et réinitialiser.
- **Pour tout repartir de zéro** : supprime les documents dans Firestore Database (console Firebase) et relance l'import depuis "Plus".
