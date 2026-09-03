# Ticketora — version fonctionnelle

Cette version conserve les pages HTML/CSS du projet et remplace les simulations localStorage/FedaPay par une API Express + PostgreSQL/Neon + Tchin.

## Local
1. Copier `.env.example` vers `.env`.
2. Renseigner `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET` et les clés Tchin de test.
3. Dans Neon, exécuter `db.sql`.
4. `npm install` puis `npm start`.
5. Ouvrir `http://localhost:3000`.

## Production
- Frontend : Netlify (`ticketora.netlify.app`)
- Backend : Render
- Base : Neon
- Tchin : clés uniquement côté Render.
- `TCHIN_CALLBACK_URL` doit être une URL HTTPS publique Render `/api/webhooks/tchin`.
- `TCHIN_RETURN_URL` reste l’URL Netlify.
- `FRONTEND_URL=https://ticketora.netlify.app`.
- `config.js` doit contenir l’URL publique Render, par exemple `window.TICKETORA_API_URL="https://...onrender.com";`.

## Sécurité paiement
Le billet n’est créé qu’après confirmation `completed` côté serveur et validation de la signature webhook, du montant, du token et du mode. Un retour navigateur `success` seul ne crée jamais de billet.

## Important
Les clés Tchin précédemment communiquées doivent être régénérées avant la production. Ne jamais mettre la clé privée dans le frontend, GitHub ou Netlify.

## Gestion des retraits
- Les organisateurs peuvent demander un retrait depuis leur espace.
- L'administrateur voit les demandes dans **Paiements & Retraits** et peut **Valider**, **Refuser** ou **Marquer payé**.
- L'administrateur dispose aussi d'un espace **Mon retrait administrateur** basé sur les commissions Ticketora enregistrées.
- La table `admin_payouts` est créée automatiquement au démarrage si elle n'existe pas.
