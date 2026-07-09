# writing-loop

[English](README.md) · [中文](README.zh-CN.md) · **Français**

**Une writers' room de courts-métrages sériels, autonome, dans un dossier.**
Neuf agents lançables (Showrunner, Story-Designer, Episode-Writer, Reviewer,
Script-Doctor, Evaluator, Market-Watch, Reflect, Sweep) planifient, structurent,
écrivent, révisent et notent des scénarios de **micro-drames verticaux
(竖屏短剧)** — en se coordonnant uniquement par l'état des tickets sur un tableau
de bord local. Vous apportez le pitch ; la room le transforme en une série
cohérente de 60 à 100 épisodes.

Vous êtes le **showrunner des showrunners**, pas le chef de plateau : le travail
entre par le Showrunner (jamais directement chez un scénariste), les épisodes
pivots (keystone) passent d'abord sous la plume du Story-Designer, chaque brouillon
est vérifié indépendamment des affirmations de son auteur, et les jalons sont
filtrés par une grille de notation que vous pouvez lire.

> Comment ça marche à l'intérieur — les couches, les registres (ledgers), la
> topologie des portes de contrôle, les protocoles anti-dérive :
> [`docs/DESIGN.md`](docs/DESIGN.md). Ce README parle de l'**utilisation**.

---

## Ce que c'est

Un dossier = un projet = un drame = un tableau local. À l'intérieur, une petite
équipe maintient la cohérence d'une longue série grâce à quatre choses que les
scénarios d'IA de niveau citron négligent :

- **Une bible narrative** (`bible/north-star.md` + personnages + univers) — la
  couche stratégique figée : l'histoire en une phrase, le positionnement, le
  moteur émotionnel, la promesse de fin, et les lignes rouges créatives.
- **Un plan directeur** (`outline.md`) — le tableau des unités narratives, les
  cinq points d'ancrage du climax, le plan des paywalls, le registre de
  préfigurations (foreshadow) au niveau de la saison, et les plans de morceaux de
  bravoure et d'amorces de saison suivante.
- **Des fiches de beats par épisode** (`arcs/arc-NN-*.md`) — le contrat entre le
  squelette et le brouillon final : pour chaque épisode, le hook dur, la
  progression sur trois axes, le payoff, le hook de fin, les opérations de
  préfiguration, et les frontières **à-ne-pas-écrire**, plus les pistes candidates
  écartées et pourquoi elles l'ont été.
- **Trois registres** (`ledgers/`) — `foreshadow.md` (planté → ravivé → payé),
  `story-state.md` (état reconstructible + état de fin par épisode + marques de
  passivité), et `production.md` (registre des décors/personnages + compteurs de
  coûts). Chaque épisode les lit avant d'écrire et y réécrit une **déclaration de
  delta**, référencée à la ligne, dans le même commit.

Les jalons sont filtrés par une **grille à 4 dimensions / 16 indicateurs** exécutée
par l'Evaluator : une micro-porte à trois épisodes, une porte de verrouillage du
plan, la porte du **pack premier-paywall (一卡包)** — le premier vrai jalon de
livraison — puis les portes paywall-2, paywall-3 et finale.

