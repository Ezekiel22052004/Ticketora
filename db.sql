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
  description TEXT DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  capacity INTEGER NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK (status IN ('BROUILLON','EN_ATTENTE','PUBLIE','REFUSE')),
  ticket_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_url TEXT,
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
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  code VARCHAR(32) NOT NULL UNIQUE,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  org_id BIGINT REFERENCES organizers(id) ON DELETE SET NULL,
  event_title VARCHAR(255) NOT NULL,
  event_date DATE NOT NULL,
  event_location VARCHAR(255) NOT NULL,
  ticket_type VARCHAR(120) NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
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
  status VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK (status IN ('EN_ATTENTE','VALIDE','REFUSE','PAYE')),
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
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_tchin_token ON orders(tchin_token);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_org ON tickets(org_id);
CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(code);
CREATE INDEX IF NOT EXISTS idx_payouts_org ON payouts(org_id);


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
