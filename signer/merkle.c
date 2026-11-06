#include <stdint.h>
#include <string.h>

#include "utils.h"
#include "utilsx1.h"
#include "wots.h"
#include "wotsx1.h"
#include "merkle.h"
#include "address.h"
#include "params.h"
#include "thash.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

const unsigned char *spx_xmss_cache = NULL;

size_t spx_cache_offset(uint32_t h, uint32_t i)
{
    size_t full = (size_t)1 << (SPX_TREE_HEIGHT + 1);
    size_t below = full - ((size_t)1 << (SPX_TREE_HEIGHT - h + 1));
    return (below + i) * SPX_N;
}

/*
 * This generates a Merkle signature (WOTS signature followed by the Merkle
 * authentication path).  This is in this file because most of the complexity
 * is involved with the WOTS signature; the Merkle authentication path logic
 * is mostly hidden in treehashx4
 */
void merkle_sign(uint8_t *sig, unsigned char *root,
                 const spx_ctx *ctx,
                 uint32_t wots_addr[8], uint32_t tree_addr[8],
                 uint32_t idx_leaf)
{
    unsigned char *auth_path = sig + SPX_WOTS_BYTES;
    struct leaf_info_x1 info = { 0 };
    unsigned steps[ SPX_WOTS_LEN ];

    info.wots_sig = sig;
    chain_lengths(steps, root);
    info.wots_steps = steps;

    set_type(&tree_addr[0], SPX_ADDR_TYPE_HASHTREE);
    set_type(&info.pk_addr[0], SPX_ADDR_TYPE_WOTSPK);
    copy_subtree_addr(&info.leaf_addr[0], wots_addr);
    copy_subtree_addr(&info.pk_addr[0], wots_addr);

    info.wots_sign_leaf = idx_leaf;

    if (spx_xmss_cache != NULL && idx_leaf < (1u << SPX_TREE_HEIGHT)) {
        unsigned char leaf[SPX_N];
        wots_gen_leafx1(leaf, ctx, idx_leaf, &info);
        if (memcmp(leaf, spx_xmss_cache + spx_cache_offset(0, idx_leaf), SPX_N) != 0) {
            fprintf(stderr, "xmss cache does not match this key\n");
            exit(3);
        }
        for (uint32_t h = 0; h < SPX_TREE_HEIGHT; h++) {
            memcpy(auth_path + h * SPX_N,
                   spx_xmss_cache + spx_cache_offset(h, (idx_leaf >> h) ^ 1u), SPX_N);
        }
        memcpy(root, spx_xmss_cache + spx_cache_offset(SPX_TREE_HEIGHT, 0), SPX_N);
        return;
    }

    treehash_mt(root, auth_path, ctx,
                idx_leaf, 0,
                SPX_TREE_HEIGHT,
                wots_gen_leafx1,
                tree_addr, &info, sizeof(info));
}

/* Compute root node of the top-most subtree. */
void merkle_gen_root(unsigned char *root, const spx_ctx *ctx)
{
    if (spx_xmss_cache != NULL) {
        memcpy(root, spx_xmss_cache + spx_cache_offset(SPX_TREE_HEIGHT, 0), SPX_N);
        return;
    }

    /* We do not need the auth path in key generation, but it simplifies the
       code to have just one treehash routine that computes both root and path
       in one function. */
    unsigned char auth_path[SPX_TREE_HEIGHT * SPX_N + SPX_WOTS_BYTES];
    uint32_t top_tree_addr[8] = {0};
    uint32_t wots_addr[8] = {0};

    set_layer_addr(top_tree_addr, SPX_D - 1);
    set_layer_addr(wots_addr, SPX_D - 1);

    merkle_sign(auth_path, root, ctx,
                wots_addr, top_tree_addr,
                (uint32_t)~0 /* ~0 means "don't bother generating an auth path */ );
}

typedef struct {
    unsigned char *cache;
    const spx_ctx *ctx;
    uint32_t from;
    uint32_t to;
} spx_leaf_job;

static void *spx_leaf_run(void *p)
{
    spx_leaf_job *j = p;
    struct leaf_info_x1 info = { 0 };
    unsigned steps[SPX_WOTS_LEN] = { 0 };
    uint32_t wots_addr[8] = { 0 };
    set_layer_addr(wots_addr, SPX_D - 1);
    info.wots_sig = NULL;
    info.wots_sign_leaf = ~0u;
    info.wots_steps = steps;
    set_type(&info.pk_addr[0], SPX_ADDR_TYPE_WOTSPK);
    copy_subtree_addr(&info.leaf_addr[0], wots_addr);
    copy_subtree_addr(&info.pk_addr[0], wots_addr);
    for (uint32_t i = j->from; i < j->to; i++) {
        wots_gen_leafx1(j->cache + spx_cache_offset(0, i), j->ctx, i, &info);
    }
    return NULL;
}

void merkle_build_cache(unsigned char *cache, const spx_ctx *ctx)
{
    enum { THREADS = 16 };
    const uint32_t leaves = 1u << SPX_TREE_HEIGHT;
    spx_leaf_job jobs[THREADS];
    pthread_t threads[THREADS];
    for (uint32_t t = 0; t < THREADS; t++) {
        jobs[t].cache = cache;
        jobs[t].ctx = ctx;
        jobs[t].from = t * (leaves / THREADS);
        jobs[t].to = (t + 1) * (leaves / THREADS);
        pthread_create(&threads[t], NULL, spx_leaf_run, &jobs[t]);
    }
    for (uint32_t t = 0; t < THREADS; t++) {
        pthread_join(threads[t], NULL);
    }
    uint32_t tree_addr[8] = { 0 };
    set_layer_addr(tree_addr, SPX_D - 1);
    set_type(tree_addr, SPX_ADDR_TYPE_HASHTREE);
    for (uint32_t h = 0; h < SPX_TREE_HEIGHT; h++) {
        uint32_t count = 1u << (SPX_TREE_HEIGHT - h - 1);
        set_tree_height(tree_addr, h + 1);
        for (uint32_t i = 0; i < count; i++) {
            set_tree_index(tree_addr, i);
            thash(cache + spx_cache_offset(h + 1, i),
                  cache + spx_cache_offset(h, 2 * i), 2, ctx, tree_addr);
        }
    }
}
