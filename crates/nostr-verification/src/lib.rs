//! Incoming BIP-340 signature checks. Callers must separately validate each
//! event's shape and compare its NIP-01 content hash with its claimed ID.
//! Batching uses the BIP-340 equation over RustCrypto's k256 arithmetic; small
//! or diverse batches and failed batches use individual libsecp256k1 checks.

use k256::{
    elliptic_curve::{
        ops::{LinearCombination, Reduce},
        point::DecompactPoint,
        PrimeField,
    },
    AffinePoint, FieldBytes, ProjectivePoint, Scalar,
};
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use secp256k1::{schnorr::Signature, Secp256k1, VerifyOnly, XOnlyPublicKey};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// A signature over an event ID, not evidence that the ID hashes the event.
#[derive(Clone, serde::Deserialize)]
pub struct SignatureClaim {
    /// Hex-encoded 32-byte NIP-01 event ID.
    pub id: String,
    /// Hex-encoded 32-byte BIP-340 x-only public key.
    pub pubkey: String,
    /// Hex-encoded 64-byte BIP-340 signature.
    pub sig: String,
}

// Bound MSM scratch space and failed-batch work without changing IPC limits.
const MAX_BATCH: usize = 512;
const MIN_BATCH: usize = 12;

/// Return one verdict per claim, preserving input order, including malformed
/// inputs. A successful batch has BIP-340's negligible false-accept probability;
/// a failed batch falls back once, without recursively retrying sub-batches.
pub fn verify(claims: &[SignatureClaim]) -> Vec<bool> {
    let secp = Secp256k1::verification_only();
    let mut results = Vec::with_capacity(claims.len());
    for chunk in claims.chunks(MAX_BATCH) {
        let valid_batch = should_batch(chunk)
            && chunk
                .iter()
                .map(Decoded::from_wire)
                .collect::<Option<Vec<_>>>()
                .is_some_and(|decoded| batch_valid(&decoded));
        if valid_batch {
            results.extend(std::iter::repeat_n(true, chunk.len()));
        } else {
            results.extend(chunk.iter().map(|claim| verify_one(&secp, claim)));
        }
    }
    results
}

fn should_batch(claims: &[SignatureClaim]) -> bool {
    if claims.len() < MIN_BATCH {
        return false;
    }
    // Native libsecp is faster for distinct authors. Only batch when merging
    // repeated-author terms removes most public-key multiplications.
    let mut authors = BTreeSet::new();
    for claim in claims {
        authors.insert(claim.pubkey.as_str());
        if authors.len() > claims.len() / 8 {
            return false;
        }
    }
    true
}

fn verify_one(secp: &Secp256k1<VerifyOnly>, claim: &SignatureClaim) -> bool {
    let (Some(id), Ok(pubkey), Ok(sig)) = (
        decode::<32>(&claim.id),
        claim.pubkey.parse::<XOnlyPublicKey>(),
        claim.sig.parse::<Signature>(),
    ) else {
        return false;
    };
    secp.verify_schnorr(&sig, &id, &pubkey).is_ok()
}

fn decode<const N: usize>(text: &str) -> Option<[u8; N]> {
    let mut bytes = [0; N];
    hex::decode_to_slice(text, &mut bytes).ok()?;
    Some(bytes)
}

struct Decoded {
    id: [u8; 32],
    pubkey: [u8; 32],
    sig: [u8; 64],
}

impl Decoded {
    fn from_wire(claim: &SignatureClaim) -> Option<Self> {
        Some(Self {
            id: decode(&claim.id)?,
            pubkey: decode(&claim.pubkey)?,
            sig: decode(&claim.sig)?,
        })
    }
}

fn batch_valid(claims: &[Decoded]) -> bool {
    // BIP-340 Batch Verification: seed a CSPRNG with a hash of ALL inputs.
    // All fields have fixed lengths, so this transcript is unambiguous. Binding
    // signatures too prevents adversaries from choosing cancelling errors after
    // learning the weights. Never replace these coefficients with fixed weights.
    let mut transcript = Sha256::new();
    for claim in claims {
        transcript.update(claim.pubkey);
    }
    for claim in claims {
        transcript.update(claim.id);
    }
    for claim in claims {
        transcript.update(claim.sig);
    }
    let mut rng = ChaCha20Rng::from_seed(transcript.finalize().into());
    let tag = Sha256::digest(b"BIP0340/challenge");
    let mut challenge = Sha256::new();
    challenge.update(tag);
    challenge.update(tag);
    let mut terms = Vec::with_capacity(claims.len() * 2 + 1);
    let mut authors = BTreeMap::<[u8; 32], Scalar>::new();
    let mut sum = Scalar::ZERO;
    for (index, claim) in claims.iter().enumerate() {
        let mut r = FieldBytes::default();
        r.copy_from_slice(&claim.sig[..32]);
        let Some(point) = AffinePoint::decompact(&r).into_option() else {
            return false;
        };
        let mut s = FieldBytes::default();
        s.copy_from_slice(&claim.sig[32..]);
        let Some(s) = Scalar::from_repr(s).into_option() else {
            return false;
        };
        let mut hash = challenge.clone();
        hash.update(r);
        hash.update(claim.pubkey);
        hash.update(claim.id);
        let e = <Scalar as Reduce<FieldBytes>>::reduce(&FieldBytes::from(<[u8; 32]>::from(
            hash.finalize(),
        )));
        let a = if index == 0 {
            Scalar::ONE
        } else {
            coefficient(&mut rng)
        };
        sum += a * s;
        terms.push((ProjectivePoint::from(point), -a));
        *authors.entry(claim.pubkey).or_insert(Scalar::ZERO) -= a * e;
    }
    for (pubkey, coefficient) in authors {
        // Validate the key even when its combined coefficient is zero.
        let Some(point) = AffinePoint::decompact(&FieldBytes::from(pubkey)).into_option() else {
            return false;
        };
        terms.push((ProjectivePoint::from(point), coefficient));
    }
    terms.push((ProjectivePoint::GENERATOR, sum));
    // Variable-time arithmetic only processes public signature material.
    ProjectivePoint::lincomb_vartime(terms.as_slice()) == ProjectivePoint::IDENTITY
}

fn coefficient(rng: &mut ChaCha20Rng) -> Scalar {
    loop {
        let mut bytes = [0; 32];
        rng.fill_bytes(&mut bytes);
        if let Some(scalar) = Scalar::from_repr(bytes.into()).into_option() {
            if scalar != Scalar::ZERO {
                return scalar;
            }
        }
    }
}

#[cfg(test)]
mod tests;
