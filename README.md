# botwikimaster

Bot d'ouverture de cartes et de vente aux enchères pour [wiki-masters.com](https://www.wiki-masters.com/pulls).

C'est un script **Tampermonkey** : il s'exécute directement dans ton navigateur, par-dessus le site, en réutilisant ta session connectée. Il n'y a pas de partie serveur — aucun identifiant n'est stocké ni transmis ailleurs qu'à wiki-masters.com.

## Installation

1. Installe l'extension [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox).
2. Ouvre l'icône Tampermonkey → **Créer un nouveau script**, efface le contenu par défaut.
3. Colle le contenu de [`wikimaster-bot.user.js`](wikimaster-bot.user.js).
4. **Ctrl + S** pour sauvegarder.
5. Va sur [wiki-masters.com](https://www.wiki-masters.com/), connecté à ton compte, et recharge la page.
6. Un bouton flottant **📦** apparaît en bas à droite.

## 📦 Pack Opener

- **▶️ Démarrer** lance l'ouverture en boucle : le bot ouvre les packs disponibles, puis attend le cooldown avant de recommencer.
- **Ouvrir 1 pack** fait un tirage manuel unique.
- Le champ **Cooldown (s)** doit correspondre à celui de ton compte : **180s** pour un compte abonné, **600s** pour un compte gratuit (déjà réglé par défaut).
- Le panneau affiche le nombre de packs ouverts, les cartes obtenues et la répartition par rareté (session en cours).

## 💰 Vente aux enchères

Met automatiquement en vente toute ta collection, **sauf tes favoris**, pour maximiser l'argent du jeu.

- **📎 Exemplaires à garder par carte** (1 par défaut) : s'applique uniquement aux cartes qui ont une **vraie valeur marchande** — le bot écoule les doublons au-delà de ce nombre, exemplaire par exemplaire, et garde toujours au moins 1 exemplaire de ces cartes-là. La collection est rechargée à chaque passe (toutes les 5 min), donc il continue naturellement tant qu'il reste des doublons.
- **🛡️ Garder quand même 1 exemplaire des cartes sans valeur** (décoché par défaut) : par défaut, une carte jugée sans valeur (prix sous le seuil, ou C/PC sans historique de vente) est défaussée **même si c'est ton seul exemplaire** — sinon, si tu n'as aucun doublon dans toute ta collection, rien n'est jamais défaussé. Coche cette case si tu préfères garder 1 exemplaire de chaque carte quoi qu'il arrive.

- **Prix** : le bot regarde l'historique des ventes de chaque carte sur le marché et la met en vente à **marge % au-dessus du prix moyen** (110% par défaut, réglable). Si aucune vente n'est connue pour la carte, il utilise le **prix plancher par rareté** que tu définis dans le panneau.
- **Durée d'enchère** réglable (10 min à 24 h).
- **🛡️ Protection des Légendaires (L)** : activée par défaut, ces cartes ne sont jamais mises en vente même sans les mettre en favori.
- **🗑️ Défausse automatique**, dans deux cas — le bot clique directement sur le bouton **« Défausser »** de la fiche carte au lieu de la mettre aux enchères (1 💰 garanti et immédiat) :
  - le prix calculé est **sous le seuil réglable** (10 💰 par défaut) ;
  - **aucune vente n'est connue sur le marché pour cette carte ET sa rareté est C ou PC** — à ce niveau de rareté sans historique de vente, ça ne vaut pas la peine d'immobiliser un slot d'enchère.
- **Mots-clés à toujours exclure** : une whitelist par mots-clés séparés par `;` (par défaut : `triathlon`), en plus des favoris et des Légendaires. Le matching regarde le **titre, la catégorie et la description** de la carte — pas que le titre exact — donc `triathlon` protège toute carte liée au thème, pas seulement une carte titrée « Triathlon ».
- Il essaie d'abord la vente rapide (API), et si le site la refuse, bascule automatiquement sur une simulation de clic sur la page **Collection** — **reste sur cet onglet, sur `/collection` si possible**, pendant que le module tourne.
- Il retraite toute la collection toutes les 5 minutes (pour couvrir les nouvelles cartes obtenues entre-temps).
- **Quota d'enchères actives** : le site limite le nombre d'enchères simultanées (visible dans le modal de vente, ex: « Enchères actives : 0/5 »). Le bot le détecte et met la vente en pause dès qu'il est atteint, plutôt que d'insister pour rien — il retente à la prochaine analyse (5 min).

### ⭐ Protection des favoris

Le site n'expose pas directement le statut « favori » dans son API de collection. Le bot le détecte **passivement** : dès que tu consultes ta page **Liste de souhaits / Favoris** sur le site, il repère automatiquement les cartes qui s'y trouvent et ne les vend jamais.

**Important** : avant de lancer la vente aux enchères, va au moins une fois sur ta page Favoris pour que le bot les mémorise (le compteur de favoris détectés est visible dans les logs). Tant qu'aucun favori n'a été détecté, le bot te prévient — pense aussi à la liste d'exclusion manuelle en secours.

Le bot doit rester sur un onglet actif et ouvert pour continuer à tourner.

## Usage responsable

Le site est modéré. Ce script respecte le cooldown de ton compte, espace légèrement chaque requête et limite le rythme des ventes ; évite quand même de le laisser tourner des heures sans surveillance, un volume anormalement élevé peut attirer l'attention de la modération.

## Limites connues

- Les noms de champs API (`cards`, `packs_remaining`, `card_id`, `final_price`...) n'ont pas pu être vérifiés en conditions réelles depuis l'environnement de développement (accès réseau bloqué vers wiki-masters.com). Si une action échoue silencieusement ou avec une erreur inattendue, récupère la réponse JSON exacte de la requête concernée (onglet Réseau des outils de développement du navigateur) pour qu'on ajuste le code en conséquence.
- La vente via clic simulé nécessite de rester sur `/collection` : si tu navigues ailleurs pendant une vente, le module se met en pause et te le signale dans les logs.
