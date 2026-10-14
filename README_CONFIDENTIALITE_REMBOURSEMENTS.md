# Ticketora — pages légales et base de remboursement

Pages ajoutées : politique de confidentialité, CGU, conditions de vente, politique de remboursement et mentions légales.

Le schéma inclut `ticket_refunds` avec une contrainte UNIQUE sur `order_id`, des références fournisseur uniques et le numéro d’origine enregistré pour empêcher les doublons dans le registre.

Important : la base actuelle stocke `orders.tchin_mode` comme mode/environnement renvoyé par le prestataire, pas de manière fiable comme opérateur Mobile Money de destination. L’envoi réel d’un remboursement ne doit donc pas être activé tant que le mode/opérateur de paiement d’origine n’est pas récupéré et vérifié depuis Tchin. Une tentative incertaine doit être vérifiée auprès du prestataire avant toute nouvelle soumission.

L’exploitant légal, l’adresse, les contacts, les lieux d’hébergement effectifs et les délais précis de conservation restent à vérifier et compléter avant publication.
