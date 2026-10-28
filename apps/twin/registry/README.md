# Twin registry service

The off-ledger registry API of the token standard (CIP-0056, V1) for the Canton twins of ERC-20 tokens (`apps/twin`), and the parts of lock ids. One Python file, standard library only; the tests (`unittest`) run against a fake ledger and a fake Ostia.

It reads Canton through the JSON Ledger API with a read token and reads Ostia through its JSON-RPC. It holds no key of any party and writes nothing to Canton. On the Canton side it is trusted for nothing: what it serves is checked on the ledger by the choice that uses it (the twin's factories check the admin, the instrument and the amounts; `Advance` checks every lock leg against the block), and a wrong answer makes a command fail. The EVM payer is different: it pays the lock id and the vault that this service hands back, so a payer must check them (see "What a payer checks"). The Ledger API user of the read token has `CanReadAs` on the gateway party and nothing else, no `ActAs` (as in `explorer/README.md`). The public endpoint runs behind a reverse proxy with per-client rate limits; the service has no login of its own.

```
LEDGER_TOKEN=<read token> registry.py --ledger-url http://participant:7575 --admin <gateway party> \
    --ostia-rpc http://ostia:8545 --chain-id <chain id> --state-file parts.jsonl [--listen 127.0.0.1:8080]
```

The token is read from `LEDGER_TOKEN` or `--token-file`, never from an argument. It must let the service read as the admin party (the gateway party): the `TwinRules` contracts have the admin as their only stakeholder, and the chain record (`ZkChain`) names the vaults and pins the twins. `--chain-id` selects the chain: exactly one active `ZkChain` of that chain id with this gateway must exist, otherwise the service answers 500 and `/healthz` says `ok: false`, so the vaults of two chains are never mixed. The twins served are those the chain record pins (`ZkChain.twins`: token, decimals and the `TwinRules` contract), because `LockLeg` and `ReleaseLeg` accept only the pinned rules: the service serves exactly the pinned rules contract with its disclosed blob, and no token that has no pin. A pin whose rules are not active serves nothing and sets `ok: false`; active rules that no pin names are listed in `/healthz` as `unpinnedRules` and are not served. This needs the chain record of the twin pins (`assets-twin-pins`).

## Endpoints

The shapes are those of the token standard's OpenAPI files (`splice-api-token-metadata-v1` 1.2.0, `transfer-instruction-v1` 1.1.0, `allocation-instruction-v1`, `allocation-v1`). Errors are `{"error": "..."}` with 400, 404, 500 or 503 (503: the store of lock id parts is full); a ledger or Ostia failure is a 500 with no detail.

| Endpoint | Answer |
|---|---|
| `GET /registry/metadata/v1/info` | `adminId` and `supportedApis` |
| `GET /registry/metadata/v1/instruments?pageSize&pageToken` | the twins as instruments (`nextPageToken` while more follow) |
| `GET /registry/metadata/v1/instruments/{instrumentId}` | one twin: `id` (`erc20:<token address>`), `name`, `symbol`, `decimals` (10, the twin's), `totalSupply` and `totalSupplyAsOf`, `supportedApis` |
| `POST /registry/transfer-instruction/v1/transfer-factory` | the transfer factory (the twin's `TwinRules` contract) with its choice context and the rules as a disclosed contract; `transferKind` is `direct`, or `self` when sender and receiver are one party |
| `POST /registry/transfer-instruction/v1/{id}/choice-contexts/{accept,reject,withdraw}` | always 404: a twin transfer completes at once, so there is no transfer instruction |
| `POST /registry/allocation-instruction/v1/allocation-factory` | the allocation factory (the same `TwinRules` contract) with its choice context and disclosed rules |
| `POST /registry/allocations/v1/{id}/choice-contexts/{execute-transfer,withdraw,cancel}` | an empty choice context and no disclosed contracts: the twin's allocation choices read nothing from a registry |
| `POST /twin/v1/lock-parts` | an EVM payer about to pay a lock sends `{"receiver": <Canton party id>, "ref": <text>}` and gets `{"lockId", "receiver", "ref", "vaults"}`: the id to pay against (the SHA-256, in lowercase hex, of `lock,<receiver>,<ref>`, as `lockId` in `daml/src/Zk/Chain.daml` makes it) and the registered vaults that take the lock |
| `GET /twin/v1/lock-parts/{lockId}` | the builder's read: `{"lockId", "receiver", "ref"}`, or 404. The builder gets the rest of a `LockLeg` from the block's payment line (vault, token, amount) and from `GET /twin/v1/twins` (the rules contract of the token) |
| `GET /twin/v1/twins` | each twin: token, instrument id, name, symbol, ERC-20 decimals, rules contract id; and the registered vaults |
| `GET /healthz` | `ok` is false while a pinned twin has no active rules or the chain record is not exactly one; also `twins`, `pinnedWithoutRules`, `unpinnedRules`, `vaults` |

The factory requests take the choice arguments as the Daml JSON API encodes them (`choiceArguments`); the service reads only `expectedAdmin` and the instrument id, and refuses another admin (400) or an unknown instrument (404). It sends no debug fields.

**Total supply** is what the registered vaults hold of the token, read as `balanceOf(vault)` on Ostia and shown as a twin amount (10 decimal places, rounded down). The vaults are the `Vault` entries of the chain's registry (`ZkChain.contracts`). When Ostia does not answer, the field is left out. The explorer compares it with the twin's holdings.

**Lock id parts.** The gateway records only the id of a payment, and a hash cannot be read back, so the payer announces the parts before it pays, and the builder reads them to attach the `LockLeg`. Both fields are non-empty text of at most 256 bytes; the receiver must be a party id: a name, `::`, then `1220` and 64 lowercase hex digits, with no space and no comma. A request may also carry `token` (40 lowercase hex digits); a token with no pinned twin is then refused with 404. Without it the answer lists the vaults for any token. The parts are appended to `--state-file` (flushed to disk on every line, required), so a restart loses none; a truncated last line or a line whose id is not the hash of its parts is dropped with a message when the file loads, and the file is compacted then. An entry expires `--lock-parts-ttl-days` (14) after its announcement and is dropped from memory and file; a payer announces the same parts again and gets the same id, and a payment whose parts are missing waits in the pool until then. The service keeps at most `--max-lock-parts` (200,000) live entries, then refuses new ones with 503 until some expire. An announced id that nobody pays costs a line and nothing else. A payer who announces the wrong receiver pays an id that mints to that receiver, as with any wrong address; `Advance` checks that the parts give the recorded id.

## What a payer checks

The service is a hint for the EVM payer, not an authority. A wallet that pays a lock does this itself and refuses to pay when it differs:

- It computes `lockId` as the lowercase hex of `sha256("lock,<receiver>,<ref>")` and compares it with the answer of `POST /twin/v1/lock-parts`. The `lock,` tag keeps the id apart from the ids of `DvpTerms` and venues, so no answer from the service can send the payment anywhere else: a wrong vault leaves the payment waiting in the pool.
- It takes the vault addresses from a source it already trusts (the chain record or its own configuration). The served list is a hint only.

## Tests

```
python3 -m unittest discover -s apps/twin/registry/tests -v
```

CI runs them in [`registry.yml`](../../../.github/workflows/registry.yml).
