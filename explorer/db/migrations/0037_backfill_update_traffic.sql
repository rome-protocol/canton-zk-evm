-- The traffic (and the completion offset) of a block's update, from the producer's journal. Until now the join copied them to canton_updates together with the
-- command, and an update whose attempt had no answered line read yet got the command with no traffic and never the traffic after (the mixed load on DevNet found
-- 209 of 225 blocks so). The indexer now copies them when the answered line is read; this fills in the rows that were missed. Only nulls are filled.
update canton_updates u
   set traffic_bytes = coalesce(u.traffic_bytes, a.traffic_bytes), completion_offset = coalesce(u.completion_offset, a.completion_offset)
  from block_attempts a
 where a.update_id = u.update_id and u.command_id is not null
   and (a.outcome = 'committed' or a.resolved_outcome = 'committed')
   and (u.traffic_bytes is null and a.traffic_bytes is not null or u.completion_offset is null and a.completion_offset is not null);
