# Token-standard packages

The Canton token standard (CIP-0056) API packages the Daml package builds against, and the reference token the tests run against. They are the files of the Splice 0.8.3 release, unchanged: the `splice-node/dars/` folder of `0.8.3_splice-node.tar.gz` at https://github.com/digital-asset/decentralized-canton-sync/releases/tag/v0.8.3. They are Apache-2.0, like Splice; the licence text is in [LICENSE-APACHE](LICENSE-APACHE). `SHA256SUMS` pins them, and CI checks it.

| File | Used for |
|---|---|
| `splice-api-token-metadata-v1-1.0.0.dar` | metadata and choice-context types |
| `splice-api-token-holding-v1-1.0.0.dar` | the `Holding` interface |
| `splice-api-token-allocation-v1-1.0.0.dar` | the `Allocation` interface, whose `Allocation_ExecuteTransfer` the terms execute |
| `splice-api-token-allocation-instruction-v1-1.0.0.dar` | the factory a wallet allocates through (tests only) |
| `splice-api-token-transfer-instruction-v1-1.0.0.dar` | the factory a withdrawal transfers through; the reference token needs it too |
| `splice-test-token-v1-1.0.1.dar` | the reference token (tests only) |

On 2026-10-03 every file here was compared, byte for byte, with the one in the release bundle (same SHA-256).
