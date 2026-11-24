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

### Mises à jour de Travail

Les agents publient sur `Travail/main`. Le bouton bleu au-dessus d’**Usage** apparaît quand
une nouvelle révision est disponible. Le clic lance la préparation et la validation isolées,
puis l’activation si le service est inactif au sens de la maintenance (aucun travail en cours).
Après installation, rouvrir Travail ou actualiser la page web.

Pour activer ce canal sur une installation précédente, exécuter une fois depuis une copie à jour
de `main`, en gardant cette copie jusqu’à la fin de l’installation :

```sh
HARNESS_OPERATIONS=/chemin/du/harness/.t3/harness-operations node scripts/harness-runtime.ts travail-bootstrap
journalctl --user -u travail-install-update.service -f
```

L’amorçage utilise le contrôleur de cette copie à jour. Si le serveur précédent ne fournit pas
l’API de quiescence, l’installation s’arrête avant la bascule et le serveur reste disponible.
Le premier déploiement bascule la maintenance amont en inspection seule.

Le contrôleur copié fonctionne indépendamment du démarrage MT :

```sh
node .t3/harness-operations/controller/harness-runtime.ts recover
node .t3/harness-operations/controller/harness-runtime.ts rollback
```

Après admission potentielle, `recover` rejoue l’activation sans arrêter les travaux. Un rollback qui restaurerait un état ayant évolué est refusé. Après arbitrage explicite, `rollback --restore-snapshot` conserve la base SQLite et les réglages actuels dans `preserved/`, puis restaure leurs versions sauvegardées. Les worktrees, archives et fichiers des agents restent en place. Ne supprimer les snapshots qu’après contrôle de récupération.
