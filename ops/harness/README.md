# Exploiter le harness

Le serveur garde agents et tâches actifs sans interface ouverte. Les heures de planification sont celles de l’hôte : **Europe/Paris**, configurable via `HARNESS_TIMEZONE` ou la config runtime. MT saute un fixe manqué de plus de dix minutes ; un intervalle overdue reprend une fois. Résultats dans les threads MT ; le dernier état/erreur dans Settings → Scheduled Tasks porte sur la dispatch de consigne, pas la fin du travail agent.

```sh
node scripts/harness-runtime.ts init
node scripts/harness-runtime.ts status
node scripts/harness-runtime.ts health
node scripts/harness-runtime.ts idle
```

Activer le service avec `systemctl --user enable --now mt-harness.service` après arrêt de tout hôte de validation utilisant le même home. Pour rester disponible après logout et avant login, appliquer `provision.yml` avec `harness_enable_linger=true` via Ansible. Ne pas démarrer deux hôtes sur `.t3/harness`.

Le timer inspecte les updates vers **04:00 Europe/Paris** (jusqu’à cinq minutes de décalage). Modifier son `OnCalendar` par un override systemd puis relancer le timer. Désactiver avec `systemctl --user disable --now mt-harness-maintenance.timer`.

La config privée `.t3/harness-operations/config.json` active séparément préparation, agent borné et promotion. Les sept usages doivent avoir des checks en environnement isolé, sans messages réels ni API payante. Après échec d’adaptation/validation, `retry` autorise une nouvelle tentative ; les candidats échoués restent inspectables. T3 est observé, MT est l’amont fusionné.

Le contrôleur copié fonctionne indépendamment du démarrage MT :

```sh
node .t3/harness-operations/controller/harness-runtime.ts recover
node .t3/harness-operations/controller/harness-runtime.ts rollback
```

Après admission potentielle, `recover` rejoue l’activation sans arrêter les travaux. Un rollback qui restaurerait un état ayant évolué est refusé. Après arbitrage explicite, `rollback --restore-snapshot` restaure l’ancien home entier et conserve aussi une copie unique de l’état actuel dans `preserved/`. Les travaux externes déjà produits ne sont pas annulés par une restauration SQLite. Ne supprimer les snapshots qu’après contrôle de récupération.
