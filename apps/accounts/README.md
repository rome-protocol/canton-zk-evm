# Accounts service

A Canton account that a person holds with a key of their own, made and used from a web page. The account is an external party: its Ed25519 key is made by its owner (the page derives it from one wallet signature), the party is hosted on the operator's participant, and only that key can sign for it. This service sits between the page and the participant's JSON Ledger API (Canton 3.7). It holds a Ledger API token and never a key of any account. One Python file, standard library only; the tests (`unittest`, which `pytest` collects too) run against a fake Ledger API, and one test runs against the real, pinned Canton.

```
LEDGER_TOKEN=<token> accounts.py --ledger-url http://participant:7575 --user-id <ledger user of the token> --state-file accounts.jsonl [--listen 127.0.0.1:8081]
```

The token comes from `LEDGER_TOKEN` or `--token-file` (read again for each call, so a rotated token is picked up), never from an argument. `--user-id` is the Ledger API user of that token. The public endpoint must run behind a reverse proxy; the service limits each client itself (below), and `--client-ip-header X-Forwarded-For` makes it take the client's address from that header (the last entry, the one the proxy wrote) instead of the proxy's.

## Endpoints

Every answer is JSON; an error is `{"error": "..."}` with 400 (a bad request), 403 (a command that is not on the list), 404 (no such account, topology or prepared transaction), 422 (the participant refused it: `code` and `detail` carry its answer), 429 (a limit, with `Retry-After`), 502 (the participant could not be reached, or refused the service's own login; no detail is given) or 500. Binary values are base64.

| Endpoint | Request | Answer |
|---|---|---|
| `POST /accounts/v1/topology` | `{"publicKey", "partyHint"?}`: the Ed25519 key, as 32 raw bytes or in DER (SubjectPublicKeyInfo, 44 bytes). The hint is optional and must be the service's own (`bridge`) | `{"party", "exists": false, "multiHash", "blob"}`: sign the bytes that `multiHash` stands for (decode the base64) and send the signature with the blob. If this key has an account already: `{"party", "exists": true}` |
| `POST /accounts/v1/allocate` | `{"blob", "signature"}`: the signature (64 bytes) over the multi-hash | `{"party", "created"}`. The blob is the service's own: it names what the service generated, and it lives ten minutes in memory |
| `POST /accounts/v1/prepare` | `{"party", "commands", "disclosedContracts"?}` | `{"party", "preparedTransaction", "preparedTransactionHash", "hashingSchemeVersion"}`: sign the bytes of the hash |
| `POST /accounts/v1/execute` | `{"preparedTransaction", "partySignatures": [{"party", "signature"}]}` | `{"updateId"}`, after the participant committed it |
| `GET /accounts/v1/holdings/{party}` | | `{"party", "holdings": [{"contractId", "instrumentId": {"admin", "id"}, "amount", "locked"}]}`: the CIP-0056 `Holding` interface's view of the party's active contracts, all pages of one snapshot |
| `GET /healthz` | | `{"ok", "accounts"}`; `ok` is false when the participant does not answer |

The party id is `bridge::<fingerprint of the key>`, so the same key is always the same account and `allocate` for it twice makes nothing the second time. The service answers for the accounts it allocated only (it keeps them in `--state-file`, one JSON line each, so keep that file): `prepare`, `execute` and `holdings` for another party are 404.

**What an account may sign.** `prepare` takes one command, a `CreateCommand` or an `ExerciseCommand` (not `CreateAndExercise` or by key), and only if it is on the list. An entry is `#package:Module:Entity` (a create of that template) or `#package:Module:Entity#Choice` (an exercise of that choice, on a template or an interface). The package is named, never its id, so a command cannot step round the list by its package id. The built-in list is the chain package's `WithdrawalAcceptance` and `DepositRequest` creates, and the token standard's `AllocationFactory_Allocate`, `TransferFactory_Transfer` and `TransferInstruction_Accept`. `--allow` (repeat it) replaces the list, for example to add the twin package's acceptance and redeem request. `execute` runs only a transaction that this service prepared for that party in the last ten minutes (it keeps the hash of what it prepared, in memory), so the list holds for execute too: a client cannot prepare elsewhere and send the result here. Because that memory is the service's, run one copy.

## What the service's user needs

The participant user of the token (`--user-id`) holds **no right of its own**. `allocate` passes the user id to the participant's external-party allocation, which gives that user `CanActAs` for the new party in the same call; the endpoint accepts the user's own token for that (the authenticated user may name itself), so the service needs no `ParticipantAdmin` and no `IdentityProviderAdmin`, and cannot grant itself or anyone else anything. `CanActAs` for the party implies reading as it and executing as it, which is all `prepare` (reads as the party), `execute` (acts or executes as the party) and `holdings` (reads as the party) ask for. It does not let the service act for an external party without that party's signature: the participant holds no key of the party. The integration test checks that the user ends with a right on the new party and no other right.

One limit follows: a participant caps the rights of one user (`max-rights-per-user`, 1000 by default), and each account adds one. Raise it in the participant's configuration to the number of accounts wanted, or the 1001st allocation is refused (422).

## Limits

Per client address: `--accounts-per-day` (3) allocations that make an account in 24 hours, and `--requests-per-minute` (60) requests of any kind. A body is at most 512 KiB. The service makes no account from a key that is not signed for: the participant checks the signature over the topology, and a refused one leaves nothing. Both limits are in memory.

## The protocol version

The topology transactions are those of the synchronizer's own protocol version, unless `--topology-protocol-version N` asks for those of an older one (the participant's `generate-topology` takes `protocolVersion`; on a synchronizer of version 37, 36 is admitted). The service passes the transactions to `allocate` as they are, so it works on a synchronizer of version 36 and of 37; the integration test runs on the one `PINS` names. `--synchronizer-id` names the synchronizer to make accounts on; by default it is the one the participant is connected to (and it is an error if there are several).

## Tests

```
python3 -m unittest discover -s apps/accounts/tests -p 'test_*.py' -v     # a fake Ledger API
apps/accounts/tests/integration.sh                                        # the pinned Canton; needs Java 21 and openssl 3
```

The second starts Canton as `tests/canton_external.sh` does, sets Ostia's chain up on it, makes a Ledger API user with no right, and runs the service with that user's token. `integration.py` makes an Ed25519 key with `openssl` (the repo has no crypto library, and the service needs none: it never signs), allocates an external party from it, prepares and signs the creation of a `WithdrawalAcceptance` of the chain package, executes it, reads the contract back as an observer, and lists the holdings. CI runs both in [`accounts.yml`](../../.github/workflows/accounts.yml).
