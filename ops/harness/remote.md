# HTTPS sans domaine

Choix actuel : **Quick Tunnel Cloudflare gratuit**, sans compte ni domaine, avec appairage/auth MT. L’adresse HTTPS change à chaque recréation du tunnel ; elle est affichée localement et écrite dans `.t3/harness-remote/status.json`. Aucun lien envoyé par messagerie. Quick Tunnel n’a pas de garantie de disponibilité.

La configuration locale et le service utilisateur sont préparés. Après validation du build/auth et coordination du parent seulement, autoriser le port partagé dans `.t3/harness-remote/config.json`, puis :

```sh
node scripts/harness-remote.ts check "$PWD/.t3/harness-remote/config.json"
systemctl --user daemon-reload
systemctl --user enable mt-harness-remote.service
systemctl --user start mt-harness-remote.service
```

Le service démarre avec `mt-harness.service`. Linger est activé ; boot/logout restent à exercer. Arrêt/désactivation : `systemctl --user stop` / `disable mt-harness-remote.service`. Révoquer les clients dans les connexions MT pour invalider aussi leurs WebSockets existants. Le lien d’appairage privé doit être généré séparément par MT ; ne pas le publier dans les logs.

Le gateway est indépendant des releases MT : son unité utilise les scripts fixes de ce checkout et transmet les flux sans décoder le protocole applicatif. À chaque démarrage, il vérifie l’identité MT et les refus anonymes HTTP/WebSocket avec la version annoncée par le serveur. Un changement incompatible de descriptor/auth/URL empêche la publication. Il redémarre avec le service MT ; ses scripts ne font pas partie de l’empreinte d’une release MT.

Santé post-promotion (C utilise les chemins absolus du checkout indépendant) :

```sh
node scripts/harness-remote.ts health "$PWD/.t3/harness-remote/config.json" "$PWD/.t3/harness-operations/config.json"
```

La commande attend le nouveau tunnel, vérifie HTTPS/identité/refus anonymes et exerce une session temporaire HTTP/WS puis la révoque. Une unité `disable` ou une publication non approuvée est signalée `required:false` ; une unité activée mais indisponible échoue. `stop` seul ne désactive pas cette exigence.

Plus tard seulement, une adresse stable est possible avec `mode: "named"`, un hostname autorisé, `tunnelId` et `credentialsFile` privé (0600). Aucun domaine acheté ou DNS modifié ici.
