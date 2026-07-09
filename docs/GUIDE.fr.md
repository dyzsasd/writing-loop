# Guide : d'un roman à un scénario

[English](GUIDE.md) · [中文](GUIDE.zh-CN.md) · **Français**

> C'est le document le plus important : le parcours complet et pratique, de
> l'installation du plugin à la livraison de votre premier livrable / testable
> **pack premier-paywall (一卡包)**. Il suit par défaut la piste **adaptation de
> roman** ; les différences de la piste **création originale** sont à la fin.

---

## Prérequis

- **Claude Code ou Codex** CLI installé — les deux conviennent (commandes
  d'installation dans le README ; ce guide prend Claude Code comme exemple).
- `git` sur votre machine.
- Le roman en **texte brut** (`.txt` / `.md` ; convertissez d'abord PDF/EPUB en texte).

---

## Étape 0 — Installer le plugin

Dans Claude Code :

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

Vous disposez maintenant des slash commands `/writing-loop:*` (9 agents + `add-script`).

---

## Étape 1 — Créer le dossier du projet et y déposer le roman

**Workspace vs. repo de scénario** : un **workspace** est un dossier ordinaire
contenant un ou plusieurs **repos de scénario** (chaque drame est son propre repo git
— « les documents *sont* le code ») plus un répertoire d'état d'exécution
`.writing-loop/` (config + tableau + lessons, créé automatiquement par `add-script`).
**Copier ce seul dossier workspace = migrer chaque drame + ses tickets en cours**
(voir « Migration » à la fin).

Ci-dessous, `~/dramas/` est votre workspace et `my-drama/` le repo d'un drame :

```bash
mkdir -p ~/dramas/my-drama/source          # ~/dramas = workspace, my-drama = repo de scénario
git -C ~/dramas/my-drama init
cp /chemin/vers/votre-roman.txt ~/dramas/my-drama/source/novel.txt
```

> Point clé : le texte du roman doit se trouver sous `source/` du repo — le
> décorticage d'adaptation travaille à partir de lui.

Dans Claude Code, placez le répertoire de travail sur ce dossier de projet
(`cd ~/dramas/my-drama`), puis passez à l'étape 2. (`add-script` considère `~/dramas/`
comme la racine du workspace et y crée `.writing-loop/` ; pour le premier drame, il
confirme cette racine avec vous.)

---

## Étape 2 — Accueil du projet (adaptation) — une seule commande

```
/writing-loop:add-script
```

Elle vous **interroge** (elle redemande tout élément manquant ; elle n'insère jamais
de valeurs de remplissage dans le config). Pour la piste adaptation, préparez-vous à
répondre :

**Requis pour tout projet**

- **key** : clé de projet en minuscules (ex. `my-drama`) — nom du répertoire de
  données + préfixe de tickets + clé de config ; unique dans le workspace.
- **title** : le titre du drame.
- **Profil d'audience (porte dure)** : doit inclure **sexe + âge** (région /
  habitudes de paiement recommandés). Vague ou manquant = bloqué — c'est la
  prévention à l'entrée de la ligne rouge d'évaluation ①.
- **Pré-filtrage conformité** : politique / criminel (illégalité impunie) / éthique
  amoureuse / limites des politiques de plateforme, point par point ; les conclusions
  sont écrites dans les Non-goals de `bible/north-star.md` (une contrainte durable,
  revérifiée à chaque porte).
- **genre profile** : `brain-hole` / `revenge-slap` / `profession-unit` sont calibrés ;
  les profils héroïne `sweet-pet` / `angst` sont **UNCALIBRATED** — vous recevrez un
  avertissement explicite que les paramètres sont provisoires et la qualité à risque.
- **monetization** : `paid-app` / `free-hongguo` / `reelshort-sub` (remodèle la
  sémantique du paywall et des portes).
- **format** : `live-action` / `ai-anime` / `reelshort-en` (fixe la fourchette de mots
  et le tableau de budget de production ; pour ai-anime, les VFX bon marché sont un atout).
- **Échelle** : `totalEpisodes`, `paywall` (numéros de cartes de secours ; carte 1 ⊂
  épisodes 8–12), `maxPrimaryScenes`, `maxNamedCharacters`.

**Spécifique à l'adaptation (automatique)**

