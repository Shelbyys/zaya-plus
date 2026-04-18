-- Tabela para dedup de promoções de passagens aéreas
-- Rodar no Supabase SQL Editor
CREATE TABLE IF NOT EXISTS promo_flights_seen (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  price INTEGER,
  price_text TEXT,
  pub_date TIMESTAMPTZ,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  sent_to_wa BOOLEAN DEFAULT FALSE,
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_promo_first_seen ON promo_flights_seen(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_promo_url_hash ON promo_flights_seen(url_hash);
