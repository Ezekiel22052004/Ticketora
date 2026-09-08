# Ticketora V7 Professional

Base: Ticketora V6 Payment Fees Fix / Cagnotte Fix.

## Included in this increment
- Multi-ticket orders with quantity.
- Multiple unique QR tickets per order.
- Per-category max tickets per order.
- Stock/capacity checks at order creation and payment fulfillment.
- Customer WhatsApp/phone field stored with the order and ticket.
- Tchin customer fee remains separate from the ticket base amount.
- PWA manifest, service worker, icons and install prompt.

## Deployment note
Do not commit `.env` or production secrets. Run the DB migration through the server startup or apply `db.sql` to a new database.

Stability patch: public navigation restored, missing showSection restored, CSS leak fixed, role access links restored, CORS domains hardened, event detail view added, verified organizer indicator added, mobile dashboards improved.
