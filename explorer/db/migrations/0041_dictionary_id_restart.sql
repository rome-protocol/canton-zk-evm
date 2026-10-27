-- The four dictionary tables hold a few distinct values each, but their ids were spent on every block: the insert took the next id
-- before it found the row already there. An id column of type smallint ran out at 32,767 and stopped the indexer. The indexer now
-- looks a value up first, so an id is spent only on a new row. This puts each sequence back to just above the highest id in use, so a
-- database that already burned ids gets them back. It changes no row, can be run again, and works on an empty table.
select setval(pg_get_serial_sequence('canton_synchronizers', 'id'), coalesce((select max(id) from canton_synchronizers), 1), (select count(*) > 0 from canton_synchronizers));
select setval(pg_get_serial_sequence('canton_templates', 'id'), coalesce((select max(id) from canton_templates), 1), (select count(*) > 0 from canton_templates));
select setval(pg_get_serial_sequence('canton_parties', 'id'), coalesce((select max(id) from canton_parties), 1), (select count(*) > 0 from canton_parties));
select setval(pg_get_serial_sequence('canton_participants', 'id'), coalesce((select max(id) from canton_participants), 1), (select count(*) > 0 from canton_participants));
