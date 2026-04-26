#!/usr/bin/env python3
"""Return similar words for an input term in English, Latin, and Greek.

Uses NLTK WordNet + Open Multilingual WordNet (omw-1.4).
Output is ordered by language: English, then Latin, then Greek.
"""

from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass
import unicodedata
from typing import Dict, Iterable, List, Set, Tuple


@dataclass(frozen=True)
class Candidate:
    word: str
    score: float
    language: str


def strip_diacritics(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


def transliterate_greek(text: str) -> str:
    # Apply a simple Greek->Latin transliteration that reads naturally in English.
    t = strip_diacritics(text).lower()

    digraphs = {
        "αι": "ai",
        "ει": "ei",
        "οι": "oi",
        "ου": "ou",
        "αυ": "av",
        "ευ": "ev",
        "ηυ": "iv",
        "γγ": "ng",
        "γκ": "gk",
        "γχ": "nch",
        "τσ": "ts",
        "τζ": "tz",
        "μπ": "b",
        "ντ": "d",
    }

    singles = {
        "α": "a",
        "β": "v",
        "γ": "g",
        "δ": "d",
        "ε": "e",
        "ζ": "z",
        "η": "i",
        "θ": "th",
        "ι": "i",
        "κ": "k",
        "λ": "l",
        "μ": "m",
        "ν": "n",
        "ξ": "x",
        "ο": "o",
        "π": "p",
        "ρ": "r",
        "σ": "s",
        "ς": "s",
        "τ": "t",
        "υ": "y",
        "φ": "f",
        "χ": "ch",
        "ψ": "ps",
        "ω": "o",
    }

    out = []
    i = 0
    while i < len(t):
        pair = t[i : i + 2]
        if pair in digraphs:
            out.append(digraphs[pair])
            i += 2
            continue
        out.append(singles.get(t[i], t[i]))
        i += 1

    return "".join(out)


def english_sound(word: str, language: str) -> str:
    if language == "greek":
        return transliterate_greek(word)
    if language == "latin":
        return strip_diacritics(word).lower()
    return word


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Pass a word and get similar words ordered by language: "
            "English, Latin, Greek."
        )
    )
    parser.add_argument("word", help="Input word in English (example: king)")
    parser.add_argument(
        "-n",
        "--count",
        type=int,
        default=40,
        help="Total number of similar words to return (default: 40)",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=2,
        help="Graph depth for related synsets (default: 2)",
    )
    return parser.parse_args()


def ensure_wordnet_data() -> None:
    try:
        import nltk
    except ImportError as exc:
        raise SystemExit("Missing dependency: nltk. Install with: pip install nltk") from exc

    nltk.download("wordnet", quiet=True)
    nltk.download("omw-1.4", quiet=True)


def related_synsets(synset) -> Iterable:
    """Return direct semantic neighbors used to build a similarity neighborhood."""
    neighbors = []
    neighbors.extend(synset.hypernyms())
    neighbors.extend(synset.hyponyms())
    neighbors.extend(synset.similar_tos())
    neighbors.extend(synset.also_sees())
    neighbors.extend(synset.member_holonyms())
    neighbors.extend(synset.member_meronyms())
    neighbors.extend(synset.part_holonyms())
    neighbors.extend(synset.part_meronyms())
    neighbors.extend(synset.substance_holonyms())
    neighbors.extend(synset.substance_meronyms())
    neighbors.extend(synset.attributes())
    neighbors.extend(synset.entailments())
    neighbors.extend(synset.causes())
    neighbors.extend(synset.verb_groups())
    return neighbors


