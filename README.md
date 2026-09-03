# botwikimaster

Bot d'ouverture de cartes pour [wiki-masters.com](https://www.wiki-masters.com/pulls).

C'est un script **Tampermonkey** : il s'exécute directement dans ton navigateur, par-dessus le site, en réutilisant ta session connectée. Il n'y a pas de partie serveur — aucun identifiant n'est stocké ni transmis ailleurs qu'à wiki-masters.com.

## Installation

1. Installe l'extension [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox).
2. Ouvre l'icône Tampermonkey → **Créer un nouveau script**, efface le contenu par défaut.
3. Colle le contenu de [`pack-opener.user.js`](pack-opener.user.js).
4. **Ctrl + S** pour sauvegarder.
5. Va sur [wiki-masters.com](https://www.wiki-masters.com/), connecté à ton compte, et recharge la page.
6. Un bouton flottant **📦** apparaît en bas à droite.

## Utilisation

- Clique sur **📦** pour ouvrir le panneau.
- **▶️ Démarrer** lance l'ouverture en boucle : le bot ouvre les packs disponibles, puis attend le cooldown avant de recommencer.
- **Ouvrir 1 pack** fait un tirage manuel unique.
- Le champ **Cooldown (s)** doit correspondre à celui de ton compte : **180s** pour un compte abonné, **600s** pour un compte gratuit.
- Le panneau affiche le nombre de packs ouverts, les cartes obtenues et la répartition par rareté (session en cours).

Le bot doit rester sur un onglet actif et ouvert pour continuer à tourner.

## Usage responsable

Le site est modéré. Ce script respecte le cooldown de ton compte et espace légèrement chaque requête ; évite quand même de le laisser tourner des heures sans surveillance, un volume de packs anormalement élevé peut attirer l'attention de la modération.
