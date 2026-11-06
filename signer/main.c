/*
 * SLH-DSA-SHA2-128-24 one-shot CLI.
 *
 *   Usage:  slhdsa-sha2-128-24 <seed_48B_hex> <message_hex>                     # hedged (default)
 *           slhdsa-sha2-128-24 <seed_48B_hex> <message_hex> <optrand_16B_hex>   # explicit opt_rand
 *
 * `seed_48B` = sk_seed(16) || sk_prf(16) || pk_seed(16) — pass whatever
 * derivation you like from the outside.
 *
 * **Default is hedged** (FIPS 205 §9.2 recommendation). The per-signature
 * randomizer (`opt_rand`) is drawn from the kernel CSPRNG (getrandom(2),
 * fallback /dev/urandom). The actual `opt_rand` bytes used are printed to
 * stderr so a hedged sig can be reproduced exactly via the deterministic
 * interface if needed.
 *
 * Pass a 16-byte hex `opt_rand` as the third positional arg to force a
 * specific randomizer (deterministic mode — only useful for KATs and
 * cross-validation).
 *
 * Output to stdout (one line, hex, no 0x):
 *   pk_seed(16) || pk_root(16) || sig(SPX_BYTES = 3856)
 *
 *   = 32 + 3856 = 3888 bytes = 7776 hex chars.
 *
 * Exit status 0 on success, non-zero on usage or internal error.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#include "params.h"
#include "api.h"
#include "randombytes.h"
#include "context.h"
#include "hash.h"
#include "merkle.h"
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef __linux__
#include <sys/random.h>
#endif

/* set_rng_buffer is declared here (not in randombytes.h) because it's an
   internal hook for this harness only, not part of the SPHINCS+ API. */
extern void set_rng_buffer(const unsigned char *buf, unsigned long long len);

