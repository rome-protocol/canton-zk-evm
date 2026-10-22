-- A derived balance is the sum of a holder's transfer legs, and the amounts are values that any token contract chooses (up to 2^256 - 1 each), so the sum
-- can pass 78 digits, and can be negative when a token lets an account send what it never received. The column takes any such sum instead of failing the
-- block's stage 2 or the reindex; the background check reads balanceOf for the row and puts the token in read mode when it disagrees. This keeps the
-- table's rows as they are (a wider numeric needs no rewrite).
alter table token_balances alter column value type numeric;
