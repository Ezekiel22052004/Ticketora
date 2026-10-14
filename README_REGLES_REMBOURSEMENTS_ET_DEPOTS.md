# Ticketora — règles annulation, remboursement et portefeuille

Cette version ajoute une première intégration serveur des règles décidées pour les annulations et dépôts. Elle conserve les écrans et ressources existants autant que possible.

## Règles implémentées côté serveur

- Annulation globale par l'organisateur; dans les dernières 24 h, une autorisation temporaire de 30 minutes de l'administrateur est nécessaire et l'organisateur effectue lui-même l'annulation.
- Avant l'annulation définitive, le serveur vérifie les fonds disponibles et exige, pour chaque commande payée, le numéro et l'opérateur d'origine reconnus par Tchin.
- À l'annulation globale, les billets sont invalidés immédiatement et le remboursement préparé porte sur le prix du billet, hors frais de service de 5 %.
- Annulation volontaire d'un billet par son code QR/code + e-mail + téléphone de paiement: remboursement prévu de 90 % du montant affecté au billet; les 10 % retenus sont affectés d'abord aux frais de décaissement Tchin effectivement retournés par l'API, puis au solde administrateur.
- Un transfert n'est marqué payé qu'après confirmation Tchin. Un jeton existant est vérifié avant toute nouvelle tentative.
- Dépôt du portefeuille organisateur via Tchin avec `fees_on_customer: true`: le montant du dépôt est celui crédité, tandis que le frais côté client est en sus. Le crédit n'est écrit qu'après confirmation du statut du paiement et il est idempotent.
- Le compte administrateur expose un endpoint de comptabilité des retenues de remboursements.
- Le QR code peut être scanné depuis la page `annuler-billet.html` sur les navigateurs prenant en charge `BarcodeDetector`; la saisie manuelle reste possible.

## Routes ajoutées/étendues

- `POST /api/tickets/cancellation-request`
- `GET /api/organizer/wallet`
- `POST /api/organizer/wallet/deposits`
- `GET /api/organizer/wallet/deposits/:token/status`
- `GET /api/admin/refund-accounting`
- `GET /api/organizers/events/:id/refunds` et `GET /api/admin/events/:id/refunds`

## Configuration et limites à tester avant production

- Il faut une base PostgreSQL accessible et les clés Tchin valides (`TCHIN_PUBLIC_KEY`, `TCHIN_PRIVATE_KEY`, `TCHIN_ENV`), avec les opérateurs de paiement réellement renvoyés par Tchin dans `payment_operator`.
- Les dépôts sont crédités lors de la consultation du statut de dépôt. Il faut vérifier la livraison du webhook Tchin dans l'environnement de production et tester les dépôts en bout en bout.
- Le traitement automatique de remboursement dépend des réponses réelles de `/disburse/initiate`, `/disburse/submit` et `/disburse/status`. Le serveur est conservateur si l'opérateur d'origine manque ou si le statut reste incertain.
- Le code est syntaxiquement vérifié avec `node --check`. Aucun paiement réel ni base de production n'a été testé dans cet environnement; ce ZIP ne constitue pas une confirmation de déploiement en ligne.
- Les notifications par e-mail ne sont pas envoyées automatiquement par cette modification; l'organisateur/l'administrateur conserve la responsabilité d'informer les clients selon la règle décidée.