static int hex_nibble(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int hex_decode(const char *hex, unsigned char *out, size_t out_len)
{
    size_t hlen = strlen(hex);
    if (hlen >= 2 && hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) {
        hex += 2;
        hlen -= 2;
    }
    if (hlen != out_len * 2) return -1;
    for (size_t i = 0; i < out_len; i++) {
        int hi = hex_nibble(hex[2 * i]);
        int lo = hex_nibble(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (unsigned char)((hi << 4) | lo);
    }
    return 0;
}

static void hex_print(const unsigned char *buf, size_t len)
{
    for (size_t i = 0; i < len; i++) printf("%02x", buf[i]);
    putchar('\n');
}

/* Fill `out` with `len` cryptographically secure random bytes. Returns 0 on
 * success, -1 on failure. Tries getrandom(2) first, falls back to reading
 * /dev/urandom. */
static int csprng_fill(unsigned char *out, size_t len)
{
#ifdef __linux__
    size_t got = 0;
    while (got < len) {
        ssize_t n = getrandom(out + got, len - got, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        got += (size_t) n;
    }
    if (got == len) return 0;
#endif
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) return -1;
    size_t n = fread(out, 1, len, f);
    fclose(f);
    return (n == len) ? 0 : -1;
}

#define LEANSEAL_CACHE_HEADER (2 * SPX_N)
#define LEANSEAL_CACHE_NODES_BYTES (((size_t)1 << (SPX_TREE_HEIGHT + 1)) * SPX_N)

static int build_cache(const char *seed_hex, const char *path)
{
    unsigned char seed[CRYPTO_SEEDBYTES];
    if (hex_decode(seed_hex, seed, sizeof(seed)) != 0) {
        fprintf(stderr, "bad seed hex\n");
        return 1;
    }
    spx_ctx ctx;
    memcpy(ctx.sk_seed, seed, SPX_N);
    memcpy(ctx.pub_seed, seed + 2 * SPX_N, SPX_N);
    initialize_hash_function(&ctx);
    unsigned char *buf = malloc(LEANSEAL_CACHE_HEADER + LEANSEAL_CACHE_NODES_BYTES);
    if (!buf) { fprintf(stderr, "oom\n"); return 1; }
    unsigned char *nodes = buf + LEANSEAL_CACHE_HEADER;
    merkle_build_cache(nodes, &ctx);
    memcpy(buf, ctx.pub_seed, SPX_N);
    memcpy(buf + SPX_N, nodes + spx_cache_offset(SPX_TREE_HEIGHT, 0), SPX_N);
    FILE *f = fopen(path, "wb");
    if (!f) { fprintf(stderr, "cannot write %s\n", path); free(buf); return 1; }
    size_t total = LEANSEAL_CACHE_HEADER + LEANSEAL_CACHE_NODES_BYTES;
    int ok = fwrite(buf, 1, total, f) == total;
    fclose(f);
    if (ok) hex_print(buf, LEANSEAL_CACHE_HEADER);
    free(buf);
    return ok ? 0 : 1;
}

static int load_cache(const char *path, const unsigned char *seed)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) { fprintf(stderr, "cannot open cache %s\n", path); return 1; }
    size_t total = LEANSEAL_CACHE_HEADER + LEANSEAL_CACHE_NODES_BYTES;
    struct stat st;
    if (fstat(fd, &st) != 0 || (size_t)st.st_size != total) {
        fprintf(stderr, "cache %s has wrong size\n", path);
        close(fd);
        return 1;
    }
    const unsigned char *map = mmap(NULL, total, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (map == MAP_FAILED) { fprintf(stderr, "mmap failed\n"); return 1; }
    if (memcmp(map, seed + 2 * SPX_N, SPX_N) != 0) {
        fprintf(stderr, "cache belongs to a different key\n");
        return 1;
    }
    spx_xmss_cache = map + LEANSEAL_CACHE_HEADER;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 4 && strcmp(argv[1], "--build-cache") == 0) {
        return build_cache(argv[2], argv[3]);
    }
    int hedged = 0;
    const char *seed_hex = NULL;
    const char *msg_hex_arg = NULL;
    const char *optrand_hex = NULL; /* unused in --hedged mode */

    if (argc == 3) {
        /* New default: hedged. */
        hedged      = 1;
        seed_hex    = argv[1];
        msg_hex_arg = argv[2];
    } else if (argc == 4 && strcmp(argv[1], "--hedged") == 0) {
        /* Backwards-compat: explicit --hedged flag (now redundant). */
        hedged      = 1;
        seed_hex    = argv[2];
        msg_hex_arg = argv[3];
    } else if (argc == 4) {
        /* Deterministic mode: explicit opt_rand as third positional. */
        seed_hex    = argv[1];
        msg_hex_arg = argv[2];
        optrand_hex = argv[3];
    } else {
        fprintf(stderr,
            "Usage:\n"
            "  %s <seed_48B_hex> <message_hex>                     (HEDGED, default — opt_rand from kernel CSPRNG)\n"
            "  %s <seed_48B_hex> <message_hex> <optrand_16B_hex>   (explicit opt_rand — for KATs)\n"
            "  seed = sk_seed(16) || sk_prf(16) || pk_seed(16)\n"
            "  message = arbitrary-length hex (pad nothing)\n"
            "  optrand = %d bytes (the per-sig randomizer)\n"
            "\nOutput: hex(pk_seed(16) || pk_root(16) || sig(%d))\n",
            argv[0], argv[0], SPX_N, SPX_BYTES);
        return 2;
    }

    unsigned char seed[CRYPTO_SEEDBYTES];        /* = 3 * SPX_N = 48 */
    if (hex_decode(seed_hex, seed, sizeof(seed)) != 0) {
        fprintf(stderr, "bad seed hex (need %zu bytes)\n", sizeof(seed));
        return 1;
    }

    size_t msg_hex_len = strlen(msg_hex_arg);
    if (msg_hex_len >= 2 && msg_hex_arg[0] == '0' &&
        (msg_hex_arg[1] == 'x' || msg_hex_arg[1] == 'X')) msg_hex_len -= 2;
    if (msg_hex_len & 1) {
        fprintf(stderr, "message hex must have even length\n");
        return 1;
    }
    size_t msg_len = msg_hex_len / 2;
    unsigned char *msg = (unsigned char *)malloc(msg_len ? msg_len : 1);
    if (!msg) { fprintf(stderr, "oom\n"); return 1; }
    if (msg_len && hex_decode(msg_hex_arg, msg, msg_len) != 0) {
        fprintf(stderr, "bad message hex\n"); free(msg); return 1;
    }

    unsigned char optrand[SPX_N];
    if (hedged) {
        if (csprng_fill(optrand, sizeof(optrand)) != 0) {
            fprintf(stderr, "csprng_fill failed: no getrandom and no /dev/urandom\n");
            free(msg); return 1;
        }
        fprintf(stderr, "  mode: hedged (opt_rand=");
        for (size_t i = 0; i < sizeof(optrand); i++) fprintf(stderr, "%02x", optrand[i]);
        fprintf(stderr, ")\n");
    } else {
        if (hex_decode(optrand_hex, optrand, sizeof(optrand)) != 0) {
            fprintf(stderr, "bad optrand hex (need %d bytes)\n", SPX_N);
            free(msg); return 1;
        }
    }

    const char *cache_path = getenv("LEANSEAL_XMSS_CACHE");
    if (cache_path != NULL && load_cache(cache_path, seed) != 0) {
        free(msg); return 1;
    }

    unsigned char pk[SPX_PK_BYTES];              /* = 32 */
    unsigned char sk[SPX_SK_BYTES];              /* = 64 */
    fprintf(stderr, "  keygen (single XMSS, 2^%d leaves)...\n", SPX_FULL_HEIGHT);
    if (crypto_sign_seed_keypair(pk, sk, seed) != 0) {
        fprintf(stderr, "keygen failed\n"); free(msg); return 1;
    }
    fprintf(stderr, "  pk_seed = "); for (int i = 0; i < 4; i++) fprintf(stderr, "%02x", pk[i]); fprintf(stderr, "...\n");
    fprintf(stderr, "  pk_root = "); for (int i = 0; i < 4; i++) fprintf(stderr, "%02x", pk[SPX_N + i]); fprintf(stderr, "...\n");

    unsigned char sig[SPX_BYTES];                /* = 3856 */
    size_t siglen = 0;
    set_rng_buffer(optrand, sizeof(optrand));
    fprintf(stderr, "  signing (FORS + XMSS)...\n");
    if (crypto_sign_signature(sig, &siglen, msg, msg_len, sk) != 0) {
        fprintf(stderr, "sign failed\n"); free(msg); return 1;
    }
    if (siglen != SPX_BYTES) {
        fprintf(stderr, "unexpected siglen %zu != %d\n", siglen, SPX_BYTES);
        free(msg); return 1;
    }
    fprintf(stderr, "  sig: %zu bytes\n", siglen);
    if (cache_path != NULL && crypto_sign_verify(sig, siglen, msg, msg_len, pk) != 0) {
        fprintf(stderr, "self-verify failed with cache\n");
        free(msg); return 1;
    }

    /* Emit pk_seed || pk_root || sig as hex. */
    unsigned char out[2 * SPX_N + SPX_BYTES];
    memcpy(out,              pk,           SPX_N);            /* pk_seed */
    memcpy(out + SPX_N,      pk + SPX_N,   SPX_N);            /* pk_root */
    memcpy(out + 2 * SPX_N,  sig,          SPX_BYTES);
    hex_print(out, sizeof(out));

    free(msg);
    return 0;
}
