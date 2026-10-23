-- A contract's Events page reads the logs it wrote, newest first, after a key (block, log index), and may keep one kind of event (topic0). The index of
-- (address, block_number) holds neither the log index nor the kind, so a page of a rare kind (Approval among millions of Transfer logs) filtered heap rows
-- all the way down to the key. These are the page's ORDER BY and keyset comparison exactly: one for every event of a contract, one for one kind.
create index logs_address_place_idx on logs (address, block_number desc, log_index desc);
create index logs_address_topic0_place_idx on logs (address, topic0, block_number desc, log_index desc);