Deux façons de démarrer un projet : **adaptation de roman** (拆书 — décomposer la
source en trois fiches de travail) ou **création originale** (avec un décorticage
léger d'un ou deux drames de comparaison).

## Démarrage rapide

**1. Installer le plugin** (une fois, dans Claude Code) :

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

**2. Démarrer un projet** — lancez la skill d'accueil depuis un dossier de projet
vide. Elle vous interroge (genre, profil d'audience, monétisation, pré-filtrage
conformité ; pour les adaptations, le texte source + le décorticage du livre),
échafaude l'arborescence bible / plan / registres / épisodes, enregistre le
projet, et crée le tout premier ticket (le ticket de plan) :

```
/writing-loop:add-script
```

**3. Faire tourner la room.** Chaque agent est une slash command ; un « fire » est
sans état et relit la vérité-terrain depuis le tableau + le repo à chaque fois.
Pilotez-les dans l'ordre naturel, ou pointez un `cron` externe dessus :

```
/writing-loop:showrunner-agent        # crée le ticket de plan, filtre les designs, promeut la file
/writing-loop:story-designer-agent     # écrit le plan + la bible, puis les fiches de beats par arc, engendre les tickets d'épisode
/writing-loop:episode-writer-agent     # tire les tickets d'épisode dans l'ordre, écrit les brouillons, déclare les deltas de registre
/writing-loop:reviewer-agent           # vérification indépendante par épisode (classification à trois voies, assertions citées)
/writing-loop:evaluator-agent          # exécute les portes milestone-eval (verrou du plan, pack premier-paywall, finale …)
/writing-loop:script-doctor-agent      # audit lent, rotatif, au niveau de la série
/writing-loop:market-watch-agent       # veille hebdomadaire des tendances + politiques de plateforme
/writing-loop:reflect-agent            # rétro quotidienne + curation des leçons
/writing-loop:sweep-agent              # hygiène du tableau, réparation d'étiquetage, récupération des orphelins
```

Il n'y a **ni CLI séparé ni serveur** — le tableau est de simples fichiers sous
`~/.writing-loop/<clé-projet>/board/`, et l'ordonnancement est soit un appel slash
manuel, soit votre propre `cron`. Copiez le dossier et vous avez migré de machine.

Le Showrunner garde la file peu profonde (Backlog-first ; lui seul promeut vers
Todo), les tickets d'épisode s'écoulent strictement dans l'ordre des épisodes
derrière un prérequis séquentiel, et chaque échec est routé par un chemin à trois
niveaux (reprise-sur-notes → `Mode: direct-write` → mise en attente humaine) au
lieu de bloquer.

## Les agents

| Agent | Archétype dev-loop | Rôle |
|---|---|---|
| **Showrunner** 总编剧 | PM | Unique propriétaire de la north-star + du plan ; accueil et direction ; crée les tickets créatifs ; exécute la porte de design ; déclenche les tickets milestone-eval ; la porte du Backlog. |
| **Story-Designer** 细纲师 | senior-dev | Transforme un ticket d'arc en fiches de beats par épisode (avec mise en concurrence de candidats + pistes écartées), engendre les tickets-enfants d'épisode, **écrit personnellement les épisodes pivots**, prend les escalades `Mode: direct-write`, mène le punch-up. |
| **Episode-Writer** 编剧 | junior-dev | Tire un ticket d'épisode, lit sa fiche de beats + les registres + l'épisode précédent, écrit le brouillon, s'auto-contrôle, déclare le delta de registre, passe la main pour révision. |
| **Reviewer** 审读 | QA | Vérification indépendante par épisode : classification à trois voies, lecture des épisodes adjacents, réconciliation des deltas — **chaque assertion narrative doit porter une citation du scénario**. Route les échecs de trois façons. |
| **Script-Doctor** 剧本医生 | Architect | Audit lent, filtré par SHA, rotatif, au niveau de la série (fermeture des préfigurations, séquences de hooks, cinq ancrages, glissement vers la passivité, cohérence des empreintes, rejeu des registres). Signale, n'édite jamais. |
| **Evaluator** 评估官 | — | Exécute les tickets milestone-eval : les six portes, la grille, les lignes rouges. Sépare chaque rapport en *assertable-par-machine* vs *en-attente-de-données-réelles*. |
| **Market-Watch** 市场监察 | Ops | Veille hebdomadaire du palmarès des tendances + politiques de plateforme ; évaluations datées de la fenêtre de genre ; une fenêtre qui se ferme / océan rouge ou une nouvelle politique crée un ticket `needs-showrunner`. |
| **Reflect** | Reflect | Rétrospective quotidienne ; curation du `lessons.md` au niveau opérateur à partir de preuves récurrentes. |
| **Sweep** | Sweep | Hygiène du cycle de vie : réparation d'étiquetage, récupération des orphelins, digest de santé du tableau. |

Plus la skill opérateur **`add-script`** — accueil, échafaudage et enregistrement
du projet.

Contrats de rôle complets : [`docs/DESIGN.md`](docs/DESIGN.md) §1 +
[`references/conventions.md`](references/conventions.md) (vue d'ensemble de la
topologie).

## Le système documentaire

Chaque projet est un repo git où les documents *sont* le code :

```
<script-repo>/
  bible/{north-star,characters,world}.md   # couche figée — les changements passent par le Showrunner / la porte de design
  outline.md                               # plan directeur : tableau des unités + cinq ancrages de climax + plan de paywall
                                           #   + registre de préfigurations au niveau saison + plans de morceaux de bravoure & amorces de saison
  arcs/arc-NN-<slug>.md                    # fiches de beats par épisode + mise en concurrence de candidats & pistes écartées
  ledgers/                                 # couche active (verrous O_EXCL ; discipline de rollup ≤15 Ko)
    foreshadow.md                          #   registre de préfigurations (planté → ravivé → payé ; état amorce-de-saison)
    story-state.md                         #   état courant + résumé d'état de fin par épisode + marques de passivité
    production.md                          #   budget de production : registre décors/personnages + compteurs de coûts
    archive/arc-NN.md                      #   rollup par arc
  episodes/ep-NNN.md                       # empreinte en frontmatter (hash de fiche / modèle / version de règles) + scénario
  evaluation/                              # rapports de jalon + listes de clips
  source/                                  # adaptation : texte source + trois fiches de décorticage
                                           #   original : décorticage léger de drames de comparaison
```

Deux disciplines empêchent le travail déjà validé de pourrir en silence : chaque
épisode enregistre le **hash de contenu** de la fiche de beats contre laquelle il a
été écrit (le Doctor le compare à chaque tour pour repérer les épisodes périmés),
et toute modification post-porte d'un arc/plan déclenche une **re-revue de delta**
qui crée des tickets de continuité pour les épisodes Done affectés.

## Les portes de jalon

L'Evaluator exécute six portes contre la grille et les lignes rouges, uniquement à
partir d'un ticket `milestone-eval` créé par le Showrunner :

| Porte | Déclencheur | Objet |
|---|---|---|
| **Micro-porte 3 épisodes** | ep3 Done | Force du hook : conflit d'ouverture à contre-pied, premier climax, séquence de hooks de fin. |
| **Porte de verrou du plan** | plan rédigé | Couche marché (cite Market-Watch, daté) + pré-notation du contenu + conformité + couverture du registre de préfigurations. |
| **Pack premier-paywall (一卡包)** | épisodes pré-paywall Done | Structure du paywall, proxy de taux de complétion, liste de clips, décompte de production, revérification de la fenêtre. **Le premier vrai jalon de livraison.** |
| **Porte paywall-2** | mi-série | Structure médiane + couche production cumulée + revérification marché. |
| **Porte paywall-3** | point 2/3 | Profondeur de la vallée aux 2/3, crédibilité du changement de voie, mobilisation des atouts pour la finale (chacun recoupé au scénario). |
| **Porte finale** | série complète Done | Grille complète + notation + compatibilité de l'amorce de saison. |

Un déclenchement de ligne rouge crée soit un Bug `redline` Urgent (corrigeable),
soit met le ticket d'évaluation en attente d'un humain (classe veto). Une notation
de la couche marché sans données fraîches est rapportée *non concluante*, jamais
devinée.

## Guérir la maladie de citron

Le design de writing-loop part d'un post-mortem d'une série IA ratée
(citron-script) : il ne manquait d'aucune connaissance du métier — il manquait de
**garanties mécaniques entre la couche de planification et la couche
d'exécution.** Chaque symptôme reçoit un mécanisme, pas une exhortation :

| Symptôme citron | Mécanisme writing-loop |
|---|---|
| Le brouillon est écrit **sans voir l'épisode précédent** | Prérequis séquentiel (l'épisode N attend `ep-(N-1)` dans main) + chaque scénariste lit l'image de fin précédente et les trois registres avant d'écrire. |
| **Zéro représentation des préfigurations** — plantées puis oubliées | Registre à trois états `foreshadow.md` + registre au niveau saison dans le plan + l'audit machine de fermeture du Doctor (en retard, payé-avant-planté, >8 épisodes sans ravivage). |
| Le **brouillon final est la seule étape non auditée** | Chaque épisode est vérifié indépendamment par le Reviewer via classification à trois voies, **chaque assertion narrative étayée par une citation du scénario** (non citable = non concluant = non validé). |
| Le **protagoniste dérive vers la passivité** | Un champ de proactivité sur chaque fiche de beats + marques cumulées `story-state` + le glissement de passivité sur 10 épisodes du Doctor (>30 % crée un Bug). |
| **Squelette et brouillon final se dissocient** ; les beats de climax retombent à plat | La fiche de beats par épisode est un contrat contraignant ; les épisodes pivots sont écrits par le Story-Designer en personne ; les portes de jalon vérifient la structure contre la grille. |

