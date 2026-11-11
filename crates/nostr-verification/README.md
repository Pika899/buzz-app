# Native Nostr signature verification

The desktop's `relay_verify_signatures` command calls this crate on its existing
blocking worker. The input and result remain one signature claim and one boolean
per event, in order. JavaScript still validates each event and recomputes its
NIP-01 content hash before sending a claim; this crate cannot establish that an
event ID matches an event body.

## Batch selection and correctness

Chunks contain at most 512 claims. A chunk uses cryptographic batch verification
when it contains at least 12 claims and no more than one distinct author per
eight claims. Otherwise it retains individual libsecp256k1 checks. These are
performance thresholds, not security assumptions: both paths must reject invalid
claims. The threshold comes from local Apple Silicon measurements and should be
remeasured on other supported architectures before claiming a speedup there.

The batch path follows [BIP-340's batch verification algorithm](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki#batch-verification).
It hashes every public key, message (the 32-byte event ID), and signature into a
ChaCha20 seed. The first coefficient is one; later coefficients are sampled by
rejection from the nonzero scalars below the curve order. This binds the weights
to the entire batch, including its signatures. Fixed weights would let crafted
invalid signatures cancel each other's errors.

RustCrypto `k256` 0.14.0 performs point/scalar decoding and the variable-time
multi-scalar multiplication. Each nonce point and public key is lifted to the
unique even-Y curve point, and each signature scalar must be below the group
order. Terms for the same public key are combined. All arithmetic inputs are
public; no signing or secret-key operation uses this path. This small batching
layer and k256's newer variable-time multiplication are not claimed to be covered
by k256's historical audit.

A successful batch accepts its signatures with BIP-340's negligible probability
of accepting an invalid batch. If decoding or the batch equation fails, every
claim in that chunk is checked individually with libsecp256k1. This preserves
valid neighbors and the existing rejection behavior. There is no recursive retry,
new queue, timer, or persistent key/proof cache. Invalid batches cost more work
than the original loop; the chunk cap bounds each fallback's work and scratch
space, not the size of the existing IPC request.

## Validation and benchmark

From the repository root, with Hermit activated:

```sh
cargo test -p buzz-nostr-verification --locked
cargo bench -p buzz-nostr-verification --bench verify --locked
```

Tests cover the official 15 BIP-340 vectors with 32-byte messages, native-verifier
equivalence, mixed authors, every invalid position in a batch, malformed input,
duplicates, chunk boundaries, and cancelling signature errors. The Tauri command
test exercises both a successful batch and failed-batch fallback through the real
async command. Existing frontend tests own event-body hashing, proof-cache
validation, and delivery ordering.

The CSV fixture is the upstream `bitcoin/bips` file
`bip-0340/test-vectors.csv`, retrieved November 11, 2026, under its CC0-1.0 option.
Upstream SHA-256: `34c9d1d9c3a88d524bc80778540dc43f8306ec249a7485293063c376db851c2d`.
The vendored copy normalizes line endings to LF.
Its later variable-message-length vectors do not apply to Nostr's 32-byte IDs.

The benchmark compares the production function with the previous desktop loop,
including its `nostr::EventId` parser, signature/public-key parsing, context
creation, and ordered result allocation. Setup/signing is outside the timer.
Each case warms both paths four times, then alternates their order over seven
rounds, with at least 16 calls and approximately 4,096 signatures per round.
Standard output contains medians in microseconds per call and the old/new time
ratio; standard error records every sample. Ratios above one mean a speedup.

The cases include isolated events, repeated and distinct authors, both sides of
the selection threshold, and one or many invalid signatures. These measurements
exclude JSON, Tauri IPC, event-body hashing, network latency, and rendering. They
measure native verification, not channel-load or app responsiveness.

## Local results, November 11, 2026

Apple M4 Max, arm64, macOS 26.7.2, Rust 1.98.1, Cargo release defaults. The
measured checkout was based on `b9c2edbb74d5daf2f4642d0b56d975645ed1ac5c`.
No other task-owned tests or builds ran during measurement. Medians per call:

| Signatures | Authors | Previous loop | Adaptive verifier | Speedup |
| ---: | ---: | ---: | ---: | ---: |
| 12 | 1 | 181.5 µs | 145.7 µs | 1.25× |
| 32 | 4 | 481.5 µs | 381.0 µs | 1.26× |
| 128 | 4 | 1,996.0 µs | 1,423.6 µs | 1.40× |
| 512 | 4 | 8,203.6 µs | 5,847.8 µs | 1.40× |
| 512 | 64 (batch cutoff) | 8,091.5 µs | 6,444.4 µs | 1.26× |
| 512 | 512 (individual path) | 8,129.2 µs | 8,197.5 µs | 0.99× |

The repeated-author cases save approximately 20–29% of native verification time.
Invalid-signature batches take approximately 1.7–1.8× the previous time because
they perform both the batch attempt and individual fallback. For example, 512
same-author claims with one invalid signature take 14.03 ms versus 8.10 ms.
Isolated and diverse-author cases remain within about 1% of the original loop.

The [complete medians](measurements/m4-max-2026-11-11.csv) and
[individual samples](measurements/m4-max-2026-11-11-samples.csv) include threshold
boundaries and invalid traffic. Measured source SHA-256 values:

- `src/lib.rs`: `cedcd8b7d410f9df6d6b5e7574da1764a63c91ac1ffc8509db0582ff32a2f01a`
- `benches/verify.rs`: `decaf1516daa4f799b14516c5c02fd57e1c41dbf61badb404b30cb13834f9a6c`

All seven crypto tests, the focused native command test, and 285 frontend
transport tests passed. Native/package Clippy and formatting checks passed.
Negative controls replacing coefficients with ones or omitting signatures from
the coefficient seed each make the corresponding forgery test fail. The full desktop suite did not pass: its
`host_command::tests::stdin_is_exact_data_and_output_is_drained_concurrently`
test failed, and it later received SIGSEGV in the macOS
`window_state::tests::onboarding_snapshot_is_kept_until_next_launch_restore`
test (`MockRuntime` passed a dummy view to `ns_window`). Those tests were not
changed. No live desktop UI timing or other-architecture measurement was run.
