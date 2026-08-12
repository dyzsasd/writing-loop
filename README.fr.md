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

> ### ▶ Commencez ici → **[Guide : d'un roman à un scénario](docs/GUIDE.fr.md)**
> Le document le plus utile — le parcours complet et pratique, de l'installation du
> plugin à la livraison de votre premier livrable (le 一卡包). À lire en premier.

> Comment ça marche à l'intérieur — les couches, les registres (ledgers), la
> topologie des portes de contrôle, les protocoles anti-dérive :
> [`docs/DESIGN.md`](docs/DESIGN.md). Ce README parle de l'**utilisation**.

---

## Ce que c'est

Un dossier = un projet = un drame = un tableau local. À l'intérieur, une petite
équipe maintient la cohérence d'une longue série grâce à trois autorités que les
scénarios d'IA de niveau citron négligent :

- **Une charte créative** (`bible/north-star.md`) — direction, public, promesse finale et lignes rouges.
- **Une structure unique** (`story/outline.v1.json`) — arcs, beats, épisodes et budgets narratifs.
- **Un graphe narratif unique** (`story/assets.v1.json`) — personnages, monde, lieux, préfigurations,
  continuité et double chronologie. Studio le rend directement ; S00 refuse les miroirs Markdown.

Les jalons sont filtrés par une **grille à 4 dimensions / 16 indicateurs** exécutée
par l'Evaluator : une micro-porte à trois épisodes, une porte de verrouillage du
plan, la porte du **pack premier-paywall (一卡包)** — le premier vrai jalon de
livraison — puis les portes paywall-2, paywall-3 et finale.