Le mappage complet (les dix leçons de citron → leurs porteurs mécaniques) est dans
[`docs/DESIGN.md`](docs/DESIGN.md) §0.

## Relation avec dev-loop

writing-loop est construit sur le squelette mécanique de
**[dev-loop](https://github.com/dyzsasd/dev-loop)** — de même origine par design.
La machine à états des tickets, l'accueil Backlog-first, la vérification à trois
voies, les protocoles claim/dedupe/blocked, le découpage de création à deux
niveaux (le senior conçoit → le junior implémente), le contrat observe-and-file, la
boucle d'auto-évolution lessons + reflect, et le protocole de tableau de fichiers
local sont tous repris. Le mappage :

| dev-loop | writing-loop |
|---|---|
| PM → doc de stratégie | Showrunner → north-star |
| senior-dev / junior-dev | Story-Designer / Episode-Writer |
| QA | Reviewer |
| Architect | Script-Doctor |
| Ops | Market-Watch |
| doc de design | fiche de beats d'arc |
| portes build/test | portes format + narration |
| mandat de couverture (tests) | mandat de réécriture des registres |
| rollback automatique | protocole fail-revert |

Ce qui est abandonné : PR / auto-merge / déploiement, la change-gate multi-repo
(l'idée survit dans le Doctor), les backends Linear/hub (v1 est local uniquement),
et les agents Communication/Codex. Voir [`docs/DESIGN.md`](docs/DESIGN.md) §11 pour
le registre complet reprise / remplacement / suppression.

## Limites de la v1

- **Tableau local uniquement.** L'unique backend est un simple tableau de fichiers
  sous `~/.writing-loop/` (protocole dans
  [`references/conventions.md`](references/conventions.md) §18). Pas de Linear, pas
  de hub, pas de partage réseau. L'ordonnancement est manuel (slash) ou votre
  propre `cron`.
- **Genres calibrés uniquement.** Les paramètres numériques des règles R sont
  calibrés (fondés sur des preuves) pour les drames **brainstorm-thrill /
  vengeance-gifle / professionnel épisodique**. Les profils héroïne sweet-pet /
  romance-tragique sont livrés marqués **`UNCALIBRATED`** (paramètres provisoires)
  — `add-script` avertit explicitement lorsque vous démarrez un projet sur un genre
  non calibré.
- La monétisation et le format sont paramétrés par un interrupteur
  (`paid-app | free-hongguo | reelshort-sub` ; `live-action | ai-anime |
  reelshort-en`), ce qui remodèle la position des portes et la sémantique du
  paywall.

## Licence

[MIT](LICENSE).
