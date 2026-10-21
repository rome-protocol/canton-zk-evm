-- The traffic the builder's participant used across Advance, as the journal's `answered` line says. It is kept on the attempt until the
-- reader's update for the same update id is in the index, and then copied to canton_updates.traffic_bytes (the loader joins the two).
alter table block_attempts add column traffic_bytes integer;
