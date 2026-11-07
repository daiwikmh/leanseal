use std::sync::Mutex;

use leansphincs_s_keccak::{CachedKey, Tier, keygen_cached, sign_with_cache};

const IO_LEN: usize = 8192;

static IO: Mutex<[u8; IO_LEN]> = Mutex::new([0; IO_LEN]);
static KEY: Mutex<Option<CachedKey>> = Mutex::new(None);

#[unsafe(no_mangle)]
pub extern "C" fn io_ptr() -> *mut u8 {
    IO.lock().unwrap().as_mut_ptr()
}

/// Seed in, public key out.
#[unsafe(no_mangle)]
pub extern "C" fn lss_keygen() -> u32 {
    let mut io = IO.lock().unwrap();
    let seed: [u8; 32] = io[..32].try_into().unwrap();
    io[..32].fill(0);
    let key = keygen_cached(&seed, Tier::Light, 1);
    let pk = key.public_key();
    io[..64].fill(0);
    io[..16].copy_from_slice(&pk.public_param);
    io[32..48].copy_from_slice(&pk.root);
    *KEY.lock().unwrap() = Some(key);
    64
}

/// Digest in, signature out.
#[unsafe(no_mangle)]
pub extern "C" fn lss_sign() -> u32 {
    let mut io = IO.lock().unwrap();
    let m: [u8; 32] = io[..32].try_into().unwrap();
    let guard = KEY.lock().unwrap();
    let Some(key) = guard.as_ref() else { return 0 };
    let Ok(sig) = sign_with_cache(key, &m) else { return 0 };
    let bytes = sig.to_bytes();
    io[..bytes.len()].copy_from_slice(&bytes);
    bytes.len() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn lss_forget() {
    *KEY.lock().unwrap() = None;
}
