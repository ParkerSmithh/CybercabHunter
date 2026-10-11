-- Daily's date range otherwise reads baseline roster rows that can never count
-- as additions. This additive index leaves all source records untouched.
CREATE INDEX idx_dmv_daily_new_date_model
  ON dmv_av_vehicles(first_seen_date, lower(model)) WHERE in_baseline = 0;
