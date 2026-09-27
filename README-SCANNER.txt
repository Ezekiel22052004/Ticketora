TICKETORA — ANIMATION PAIEMENT + CAGNOTTE + SCANNER

Contenu:
- index.html
- app.js
- server.js
- style.css
- scanner.html

Les 4 fichiers provenant du ZIP Animation Paiement-Cagnotte sont conservés tels quels.
scanner.html ajoute une interface Scanner complète compatible avec les routes backend:
- POST /api/scanners/login
- POST /api/scanners/logout
- GET /api/scanners/me
- GET /api/scanners/events
- GET /api/scanners/validated
- POST /api/scanners/scan

Animation:
- billet valide: animation orange -> cercle vert -> coche -> "Entrée autorisée"
- billet déjà utilisé/invalide: animation orange -> cercle rouge -> croix -> message d'erreur
- retour automatique au scanner après la validation.