Deux façons de démarrer un projet : **adaptation de roman** (拆书 — décomposer la
source en trois fiches de travail) ou **création originale** (avec un décorticage
léger d'un ou deux drames de comparaison).

## Démarrage rapide

**1. Installer le plugin** (une fois). Dans **Claude Code** :

```
/plugin marketplace add dyzsasd/writing-loop
/plugin install writing-loop
```

Ou dans **Codex** (Claude Code et Codex fournissent le transport plugin/slash ;
voir conventions §24–§25) :

```
codex plugin marketplace add dyzsasd/writing-loop
```

OpenCode est le troisième Harness de premier rang de l'ordonnanceur. Après création
du projet, il reçoit inline les neuf skills d'agents de la writers' room ; pour un
accueil OpenCode-only, utilisez Studio ou `writing-loop project plan/create`.

Codex est aussi un accélérateur optionnel dans la boucle (opt-in via la config
`codex` du projet) : **génération d'images** — transformer les tokens visuels de la
bible en concept art de personnages / décors — et une **revue indépendante par un
second moteur** pour le Reviewer / Script-Doctor. Absent ou désactivé ⇒ tout se
comporte exactement pareil.

Pour utiliser directement Studio et les commandes, installez le **CLI npm
`writing-loop`** : accueil déterministe, ordonnanceur intégré et outillage du
tableau. La skill `add-script` peut se rabattre sur le cœur inclus dans le plugin ;
un projet existant peut aussi lancer les agents slash sans CLI global.

```bash
npm i -g @dyzsasd/writing-loop    # writing-loop run / status / doctor / fires …
```

Depuis le workspace, ouvrez la salle d'écriture locale :

```bash
writing-loop init                 # une fois : crée .writing-loop/ dans ce workspace
writing-loop studio               # http://127.0.0.1:8791/
writing-loop workspace list       # registre local des workspaces
writing-loop snapshot             # projection JSON multi-projets
writing-loop project list         # inclut les projets en pause
writing-loop system proposal list # améliorations système du workspace, jamais tickets narratifs
writing-loop production status    # registre local take/QC ; aucun appel distant
writing-loop production enqueue --plan --project demo --input enqueue.json
writing-loop production enqueue --confirm wlprodplan_… --project demo --input enqueue.json
writing-loop-production-worker --config /etc/writing-loop/production-runtime.json --once --json
writing-loop production handoff --project demo --input handoff.json  # takes approuvés ; JSON canonique sur stdout
writing-loop project plan --input request.json
writing-loop project create --input request.json --confirm wlplan_…
writing-loop project verify mon-drame
```

`init` attribue au workspace un identifiant opaque et durable dans
`.writing-loop/workspace.json`, puis tente d'enregistrer son chemin canonique dans
le registre local borné `$WRITING_LOOP_HOME/workspaces.json` (par défaut
`~/.writing-loop/workspaces.json`). Un échec du registre est signalé sans annuler
une initialisation déjà réussie. Les pointeurs se gèrent aussi explicitement :

```bash
writing-loop workspace add ../autre-room --label "Drames historiques"
writing-loop workspace list --json
writing-loop workspace remove ws_0123456789abcdef0123456789abcdef
writing-loop studio --workspace ws_0123456789abcdef0123456789abcdef
writing-loop studio --single       # conserver les anciennes URL mono-workspace
```

Le registre est un index de commodité reconstructible, jamais une source de vérité :
les autres commandes trouvent toujours la racine via le CWD ou
`WRITING_LOOP_WORKSPACE`, et `remove` ne supprime que le pointeur local. Avec plusieurs
entrées enregistrées, Studio affiche une page d'ensemble et place toutes les routes
d'un workspace sous `/w/<workspace-id>/`. Avec un seul workspace (ou `--single`), les
routes historiques `/p/...` et `/api/...` restent inchangées.

Studio n'écoute que la boucle locale et reconstruit la bibliothèque, la maturité
du récit, les décisions humaines et les agents en cours depuis les mêmes fichiers.
« Nouveau projet » et `/writing-loop:add-script` mènent le même entretien avec
l'opérateur, puis délèguent au même cœur d'accueil : plan déterministe **sans
écriture**, confirmation explicite du `planId`, réservation atomique des chemins
finaux, création journalisée et vérification après relecture. Les commandes ci-dessus exposent la même frontière
plan/create/verify. La création exige un nouveau repo ; Studio le limite en plus
au workspace courant.

Les améliorations du framework, du scheduler et des skills communs vont dans la
**boîte système** du workspace à `/system`, jamais dans le board créatif d'un drame.
`writing-loop system proposal list` expose les mêmes enregistrements immuables `WLSYS-*` ;
un ticket projet reste réservé à un travail dont la destination est le produit narratif.

Dans un projet, Studio suit les responsabilités créatives : **Vue d'ensemble / Analyse de
la source / Architecture / Timeline / Assets narratifs / Personnages / Assets visuels / Épisodes et qualité**. La vue source
n'affiche que les empreintes locales, la fenêtre de saison et les checkpoints des chunks —
jamais le texte brut du roman. Story Designer maintient le compagnon strict
`story/outline.v1.json` pour la structure et `story/assets.v1.json` pour les personnages, règles du
monde, lieux, objets, promesses, continuité et le double ordre chronologie/révélation. Chaque Harness
reçoit un Context Pack déterministe borné par ticket, agent et épisode au lieu de scanner tous les bibles.
La qualité distingue pass, fail, skipped et not-applicable, tout en gardant le veto éditorial
du Showrunner. Studio ne modifie pas ces assets et ne démarre pas H3/GPU.
Avant que la config rende le projet visible, un journal durable par projet permet
de reprendre après un vrai crash avec la **même requête et le `planId` initial**
si le commit et le manifeste complets sont déjà durables. Un arbre partiel antérieur
est conservé et impose un audit manuel ;
après publication, le reçu rend les reprises idempotentes. Il faut relancer la
commande : aucun daemon ne récupère en arrière-plan. Config/templates modifiés,
PID encore vivant, artefacts modifiés ou propriété ambiguë imposent un audit.

La page d'un projet ouvre en lecture seule les détails autorisés des tickets,
documents narratifs, épisodes, rapports et évaluations. Son activité bornée repose
sur un cache `ActivityIndexer` v2 persistant et reconstructible dans l'état du projet ;
les ledgers, tickets et fichiers du scénario restent les sources d'autorité. Une
signature de métadonnées évite les rescans profonds inutiles, tandis que toute lacune
d'amorçage, de rétention ou de reconstruction est signalée. Les curseurs de pagination
sont liés au workspace, au projet et à la génération de l'index. `run-state.json` ne
reste qu'une surcouche temps réel et n'entre jamais dans l'historique.

Les IDs SSE de Studio combinent le snapshot stable et les révisions durables des
index. Après redémarrage de Studio, le navigateur peut reprendre avec
`Last-Event-ID` ; un curseur d'un autre workspace ou du flux global est refusé. Le
SSE signale un changement, il ne remplace pas l'API d'activité historique bornée.
Modèles et durée ne sont affichés que s'ils sont prouvés ; sans données
de ledger, tokens et coût restent **inconnus / non enregistrés**, jamais estimés.
Outre la création confirmée, les seules écritures de Studio sont pause/reprise
atomiques. Un ordonnanceur actif observe la pause, cesse les nouveaux départs puis
termine son drain contrôlé.

La room reconnaît exactement **trois Harnesses de premier rang** — Claude Code
(par défaut), Codex et OpenCode. Les processus, transports de prompt, frontières de
provider, contrôles de disponibilité et la séparation écriture-sans-GPU sont décrits
dans [`docs/HARNESS.fr.md`](docs/HARNESS.fr.md). Sélectionnez-les avec
`writing-loop run --cli claude|codex|opencode` ; toute autre valeur est refusée.

**2. Démarrer un projet** — depuis un workspace initialisé, choisissez « Nouveau
projet » dans Studio ou lancez la skill d'accueil. Indiquez un chemin de repo qui
n'existe pas encore, sans créer le dossier. L'entretien couvre genre, audience,
monétisation et conformité. Pour une adaptation, il demande seulement le roman local
au workspace, votre brief global, la portée des droits et le Harness explicitement
autorisé à lire les chunks ; il ne vous demande pas de pré-calculer le découpage.
Après approbation du plan sans écriture, le cœur partagé crée l'arborescence,
enregistre le projet et vérifie les trois vérités-terrain :

```
/writing-loop:add-script
```

Pour une adaptation, la même confirmation lie les octets du roman, les copie/chunke
dans le runtime local et crée le ticket `source-analysis` ; outline reste
`source-pending`. Source Analyst choisit ensuite la fenêtre de saison, traite des lots
bornés sur tout le roman, construit les cartes globales des personnages, du monde et des saisons,
puis sélectionne les preuves de la saison courante avant de livrer un dossier plafonné.
Le projet peut être mono-saison, multi-saison ou indécis ; le nombre d'épisodes vise toujours la saison courante.
`source plan/register` restent
des commandes avancées de reprise/migration, **pas une seconde étape normale**.
`add-script` ne remplace jamais ce flux autonome par une skill externe d'analyse.

**3. Faire tourner la room.** Chaque agent est une skill sans état : Claude Code et
Codex peuvent l'invoquer comme slash command, tandis que le Harness OpenCode reçoit
inline les dix mêmes skills d'agents. Chaque fire relit la vérité-terrain depuis le
tableau + le repo. Pilotez-les dans l'ordre naturel, ou pointez un `cron` externe dessus :

```
/writing-loop:source-analyst-agent     # adaptation : sélection source bornée et dossier de preuves
/writing-loop:showrunner-agent        # accepte les portes source/plan et promeut la file
/writing-loop:story-designer-agent     # transforme le dossier validé en plan et beats
/writing-loop:episode-writer-agent     # tire les tickets d'épisode dans l'ordre, écrit les brouillons, déclare les deltas de registre
/writing-loop:reviewer-agent           # vérification indépendante par épisode (classification à trois voies, assertions citées)
/writing-loop:evaluator-agent          # exécute les portes milestone-eval (verrou du plan, pack premier-paywall, finale …)
/writing-loop:script-doctor-agent      # audit lent, rotatif, au niveau de la série
/writing-loop:market-watch-agent       # base marché initiale ; actualisation seulement à un jalon explicite
/writing-loop:reflect-agent            # rétro quotidienne + curation des leçons
/writing-loop:sweep-agent              # hygiène du tableau, réparation d'étiquetage, récupération des orphelins
```

Il n'y a **pas de backend distant** — le tableau reste composé de simples fichiers sous
`<workspace>/.writing-loop/<clé-projet>/board/`. Studio n'est qu'une projection
locale ; l'ordonnancement est un appel slash manuel, `writing-loop run`, ou votre
propre `cron`. Copiez le dossier et vous avez migré de machine.

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
  bible/north-star.md                      # charte créative ; propriété du Showrunner
  story/outline.v1.json                    # autorité unique structure saison/arc/épisode
  story/assets.v1.json                     # graphe factuel + double chronologie
  episodes/ep-NNN.md                       # empreinte en frontmatter (hash de fiche / modèle / version de règles) + scénario
  evaluation/                              # rapports de jalon + listes de clips
  source/                                  # adaptation : empreinte/brief + fiches (jamais le roman brut)
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
| Le brouillon est écrit **sans voir l'épisode précédent** | Prérequis séquentiel (l'épisode N attend `ep-(N-1)` dans main) + chaque scénariste lit l'image de fin précédente et un Context Pack ciblé depuis `story/assets.v1.json`. |
| **Zéro représentation des préfigurations** — plantées puis oubliées | Assets typés de préfiguration + faits de cycle de vie + audit machine de fermeture du Doctor (en retard, payé-avant-planté, >8 épisodes sans ravivage). |
| Le **brouillon final est la seule étape non auditée** | Chaque épisode est vérifié indépendamment par le Reviewer via classification à trois voies, **chaque assertion narrative étayée par une citation du scénario** (non citable = non concluant = non validé). |
| Le **protagoniste dérive vers la passivité** | Champ d'agence dans `story/outline.v1.json` + faits/événements structurés + glissement de passivité sur 10 épisodes du Doctor (>30 % crée un Bug). |
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

