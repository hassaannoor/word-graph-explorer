#!/usr/bin/env python3
"""Flask web app for the eng/lat/grc similar-words explorer.

Exposes:
  - GET /                — single-page UI
  - GET /api/graph       — focused-word graph grouped by relation + language
  - GET /api/autocomplete — prefix suggestions over English lemmas
"""

from __future__ import annotations

import os
import threading
from typing import Dict, List

from flask import Flask, jsonify, render_template, request

from wordnet_relations import (
    ensure_wordnet_data,
    english_sound,
    related_synsets,
)


LANGUAGES = [
    ("eng", "english"),
    ("lat", "latin"),
    ("ell", "greek"),
]

# Human-readable labels for WordNet relations.
RELATION_METHODS = [
    ("hypernyms", "Hypernyms (broader)"),
    ("hyponyms", "Hyponyms (narrower)"),
    ("similar_tos", "Similar"),
    ("also_sees", "Also see"),
    ("member_holonyms", "Member of"),
    ("member_meronyms", "Members"),
    ("part_holonyms", "Part of"),
    ("part_meronyms", "Parts"),
    ("substance_holonyms", "Substance of"),
    ("substance_meronyms", "Substances"),
    ("attributes", "Attributes"),
    ("entailments", "Entails"),
    ("causes", "Causes"),
    ("verb_groups", "Verb group"),
]


_wn_lock = threading.Lock()
_wn_loaded = False
_lemma_cache: List[str] = []


def _load_wn():
    """Initialise WordNet + OMW once, and pre-populate the lemma cache."""
    global _wn_loaded, _lemma_cache
    if _wn_loaded:
        return

    with _wn_lock:
        if _wn_loaded:
            return
        ensure_wordnet_data()
        from nltk.corpus import wordnet as wn

        # Touch a lemma to trigger OMW lazy-loading so other languages register.
        for s in wn.synsets("hello"):
            s.lemma_names("ell")
            break

        names = set()
        for name in wn.all_lemma_names(lang="eng"):
            text = name.replace("_", " ").strip()
            if text:
                names.add(text.lower())
        _lemma_cache = sorted(names)
        _wn_loaded = True


def _lemmas(synset, lang_code: str) -> List[str]:
    try:
        lemmas = synset.lemmas(lang=lang_code)
    except Exception:
        return []
    out = []
    seen = set()
    for lemma in lemmas:
        text = lemma.name().replace("_", " ").strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def _lemma_payload(text: str, language: str) -> Dict:
    spoken = english_sound(text, language)
    return {
        "word": text,
        "spoken": spoken,
        "language": language,
        # The clickable identity uses the romanised form for English routing,
        # but we keep the original for display.
        "click_word": spoken if language != "english" else text,
    }


def build_graph(word: str, max_depth: int, per_relation_limit: int) -> Dict:
    """Build the focused-word graph payload for the UI."""
    from nltk.corpus import wordnet as wn

    word = word.strip()
    if not word:
        return {"word": "", "senses": [], "found": False}

    start_synsets = wn.synsets(word, lang="eng")
    if not start_synsets:
        # Try matching against any language's lemma → still no result, return empty.
        return {"word": word, "senses": [], "found": False}

    senses = []
    seen_neighbor_ids = set()  # so the same synset isn't repeated across senses

    for sense_idx, synset in enumerate(start_synsets):
        sense_payload = {
            "id": synset.name(),
            "index": sense_idx,
            "definition": synset.definition(),
            "pos": synset.pos(),
            "examples": list(synset.examples())[:2],
            "lemmas": {
                lang_name: _lemmas(synset, lang_code)
                for lang_code, lang_name in LANGUAGES
            },
            "groups": [],
        }

        for method_name, label in RELATION_METHODS:
            method = getattr(synset, method_name, None)
            if method is None:
                continue
            try:
                neighbors = list(method())
            except Exception:
                continue
            if not neighbors:
                continue

            # Optionally expand one more hop on the most relevant neighbors.
            if max_depth > 1:
                expanded = []
                for n in neighbors:
                    expanded.append(n)
                    expanded.extend(related_synsets(n))
                neighbors = expanded

            words_by_lang: Dict[str, Dict[str, Dict]] = {
                name: {} for _, name in LANGUAGES
            }

            for n in neighbors:
                key = n.name()
                if key in seen_neighbor_ids and method_name != "hypernyms":
                    # Allow duplication only if it adds new lemmas — easier to skip.
                    continue
                seen_neighbor_ids.add(key)
                for lang_code, lang_name in LANGUAGES:
                    for text in _lemmas(n, lang_code):
                        norm = text.lower()
                        if norm == word.lower():
                            continue
                        if norm in words_by_lang[lang_name]:
                            continue
                        words_by_lang[lang_name][norm] = _lemma_payload(
                            text, lang_name
                        )

            entries = []
            for _, lang_name in LANGUAGES:
                items = list(words_by_lang[lang_name].values())
                if per_relation_limit and len(items) > per_relation_limit:
                    items = items[:per_relation_limit]
                entries.extend(items)

            if entries:
                sense_payload["groups"].append(
                    {
                        "id": f"{synset.name()}::{method_name}",
                        "relation": method_name,
                        "label": label,
                        "items": entries,
                    }
                )

        senses.append(sense_payload)

    return {"word": word, "senses": senses, "found": True}


app = Flask(
    __name__,
    static_folder="static",
    template_folder="templates",
)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/graph")
def api_graph():
    _load_wn()
    word = request.args.get("word", "").strip()
    try:
        max_depth = max(1, min(2, int(request.args.get("max_depth", 1))))
    except ValueError:
        max_depth = 1
    try:
        limit = max(0, min(50, int(request.args.get("limit", 12))))
    except ValueError:
        limit = 12

    payload = build_graph(word, max_depth=max_depth, per_relation_limit=limit)
    return jsonify(payload)


@app.route("/api/autocomplete")
def api_autocomplete():
    _load_wn()
    q = request.args.get("q", "").strip().lower()
    try:
        n = max(1, min(25, int(request.args.get("n", 10))))
    except ValueError:
        n = 10
    if not q:
        return jsonify({"q": q, "matches": []})

    # Linear prefix scan against the precomputed lemma list.
    matches = []
    for name in _lemma_cache:
        if name.startswith(q):
            matches.append(name)
            if len(matches) >= n:
                break
    return jsonify({"q": q, "matches": matches})


if __name__ == "__main__":
    _load_wn()
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="127.0.0.1", port=port, debug=False)