- Le texte du roman est déjà dans `source/` → elle exécute la **checklist de
  sélection du livre** (la trame peut-elle se compresser ≥10:1 ? densité des
  morceaux de bravoure ? compressibilité des personnages ?) et signale le risque le
  cas échéant.
- Elle produit les **trois fiches de décorticage** dans `source/` : `mainline.md`
  (squelette de la trame), `highlights.md` (liste des morceaux de bravoure / beats à
  sensation — l'atout central de l'IP), `characters-function.md` (table des fonctions
  des personnages, compressée à 3–5 principaux / ≤20 nommés).
- **Palier de fidélité** : par défaut **adaptation fidèle (贴改)** ; le
  **placage-de-coquille est désactivé par défaut** et inscrit dans les Non-goals.
- **Limite de droits** : bornée par la licence (consignée dans north-star) ; aucun
  élément reconnaissable d'une autre IP.

Ensuite `add-script` automatiquement :

- **SCAFFOLD** : génère `bible/` (north-star / characters / world), `outline.md`,
  `ledgers/` (foreshadow / story-state / production + archive/), `episodes/`,
  `evaluation/` ; `git commit`.
- **REGISTER** : enregistre le projet dans `~/dramas/.writing-loop/config.json`, crée le
  répertoire de tableau `~/dramas/.writing-loop/my-drama/board/`, échafaude `lessons.md`.
- **Premier ticket de plan** : crée un ticket outline (owner=showrunner,
  tier=story-designer).
- **VERIFY** : relit, valide et vous indique l'étape suivante.

> L'entretien d'`add-script` demande le mode — répondez `dry-run` la première fois :
> elle imprime seulement ce qu'elle *ferait*, sans rien écrire ni committer. Une fois
> les conclusions de l'entretien confirmées, relancez `/writing-loop:add-script` et
> répondez `live` pour l'accueil réel du projet.

---

## Étape 3 — Faire tourner la writers' room

Chaque agent est une slash command et est **sans état** : chaque passage relit la
vérité-terrain depuis le tableau + le repo et fait ce que son rôle a de prêt, ou ne
fait rien. Ils se passent le relais **uniquement par les tickets** — vous ne
transmettez jamais le travail à la main.

**Premier cycle (l'ordre naturel pour l'adaptation) :**

```
/writing-loop:showrunner-agent       # dirige direction, portes, jalons et libérations ultérieures (le ticket de plan a été créé directement en Todo par add-script — exemption §5a — le story-designer peut le prendre directement)
/writing-loop:story-designer-agent    # lit les fiches de décorticage → écrit outline.md + la bible ; puis les fiches de beats par arc
/writing-loop:market-watch-agent      # évaluation datée de la fenêtre de genre — la couche marché de la porte de verrou du plan en dépend ; données manquantes = item inconclusive, et les cas ligne-rouge se garent en attendant que vous les fournissiez
/writing-loop:evaluator-agent         # porte de verrou du plan (marché + pré-notation contenu + conformité)
/writing-loop:episode-writer-agent    # écrit les épisodes dans l'ordre ; les épisodes pivots sont écrits par le Story-Designer
/writing-loop:reviewer-agent          # révision indépendante par épisode (classification à trois voies + lecture adjacente + assertions citées) ; les échecs routent de trois façons
```

