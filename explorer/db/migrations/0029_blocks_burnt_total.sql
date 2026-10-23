-- Etherscan's ethsupply is the genesis allocation minus every fee burnt up to the final head. Summing `burnt_fees` over the whole table costs more with every block,
-- so each block keeps the running total of the fees burnt up to and including it (`burnt_total`), and ethsupply reads one row. A trigger keeps the total right for
-- every writer: a new block adds its fees to the total of the block before it, a reindex that changes a block's fees (or a removed block) moves the total of each later block by the difference.
alter table blocks add column burnt_total numeric(78,0) not null default 0;

update blocks b set burnt_total = s.total
from (select number, sum(burnt_fees) over (order by number) as total from blocks) s
where b.number = s.number;

create function blocks_burnt_total_before() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.burnt_total := coalesce((select burnt_total from blocks where number < new.number order by number desc limit 1), 0) + new.burnt_fees;
  elsif new.burnt_fees <> old.burnt_fees then
    new.burnt_total := old.burnt_total + (new.burnt_fees - old.burnt_fees);
  end if;
  return new;
end $$;

create function blocks_burnt_total_after() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    -- A block written after later ones (nothing does today) moves their totals.
    update blocks set burnt_total = burnt_total + new.burnt_fees where number > new.number;
  elsif tg_op = 'UPDATE' then
    -- The block's own total moved in the BEFORE trigger. The later blocks move after the statement's own rows are done, so that a statement that changes many blocks adds up.
    update blocks set burnt_total = burnt_total + (new.burnt_fees - old.burnt_fees) where number > new.number;
  else
    update blocks set burnt_total = burnt_total - old.burnt_fees where number > old.number;
  end if;
  return null;
end $$;

create trigger blocks_burnt_total_before before insert or update of burnt_fees on blocks for each row execute function blocks_burnt_total_before();
create trigger blocks_burnt_total_after after insert or update of burnt_fees or delete on blocks for each row execute function blocks_burnt_total_after();
