-- A verified source belongs to the code at an address, not to the address: a contract made again at the same address with other code (CREATE2 after a
-- self-destruct) is verified on its own, and the source of the code that stood there before stays with that code.
alter table verified_sources drop constraint verified_sources_address_key;
create unique index verified_sources_address_code_key on verified_sources (address, runtime_code_hash);
