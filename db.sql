CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizers (
  id BIGSERIAL PRIMARY KEY,
  nom VARCHAR(180) NOT NULL,
  prenom VARCHAR(180) DEFAULT '',
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(60) DEFAULT '',
  password_hash TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK (status IN ('EN_ATTENTE','VALIDE','REFUSE','SUSPENDU')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT REFERENCES organizers(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'Concert',
  date DATE NOT NULL,
  location VARCHAR(255) NOT NULL DEFAULT '',
  venue_name VARCHAR(255) NOT NULL DEFAULT '',
  city VARCHAR(120) NOT NULL DEFAULT '',
  address VARCHAR(500) NOT NULL DEFAULT '',
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  description TEXT DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  capacity INTEGER NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK (status IN ('BROUILLON','EN_ATTENTE','PUBLIE','REFUSE')),
  ticket_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_tickets_per_order INTEGER NOT NULL DEFAULT 10 CHECK (max_tickets_per_order > 0),
  image_url TEXT,
  event_type VARCHAR(10) NOT NULL DEFAULT 'PAID',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  reference VARCHAR(40) NOT NULL UNIQUE,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  ticket_type VARCHAR(120) NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(60) DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  base_amount INTEGER NOT NULL CHECK (base_amount >= 0),
  discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
  promo_code VARCHAR(60) DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','FAILED','CANCELLED')),
  tchin_token VARCHAR(255) UNIQUE,
  tchin_reference VARCHAR(255),
  tchin_mode VARCHAR(20),
  tchin_status VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  code VARCHAR(32) NOT NULL UNIQUE,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  org_id BIGINT REFERENCES organizers(id) ON DELETE SET NULL,
  event_title VARCHAR(255) NOT NULL,
  event_date DATE NOT NULL,
  event_location VARCHAR(255) NOT NULL,
  ticket_type VARCHAR(120) NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(60) DEFAULT '',
  total_amount INTEGER NOT NULL,
  admin_commission INTEGER NOT NULL,
  organizer_amount INTEGER NOT NULL,
  commission_rate NUMERIC(5,2) NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  scan_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payouts (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  account VARCHAR(120) NOT NULL,
  withdraw_mode VARCHAR(80),
  status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK (status IN ('EN_ATTENTE','VALIDE','REFUSE','PAYE')),
  tchin_disburse_token VARCHAR(255),
  tchin_transaction_id VARCHAR(255),
  tchin_status VARCHAR(30),
  tchin_fee INTEGER,
  tchin_debited INTEGER,
  tchin_error TEXT,
  tchin_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_type VARCHAR(30) NOT NULL,
  actor_id VARCHAR(100),
  action VARCHAR(120) NOT NULL,
  entity_type VARCHAR(80),
  entity_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_status_date ON events(status, date);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id);

CREATE TABLE IF NOT EXISTS event_likes (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  visitor_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(event_id, visitor_key)
);
CREATE INDEX IF NOT EXISTS idx_event_likes_event ON event_likes(event_id);
CREATE INDEX IF NOT EXISTS idx_event_likes_visitor ON event_likes(visitor_key);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_tchin_token ON orders(tchin_token);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_org ON tickets(org_id);
CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(code);
CREATE INDEX IF NOT EXISTS idx_payouts_org ON payouts(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_tchin_disburse_token ON payouts(tchin_disburse_token) WHERE tchin_disburse_token IS NOT NULL;


CREATE TABLE IF NOT EXISTS admin_payouts (
  id BIGSERIAL PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount > 0),
  account VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK (status IN ('EN_ATTENTE','PAYE','REFUSE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_payouts_status ON admin_payouts(status);

ALTER TABLE events ADD COLUMN IF NOT EXISTS image_url TEXT;


CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  organizer_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  sender_role VARCHAR(20) NOT NULL CHECK(sender_role IN ('ADMIN','ORGANIZER')),
  message TEXT NOT NULL CHECK(length(trim(message)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_org ON chat_messages(organizer_id,id);


CREATE TABLE IF NOT EXISTS scanner_agents (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  agent_number VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(180) NOT NULL DEFAULT 'Agent scanner',
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_scanner_agents_org ON scanner_agents(org_id);

CREATE TABLE IF NOT EXISTS cagnottes (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'BROUILLON' CHECK(status IN ('BROUILLON','PUBLIE','TERMINE')),
  target_amount INTEGER,
  total_amount INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  launched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cagnottes_status ON cagnottes(status);

CREATE TABLE IF NOT EXISTS contributions (
  id BIGSERIAL PRIMARY KEY,
  cagnotte_id BIGINT NOT NULL REFERENCES cagnottes(id) ON DELETE CASCADE,
  contributor_name VARCHAR(255),
  contributor_email VARCHAR(255),
  amount INTEGER NOT NULL CHECK(amount >= 100),
  status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK(status IN ('EN_ATTENTE','PAYE','ANNULE')),
  reference VARCHAR(80) UNIQUE NOT NULL,
  tchin_token VARCHAR(255) UNIQUE,
  tchin_reference VARCHAR(255),
  tchin_status VARCHAR(30),
  tchin_mode VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_contributions_cagnotte ON contributions(cagnotte_id);
CREATE INDEX IF NOT EXISTS idx_contributions_tchin ON contributions(tchin_token);


-- CODES PROMO / REDUCTIONS
CREATE TABLE IF NOT EXISTS promo_codes (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
  code VARCHAR(60) NOT NULL,
  discount_type VARCHAR(20) NOT NULL CHECK(discount_type IN ('PERCENT','FIXED')),
  discount_value INTEGER NOT NULL CHECK(discount_value > 0),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0),
  max_uses_per_customer INTEGER NOT NULL DEFAULT 1 CHECK(max_uses_per_customer > 0),
  min_amount INTEGER NOT NULL DEFAULT 0 CHECK(min_amount >= 0),
  allowed_ticket_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, code)
);
CREATE TABLE IF NOT EXISTS promo_usages (
  id BIGSERIAL PRIMARY KEY,
  promo_id BIGINT NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  customer_email VARCHAR(255) NOT NULL,
  discount_amount INTEGER NOT NULL CHECK(discount_amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','USED','CANCELLED')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  UNIQUE(promo_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_promo_codes_org ON promo_codes(org_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_event ON promo_codes(event_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_usages_promo ON promo_usages(promo_id,status);
CREATE INDEX IF NOT EXISTS idx_promo_usages_customer ON promo_usages(promo_id,customer_email,status);

-- TICKETORA V3: comptes participants, suivi des scans, partenaires
CREATE TABLE IF NOT EXISTS participant_users (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone VARCHAR(60) DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES participant_users(id) ON DELETE SET NULL;
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES participant_users(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS issued_by_admin BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_contributions_user ON contributions(user_id);

CREATE TABLE IF NOT EXISTS event_partners (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  logo_url TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- V7 location migration (safe on existing Ticketora databases)
ALTER TABLE events ADD COLUMN IF NOT EXISTS venue_name VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS city VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS address VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7);
ALTER TABLE events ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);
