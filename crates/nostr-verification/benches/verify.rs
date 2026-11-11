//! Compare the production verifier with the previous native loop, including
//! hex decoding, public-key parsing, context creation, and ordered results.
//! Signing/setup, JSON, Tauri IPC, event hashing, and rendering are excluded.
use buzz_nostr_verification::{verify, SignatureClaim};
use secp256k1::{schnorr::Signature, Keypair, Secp256k1, SecretKey, XOnlyPublicKey};
use sha2::{Digest, Sha256};
use std::{hint::black_box, time::Instant};

fn original(claims: &[SignatureClaim]) -> Vec<bool> {
    let secp = Secp256k1::verification_only();
    claims
        .iter()
        .map(|claim| {
            let (Ok(id), Ok(pubkey), Ok(sig)) = (
                nostr::event::EventId::from_hex(&claim.id),
                claim.pubkey.parse::<XOnlyPublicKey>(),
                claim.sig.parse::<Signature>(),
            ) else {
                return false;
            };
            secp.verify_schnorr(&sig, id.as_bytes(), &pubkey).is_ok()
        })
        .collect()
}

fn corpus(count: usize, authors: usize) -> Vec<SignatureClaim> {
    let secp = Secp256k1::signing_only();
    (0..count)
        .map(|index| {
            let secret = Sha256::digest((index % authors).to_le_bytes());
            let key = Keypair::from_secret_key(
                &secp,
                &SecretKey::from_byte_array(secret.into()).unwrap(),
            );
            let id: [u8; 32] = Sha256::digest(index.to_le_bytes()).into();
            SignatureClaim {
                id: hex::encode(id),
                pubkey: key.x_only_public_key().0.to_string(),
                sig: secp.sign_schnorr_no_aux_rand(&id, &key).to_string(),
            }
        })
        .collect()
}

fn time(f: fn(&[SignatureClaim]) -> Vec<bool>, claims: &[SignatureClaim], repeats: usize) -> f64 {
    let start = Instant::now();
    for _ in 0..repeats {
        black_box(f(black_box(claims)));
    }
    start.elapsed().as_secs_f64() * 1e6 / repeats as f64
}

fn measure(claims: &[SignatureClaim], authors: usize, invalid: usize) {
    assert_eq!(verify(claims), original(claims));
    for _ in 0..4 {
        black_box(verify(claims));
        black_box(original(claims));
    }
    let repeats = (4096 / claims.len()).max(16);
    let mut old = Vec::new();
    let mut new = Vec::new();
    for round in 0..7 {
        if round % 2 == 0 {
            old.push(time(original, claims, repeats));
            new.push(time(verify, claims, repeats));
        } else {
            new.push(time(verify, claims, repeats));
            old.push(time(original, claims, repeats));
        }
        eprintln!(
            "sample,{},{authors},{invalid},{round},{:.3},{:.3}",
            claims.len(),
            old[round],
            new[round]
        );
    }
    old.sort_by(f64::total_cmp);
    new.sort_by(f64::total_cmp);
    println!(
        "{},{authors},{invalid},{:.3},{:.3},{:.3}",
        claims.len(),
        old[3],
        new[3],
        old[3] / new[3]
    );
}

fn main() {
    println!("signatures,authors,invalid,individual_us,adaptive_us,speedup");
    for count in [1, 4, 12, 32, 128, 512] {
        let mut author_counts = vec![1, 4, count / 8, count / 8 + 1, count];
        author_counts.sort_unstable();
        author_counts.dedup();
        for authors in author_counts {
            if authors == 0 || authors > count {
                continue;
            }
            measure(&corpus(count, authors), authors, 0);
        }
    }
    for count in [12, 128, 512] {
        for bad in [1, count / 2] {
            let mut claims = corpus(count, 1);
            for claim in &mut claims[..bad] {
                claim.id = "00".repeat(32);
            }
            measure(&claims, 1, bad);
        }
    }
}
