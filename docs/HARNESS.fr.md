# Prise en charge des CLI Harness

[中文](HARNESS.zh-CN.md) · [English](HARNESS.md) · **Français**

writing-loop possède exactement trois identifiants Harness CLI de premier rang. Ils sont
acceptés par `scheduler.cli` et `writing-loop run --cli`, et couverts par les tests de
contrat de l'ordonnanceur.

| ID Harness | Forme du processus | Transport du prompt | Gestion du modèle |
| --- | --- | --- | --- |
| `claude` | `claude -p ...` | `slash` (défaut) ou `inline` | les paliers Claude et l'effort sont transmis |
| `codex` | `codex exec ...` | `slash` (défaut) ou `inline` | `opus`/`sonnet` sont mappés au palier Codex courant ; `max` devient `xhigh` |
| `opencode` | `opencode run ...` | toujours `inline` | `provider/model` est transmis avec `-m`, sinon le modèle OpenCode par défaut est utilisé |

```bash
writing-loop run --cli claude
writing-loop run --cli codex
writing-loop run --cli opencode
```

L'ordre de résolution est `--cli` > `scheduler.cli` du projet > `scheduler.cli` du
workspace > `claude` par défaut. Toute autre valeur est refusée avant le lancement d'un
processus enfant.

## Frontière des providers

Le registre `providers{}` du workspace sert uniquement au routage du Harness `opencode`. Il rend les
endpoints OpenAI-compatible dans `opencode.json` ; les credentials restent des références
à des variables d'environnement. Le parseur de configuration valide ce registre pour toutes
les voies, mais Claude Code et Codex ne l'utilisent ni pour le routage ni pour l'authentification.

OpenCode exécute les skills d'agents sous forme de prompts inline, car il n'existe pas de
transport slash-plugin writing-loop. Son environnement de fire est hermétique par défaut et
l'ordonnanceur injecte la politique bornée `OPENCODE_PERMISSION`.

OpenCode reçoit les neuf skills d'agents de la writers' room, pas la skill attended
`add-script`. Pour un accueil OpenCode-only, créez d'abord le projet avec Studio ou les
commandes déterministes `writing-loop project plan` et `writing-loop project create`.

## Échappatoire de commande personnalisée

`scheduler.agents.<name>.command` peut remplacer l'argv rendu pour un agent. C'est une
échappatoire de test/opérateur, pas un quatrième Harness de premier rang. Brancher Gemini,
Kimi ou une autre commande ici n'apporte pas automatiquement les garanties certifiées de
transport, modèle, authentification, permissions, télémétrie ou portabilité. L'ordonnanceur
conserve les sémantiques d'environnement et de télémétrie de la voie `scheduler.cli` choisie ;
il ne déduit pas un nouvel Harness depuis l'exécutable de l'override.

Choisir `scheduler.cli: "codex"` sélectionne Codex comme Harness de writers' room. Ce choix
est indépendant de l'accélérateur optionnel `codex.enabled` du projet (conventions §24), qui
contrôle la génération d'images et la revue advisory par un second moteur. Chaque option peut
être activée sans l'autre.

## Écriture du scénario et production vidéo

Ces trois Harnesses exécutent la writers' room : plan, bible, épisodes, review, évaluation
et veille marché. Le tableau, le repo et le plan de contrôle de l'ordonnanceur restent locaux ;
un Harness peut néanmoins contacter son provider de modèle texte. Ces étapes ne nécessitent
**ni** ComfyUI, **ni** MiniMax H3, **ni** serveur GPU.

H3 est un backend séparé d'exécution audio/vidéo au niveau du plan. La chaîne GPU ne démarre
qu'après le gel des révisions scénario/plan et l'entrée des production intents dans la file de
rendu. Studio, le tableau, l'écriture et la review restent disponibles avec une flotte GPU à zéro.

## Vérification de disponibilité

Avant de sélectionner un Harness, vérifiez son exécutable puis faites un dry-run :

```bash
command -v claude    # ou codex / opencode
writing-loop doctor
writing-loop run --cli claude --dry-run
```

`command -v` prouve seulement l'existence d'un launcher. Un vrai fire exige encore un binary
vendor complet, une authentification valide et, pour les providers distants, un accès réseau.
