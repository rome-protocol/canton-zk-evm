# Twin registry service

The off-ledger registry API of the token standard (CIP-0056, V1) for the Canton twins of ERC-20 tokens (`apps/twin`), and the parts of lock ids. One Python file, standard library only; the tests (`unittest`) run against a fake ledger and a fake Ostia.

It reads Canton through the JSON Ledger API with a read token and reads Ostia through its JSON-RPC. It holds no key of any party and writes nothing to Canton. It is trusted for nothing: what it serves is checked on the ledger by the choice that uses it (the twin's factories check the admin, the instrument and the amounts; `Advance` checks every lock leg against the block). A wrong answer makes a command fail; it cannot move a token.

```
LEDGER_TOKEN=<read token> registry.py --ledger-url http://participant:7575 --admin <gateway party> \
    --ostia-rpc http://ostia:8545 [--listen 127.0.0.1:8080] [--state-file parts.jsonl]
```

The token is read from `LEDGER_TOKEN` or `--token-file`, never from an argument. It must let the service read as the admin party (the gateway party): the `TwinRules` contracts have the admin as their only stakeholder, and the registry of EVM contracts (`ZkChain`) names the vaults. The service serves the `TwinRules` whose admin is `--admin`. If one token has more than one active `TwinRules`, none of that token is served (409), because a second one would convert with other decimals (`daml/README.md`, twin legs).

## Endpoints

The shapes are those of the token standard's OpenAPI files (`splice-api-token-metadata-v1` 1.2.0, `transfer-instruction-v1` 1.1.0, `allocation-instruction-v1`, `allocation-v1`). Errors are `{"error": "..."}` with 400, 404, 409 or 500; a ledger or Ostia failure is a 500 with no detail.

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
| `GET /healthz` | `ok` is false while a token has two active rules |

The factory requests take the choice arguments as the Daml JSON API encodes them (`choiceArguments`); the service reads only `expectedAdmin` and the instrument id, and refuses another admin (400) or an unknown instrument (404). It sends no debug fields.

**Total supply** is what the registered vaults hold of the token, read as `balanceOf(vault)` on Ostia and shown as a twin amount (10 decimal places, rounded down). The vaults are the `Vault` entries of the chain's registry (`ZkChain.contracts`). When Ostia does not answer, the field is left out. The explorer compares it with the twin's holdings.

**Lock id parts.** The gateway records only the id of a payment, and a hash cannot be read back, so the payer announces the parts before it pays, and the builder reads them to attach the `LockLeg`. Both fields are non-empty text of at most 256 bytes; the receiver must look like a party id (`name::fingerprint`). The parts are kept in memory and, with `--state-file`, appended to that file, so a restart loses none; the service keeps at most `--max-lock-parts` (200,000), then refuses new ones with 503. An announced id that nobody pays costs a line and nothing else. A payer who announces the wrong receiver pays an id that mints to that receiver, as with any wrong address; `Advance` checks that the parts give the recorded id.

## Tests

```
python3 -m unittest discover -s apps/twin/registry/tests -v
```

CI runs them in [`registry.yml`](../../../.github/workflows/registry.yml).
