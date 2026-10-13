# Ticketora — corrections ciblées

Cette version utilise les fichiers fournis et conserve le HTML/CSS existant. Aucun code de génération graphique du ticket n'a été modifié.

## Changements ciblés

- Retrait de l’interface publique participant « Connexion », « Créer un compte », « Profil » et « Notifications ». Les accès administrateur et organisateur ne sont pas supprimés. « Mes billets » reste disponible via la recherche par les informations utilisées lors de l’achat.

- Retrait des liens publics « Administration » dans la page d'accueil et dans « Choisissez votre espace » ; l'interface `admin.html` et les protections serveur sont conservées.
- Conservation de « Glisser pour payer » ; ajout d'une garde contre un double déclenchement de l'action de glissement.
- Ajout d'un suivi visuel à cinq étapes dans les retours de paiement des tickets, LIVE et cagnottes. Les étapes finales ne sont affichées comme terminées qu'après confirmation retournée par l'API.
- Réservation temporaire des stocks de billets pour dix minutes, avec comptage transactionnel des réservations actives pendant la création d'une commande.
- Libération des réservations lorsqu'un statut réel Tchin indique un paiement échoué/annulé/expiré. Les réservations expirées ne sont plus comptées dans le stock disponible ; une confirmation tardive est revérifiée avant toute attribution pour éviter une double vente.
- Enregistrement de l'utilisateur connecté sur les commandes et paiements LIVE, et vérification de l'accès LIVE durable en base pour le compte associé au paiement.
- Ajout d'API de modification du profil et de lecture/gestion des notifications participant.
- Amélioration de « Mes tickets » après connexion : informations de l'événement, statut, QR code, téléchargement PDF, profil et notifications.
- Ajout de notifications persistantes pour la confirmation d'un ticket, d'un accès LIVE et d'une contribution de cagnotte lorsque la confirmation serveur est traitée.
- Correction du montant minimum affiché pour les cagnottes : 200 FCFA, aligné sur l'API existante.
- Les inscriptions gratuites n'affichent plus le libellé « Paiement confirmé ».

## Fichiers modifiés

- `server.js`
- `app.js`
- `index.html`
- `schema.sql`

Les autres fichiers transmis sont conservés sans modification.

## Vérifications effectuées

- `node --check server.js` : réussi.
- `node --check app.js` : réussi.
- `node --check admin.js` : réussi.
- Comparaison du code `buildTicketImage` avant/après : le code de rendu des tickets est inchangé.

## À savoir avant déploiement

- Les tests d'intégration nécessitent la base PostgreSQL, les variables d'environnement et un compte Tchin de test ; ils n'ont pas pu être exécutés ici.
- Aucun endpoint de remboursement Tchin documenté ni aucune clé de remboursement n'étaient présents dans les fichiers fournis. En cas de paiement confirmé après épuisement du stock, le code empêche une double attribution et signale qu'une intervention est nécessaire ; le remboursement devra être réalisé via une API de remboursement officiellement prise en charge par Tchin.
- Les images et ressources qui n'étaient pas jointes à la conversation (notamment `logo.png`, `ticket-template.png`, `ticket-template-vip.png`, `ticket-template-vvip.png`, les icônes et `manifest.json`) ne sont pas recréées ni modifiées. Recopiez les originaux dans le même dossier que `server.js` et `index.html` avant le lancement.
- Gardez votre fichier `.env` réel hors du ZIP. Configurez les variables secrètes sur votre environnement de déploiement.

## Lancement local

Depuis ce dossier, avec Node.js 20+ et une base PostgreSQL configurée :

```bash
npm install
npm start
```

Le serveur charge `.env` depuis le même dossier que `server.js`. Les migrations idempotentes des tables de réservations, notifications et accès LIVE sont également lancées au démarrage.