Ensuite c'est une **rotation** : `showrunner → story-designer → episode-writer →
reviewer → evaluator → script-doctor`, à répéter jusqu'à un jalon.

**Rappel palier keystone** : les épisodes keystone (3 premiers / épisodes de paywall
/ finale) doivent être validés par un reviewer au palier maximal — lancez
`/writing-loop:reviewer-agent` en `opus`/`max`, sinon l'épisode est sauté en attente
d'un fire de palier supérieur et le pipeline se bloque (sweep le signale dans le
digest de santé du tableau).

Vous n'avez pas besoin de mémoriser l'ordre exact — **le tableau impose l'ordre
réel** : l'épisode N ne peut s'écrire tant que `ep-(N-1)` n'est pas Done ; les
tickets-enfants ne sont pas libérés tant que le plan n'a pas passé sa porte ; les
portes de jalon utilisent `Blocked-by` pour bloquer la surproduction. Tout agent qui
ne trouve rien à faire rapporte « rien à faire » et sort — lancez simplement le suivant.

**Pour automatiser** (au lieu de les taper un par un) : utilisez `/loop` pour les
faire tourner à intervalle, ou pointez le `cron` système sur ces commandes. Comme
chaque fire est sans état, démarrer et arrêter est toujours sûr.

---

## Étape 4 — Surveiller les jalons ; le premier livrable est le 一卡包

L'Evaluator produit des rapports aux points clés (dans `evaluation/`) :

| Porte | Déclencheur | Ce que vous obtenez |
|---|---|---|
| Micro-porte 3 épisodes | ep3 Done | Contrôle de force du hook (conflit à contre-pied ep1, premier climax ep3) |
| Porte de verrou du plan | plan rédigé | Pré-notation marché + contenu, conformité, couverture du registre de préfigurations |
| **Pack premier-paywall (一卡包)** | 10 premiers épisodes Done | **Le premier vrai livrable / testable** : Bible + 10 premiers épisodes + liste de clips + score proxy de taux de complétion |
| Portes paywall-2 / -3 / finale | mi-série / point 2/3 / série complète | Notation progressive ; la porte finale attribue une note S+…C |

**Après la porte du premier-paywall vient le « point de décision opérateur »** — le
système s'arrête et attend votre choix : sortir le pack pour tester avec des données
réelles, ou continuer à produire. C'est votre principal levier de contrôle.

---

## Comment le système vous joint (la boucle humain-dans-la-boucle)

- **Tickets garés (décision humaine)** : tout ce que vous seul pouvez décider
  (changement de direction, veto, fix-exhausted, attente de données de diffusion)
  apparaît comme un ticket garé. Avec `comms.provider` configuré, le système pousse
  une notification hors-bande (ID du ticket + décision attendue) ; sinon, consultez
  la section needs-attention du digest quotidien (sous
  `~/dramas/.writing-loop/my-drama/reports/`).
- **Attente à la porte** : après la porte du premier-paywall, le système s'arrête et
  attend votre décision — il ne continue jamais à produire de lui-même (voir étape 4).
- **Donner un retour à un agent** : écrivez un fichier **frère**
  `<nom-du-rapport>.review.md` à côté du rapport de cet agent (même répertoire
  `~/dramas/.writing-loop/my-drama/reports/`). Au passage suivant, l'agent distille
  vos remarques dans sa propre section de lessons et change durablement de
  comportement.
- **Rapports d'évaluation** : sous `evaluation/` du repo de scénario.

---

## Où sont les sorties / comment suivre l'avancement

- **Scénarios** : `~/dramas/my-drama/episodes/ep-001.md …`
- **Plan & bible** : `outline.md`, `bible/`
- **Registres préfiguration / état / production** : `ledgers/` (le cœur de
  l'anti-fracture et de l'anti-préfiguration-perdue)
- **Rapports d'évaluation** : `evaluation/`
- **Tableau de tickets** (ce sur quoi l'équipe travaille) :
  `~/dramas/.writing-loop/my-drama/board/tickets/*.md`

> Tout l'état d'exécution (config + tableau + lessons + rapports) se trouve sous
> `~/dramas/.writing-loop/` — un **frère des repos de scénario**, donc l'état des
> tickets **ne pollue jamais l'historique git de vos textes**.

---

## Migration : copier un workspace pour tout déplacer

Comme le config utilise un **`repoPath` relatif** et que l'état d'exécution vit dans
le workspace, tout migrer (tickets en cours compris) tient en une copie :

```bash
cp -r ~/dramas /nouvel/endroit/dramas   # scénarios + plans + registres + tableau en cours, ensemble
```

- Utilisez **`cp` (pas `git clone`)** : un clone n'apporte que la sortie créative d'un
  seul repo de scénario, pas les tickets en cours.
- Pour ne déplacer que la **sortie créative finie** (sans l'état d'ordonnancement en
  cours) : `git clone ~/dramas/my-drama` — chaque repo de scénario est autonome (bible
  / outline / ledgers / episodes, tout à l'intérieur).
- Ne mettez pas le workspace sur un partage réseau pour une écriture multi-machine
  concurrente (cela ferait une race) ; une copie-migration séquentielle est correcte.

---

## Mettre à niveau le plugin (avec un projet en cours)

**La mise à niveau ne migre aucune donnée** — les formats tableau/registres/repo sont
stables, et chaque fire d'agent est sans état et relit la spec la plus récente ; mettre
à niveau = remplacer le plugin + redémarrer les boucles. Cinq étapes :

1. **Arrêter les boucles au bon moment** : pour chaque fenêtre de boucle, attendez la
   fin du fire en cours (no-op ou terminé), puis Ctrl-C ; si un agent est en plein
   épisode, laissez-le committer. (Même un kill en plein fire est couvert par la
   récupération d'orphelins de 60 minutes — vous perdez juste une demi-passe.)
2. **Mettre à jour le plugin** : dans Claude Code, ouvrez le menu `/plugin` et mettez
   à jour writing-loop (la source marketplace pointe sur GitHub et tire la nouvelle
   version) ; sinon, désinstallez puis refaites `marketplace add dyzsasd/writing-loop`
   + install.
3. **Vérifier la version** : dans une session neuve, lancez un agent — les agents sans
   travail doivent sortir en une ligne no-op (pas de long boot) ; ou vérifiez que le
   cache du plugin montre le nouveau numéro de version.
4. **Redémarrer les boucles** comme d'habitude. Le premier fire du showrunner fera un
   boot complet (« premier instantané du tableau = changé ») — c'est normal.
5. **Revérifier les paliers de modèle** : en phase keystone (3 premiers épisodes /
   paywall / finale), le reviewer doit tourner au palier maximal (opus/max) — le sweep
   mis à niveau signale les épisodes keystone bloqués dans son digest.

(Optionnel) Pour adopter la disposition « copier un dossier = migrer » : **déplacez**
(`mv`, pas copie — deux copies du même projet s'éclipseraient par proximité) l'ancien
`~/.writing-loop/` dans votre dossier workspace et passez `repoPath` en nom de
répertoire relatif ; mettez aussi à jour tout chemin codé en dur dans votre script de
lancement. Ne pas migrer reste pleinement compatible — le nouveau résolveur remonte
les répertoires et trouve l'ancien `.writing-loop/` dans votre home.

---

## Un exemple minimal (ce que vous tapez réellement)

```
# 1. Installer (une fois)
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```
```bash
# 2. Créer le repo, déposer le roman
mkdir -p ~/dramas/nanny-revenge/source && git -C ~/dramas/nanny-revenge init
cp ~/Downloads/roman-nounou.txt ~/dramas/nanny-revenge/source/novel.txt
```
```
# 3. Accueil (depuis ~/dramas/nanny-revenge) — dry-run d'abord pour revoir l'entretien
/writing-loop:add-script
# Répondez en gros : key=nanny-revenge, title=<titre du drame>,
# audience=femmes 28-45 marché de masse payant, genre=revenge-slap,
# monetization=paid-app, format=ai-anime, totalEpisodes=40, card1=épisode 10
```
```
# 4. Piloter la room (dry-run confirmé → relancez add-script en répondant live, puis faites tourner)
/writing-loop:showrunner-agent
/writing-loop:story-designer-agent
/writing-loop:market-watch-agent
/writing-loop:evaluator-agent
/writing-loop:episode-writer-agent
/writing-loop:reviewer-agent
# …répétez la rotation jusqu'à la porte premier-paywall → point de décision
```

---

## Deux rappels

1. **Dry-run avant live.** Les conclusions de l'entretien (audience, genre, positions
   de paywall) contraignent tout le pipeline longtemps — cela vaut une double
   vérification.
2. **Héroïne sweet-pet / romance-tragique sont UNCALIBRATED.** Ça tourne, mais les
   paramètres de beats sont provisoires et `add-script` vous avertit ; les trois
   genres à héros masculin (brain-hole / vengeance / professionnel) ont une
   calibration fondée sur des preuves et sont les plus fiables.

---

## Ce qui change pour la création originale (sans partir d'un roman)

À l'étape 2, `add-script` prend la **branche originale** : pas de texte source ; à la
place, vous fournissez des **drames de comparaison** (+ heat + en quoi vous différez),
et le système fait un décorticage léger de 1–2 d'entre eux (squelette de structure /
liste de sensations / séquence de hooks) dans `source/` pour l'étape du plan. Tout le
reste (étapes 3–4) est **identique** — les deux pistes ne divergent qu'avant le plan
et convergent ensuite.

---

Envie de le voir à l'œuvre ? Donnez-moi le texte de n'importe quel roman que vous
avez sous la main, et je peux réellement lancer `add-script` + le premier cycle
et produire de vraies sorties (plan, premiers épisodes, rapport d'évaluation).
