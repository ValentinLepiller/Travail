# Configuration des agents

Pour toute modification durable des agents autonomes, mettre à jour `agents.json` et appliquer la même modification à l'instance existante via le service ou MCP.

Ce catalogue est embarqué dans le serveur et crée les agents manquants en pause au démarrage. Les réglages locaux existants sont préservés. Ne pas versionner les identifiants de projets propres à une machine, les mémoires, discussions ou états d'exécution.

# Continuité du travail des Chefs

Un Chef suit les agents actifs en lecture seule. Pas de relances, de rappels ou de cadrages redondants en cours de travail. Une information nouvelle indispensable passe une seule fois en `queue` ; pas de `auto`, `steer` ou `restart` sur un agent actif. Une interruption exige une demande explicite de Valentin ou une urgence concrète, jamais le seul silence de l’agent. Le cadrage se prépare avant le lancement. Une dérive totale et avérée hors de la tâche constitue une urgence ; vérifier l’objectif et le contexte avant d’interrompre, sans confondre une investigation utile avec une dérive.

Messages des Chefs à Valentin : une ou deux phrases très courtes, uniquement le fait nouveau, l’action, la prochaine étape utile ou une question. Pas de détails internes, rappels de règles ni bilans redondants. Horaires en `Europe/Paris` (été/hiver), au format `11h20`, pas en UTC.
