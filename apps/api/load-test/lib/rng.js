'use strict';
/**
 * RNG determinístico por seed (mulberry32) — mesmo seed → mesmo dataset, sempre.
 * Não usar Math.random() em NENHUM lugar do gerador de dataset.
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Converte uma string-seed em inteiro (FNV-1a). */
function seedFromString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function makeRng(seed) {
    const s = typeof seed === 'number' ? seed : seedFromString(String(seed));
    const next = mulberry32(s);
    return {
        seed: s,
        float: () => next(),
        int: (min, max) => min + Math.floor(next() * (max - min + 1)),
        pick: (arr) => arr[Math.floor(next() * arr.length)],
    };
}

module.exports = { makeRng, seedFromString };