def build_synset_scores(start_synsets: List, max_depth: int) -> Dict:
    """BFS over WordNet graph and assign a score based on graph distance."""
    queue = deque()
    visited: Set = set()
    scores: Dict = {}

    for s in start_synsets:
        queue.append((s, 0))
        visited.add(s)

    while queue:
        synset, depth = queue.popleft()
        score = 1.0 / (depth + 1.0)

        prev = scores.get(synset)
        if prev is None or score > prev:
            scores[synset] = score

        if depth >= max_depth:
            continue

        for nxt in related_synsets(synset):
            if nxt in visited:
                continue
            visited.add(nxt)
            queue.append((nxt, depth + 1))

    return scores


def lemmas_for_language(synset, lang_code: str) -> List[str]:
    try:
        lemmas = synset.lemmas(lang=lang_code)
    except Exception:
        return []

    out = []
    for lemma in lemmas:
        text = lemma.name().replace("_", " ").strip()
        if text:
            out.append(text)
    return out


def rank_candidates(word: str, count: int, max_depth: int) -> List[Candidate]:
    from nltk.corpus import wordnet as wn

    start_synsets = wn.synsets(word, lang="eng")
    if not start_synsets:
        return []

    synset_scores = build_synset_scores(start_synsets, max_depth=max_depth)

    language_order: List[Tuple[str, str]] = [
        ("eng", "english"),
        ("lat", "latin"),
        ("ell", "greek"),
    ]

    # Keep only the best score per normalized word within each language.
    by_language: Dict[str, Dict[str, float]] = {name: {} for _, name in language_order}
    input_norm = word.strip().lower()

    for synset, syn_score in synset_scores.items():
        for lang_code, lang_name in language_order:
            for lemma_text in lemmas_for_language(synset, lang_code):
                norm = lemma_text.lower()
                if norm == input_norm:
                    continue

                current = by_language[lang_name].get(norm)
                if current is None or syn_score > current:
                    by_language[lang_name][norm] = syn_score

    ranked_by_lang: Dict[str, List[Candidate]] = {}
    for _, lang_name in language_order:
        ranked = [
            Candidate(word=w, score=s, language=lang_name)
            for w, s in by_language[lang_name].items()
        ]
        ranked.sort(key=lambda c: (-c.score, c.word))
        ranked_by_lang[lang_name] = ranked

    # Reserve slots per language so the final list includes all three in order.
    lang_names = [name for _, name in language_order]
    base = count // len(lang_names)
    remainder = count % len(lang_names)

    quotas: Dict[str, int] = {}
    for i, lang_name in enumerate(lang_names):
        quotas[lang_name] = base + (1 if i < remainder else 0)

    selected_by_lang: Dict[str, List[Candidate]] = {}
    leftovers: List[Candidate] = []

    for lang_name in lang_names:
        items = ranked_by_lang[lang_name]
        selected_by_lang[lang_name] = items[: quotas[lang_name]]
        leftovers.extend(items[quotas[lang_name] :])

    selected_total = sum(len(v) for v in selected_by_lang.values())
    if selected_total < count and leftovers:
        needed = count - selected_total
        leftovers.sort(key=lambda c: (-c.score, c.word))
        for item in leftovers[:needed]:
            selected_by_lang[item.language].append(item)

    ordered: List[Candidate] = []
    for lang_name in lang_names:
        ordered.extend(selected_by_lang[lang_name])

    return ordered[:count]


def print_results(word: str, results: List[Candidate]) -> None:
    if not results:
        print(f"No similar words found for '{word}'.")
        return

    print(f"Input word: {word}")
    print("Ordered by language: english -> latin -> greek")

    for idx, item in enumerate(results, start=1):
        spoken = english_sound(item.word, item.language)
        if spoken != item.word:
            print(f"{idx:>2}. {spoken} [{item.language}] (original: {item.word})")
        else:
            print(f"{idx:>2}. {item.word} [{item.language}]")


def main() -> None:
    args = parse_args()
    ensure_wordnet_data()

    results = rank_candidates(
        word=args.word,
        count=max(1, args.count),
        max_depth=max(0, args.max_depth),
    )
    print_results(args.word, results)


if __name__ == "__main__":
    main()