- **Tableau local uniquement.** L'unique source de vérité est un simple tableau de fichiers
  sous `<workspace>/.writing-loop/` (protocole dans
  [`references/conventions.md`](references/conventions.md) §18). Studio est une
  projection loopback, pas un second backend. Pas de Linear, de service cloud ou
  de partage réseau. L'ordonnancement est manuel, intégré, ou via votre `cron`.
- **Le socle de la Phase 2 est terminé, pas la parité produit complète.** L'accueil
  confirmé par empreinte, la reprise par journal, les détails autorisés, l'activité
  bornée persistante, le SSE reprenable après redémarrage, l'identité/registre de
  workspaces et l'espace de noms Studio multi-workspace sont livrés. Les métriques
  d'écriture avancées et les coûts réels attendent des champs de ledger faisant
  autorité ; sans preuve, la valeur reste `unknown`, jamais estimée.
- **La Phase 3C livre un control plane de production déployable à distance et les noyaux d'une
  Gateway privée, pas une appliance GPU intégrée.** Elle ajoute au ledger et au coordinateur
  récupérable des Phases 3A/3B un enqueue plan/confirmation sans réseau, un worker one-shot, une
  configuration runtime réservée au propriétaire, une politique d'entrée par workflow, un contrat
  H3 à quatre modèles et pipeline actif fixe, le staging source→consumer, la matérialisation
  template→bound, des reçus vérifiés, le règlement durable de l'admission, et des handlers Gateway stage/job/output isolés par
  scope derrière un routeur strict. La surface production HTTP de Studio reste en lecture seule ;
  endpoint, profil et token ne viennent ni du navigateur ni des arguments d'enqueue. Le déploiement
  doit encore fournir l'inférence H3/ComfyUI, TLS/mTLS, l'émission de credentials, les profils serveur
  et attestations modèle/custom-node, le stockage, l'admission/quota durable, la réconciliation de
  facturation et toute API Studio modifiable vérifiée. Le fixture API-format représentatif n'a pas
  passé de `/prompt` ComfyUI réel et ne prouve pas un déploiement H3. H3 génère l'audio/vidéo des plans ; il ne
  remplace pas le modèle d'écriture.
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
