#!/usr/bin/env python3
"""Export NLTK WordNet (+ OMW Greek) into a single packed JSON the static
front-end can load on boot.

Output: data/wordnet.json — schema:

{
  "version": 1,
  "relations": ["hypernyms", "hyponyms", ...],   # method names, indexed
  "languages": ["eng", "ell"],                    # lemma languages we ship
  "synsets": [
    [pos, name, definition, [eng_lemmas], [ell_lemmas],
     {relIdx: [synsetIdx, ...], ...}, [examples?]],
    ...
  ],
  "by_word": { "<lower-cased eng lemma>": [synsetIdx, ...] }
}

Relation targets are stored as integer indices into `synsets` to keep the
file small. Greek transliteration is done in the browser at render time, so
we only ship the original Greek lemmas here.

Run from this repo's root:

    python build_data.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Dict, List

RELATIONS = [
    "hypernyms",
    "hyponyms",
    "similar_tos",
    "also_sees",
    "member_holonyms",
    "member_meronyms",
    "part_holonyms",
    "part_meronyms",
    "substance_holonyms",
    "substance_meronyms",
    "attributes",
    "entailments",
    "causes",
    "verb_groups",
]


def ensure_data() -> None:
    import nltk

    nltk.download("wordnet", quiet=True)
    nltk.download("omw-1.4", quiet=True)


def lemmas_for(synset, lang: str) -> List[str]:
    try:
        lemmas = synset.lemmas(lang=lang)
    except Exception:
        return []
    out, seen = [], set()
    for lemma in lemmas:
        text = lemma.name().replace("_", " ").strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def main() -> None:
    ensure_data()
    from nltk.corpus import wordnet as wn

    # Touch a synset's non-English lemma so OMW lazy-loads.
    for s in wn.synsets("hello"):
        s.lemma_names("ell")
        break

    print("Indexing synsets…", file=sys.stderr)
    all_synsets = list(wn.all_synsets())
    name_to_idx: Dict[str, int] = {s.name(): i for i, s in enumerate(all_synsets)}

    print(f"  {len(all_synsets):,} synsets", file=sys.stderr)
    print("Building entries…", file=sys.stderr)

    synsets_payload: List = []
    by_word: Dict[str, List[int]] = {}

    for i, syn in enumerate(all_synsets):
        if i % 10000 == 0:
            print(f"  …{i:,}", file=sys.stderr)

        eng_lemmas = lemmas_for(syn, "eng")
        ell_lemmas = lemmas_for(syn, "ell")

        relations: Dict[int, List[int]] = {}
        for rel_idx, rel_name in enumerate(RELATIONS):
            method = getattr(syn, rel_name, None)
            if method is None:
                continue
            try:
                neighbors = method()
            except Exception:
                continue
            ids = []
            for n in neighbors:
                idx = name_to_idx.get(n.name())
                if idx is not None:
                    ids.append(idx)
            if ids:
                relations[rel_idx] = ids

        # Compact tuple form. Drop examples to save space — definitions are enough.
        entry = [
            syn.pos(),
            syn.name(),
            syn.definition(),
            eng_lemmas,
            ell_lemmas,
            relations,
        ]
        synsets_payload.append(entry)

        for lemma in eng_lemmas:
            key = lemma.lower()
            by_word.setdefault(key, []).append(i)

    out = {
        "version": 1,
        "relations": RELATIONS,
        "languages": ["eng", "ell"],
        "synsets": synsets_payload,
        "by_word": by_word,
    }

    os.makedirs("data", exist_ok=True)
    out_path = os.path.join("data", "wordnet.json")
    print(f"Writing {out_path}…", file=sys.stderr)
    with open(out_path, "w", encoding="utf-8") as f:
        # No indent — saves a lot of bytes.
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(
        f"Done. {len(synsets_payload):,} synsets, "
        f"{len(by_word):,} head words, {size_mb:.1f} MB on disk.",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
