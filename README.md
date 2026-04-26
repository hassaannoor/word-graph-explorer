# word-graph-explorer

A **fully static** interactive web app for exploring WordNet-related synsets across **English, Latin, and Greek**, with clickable nodes, breadcrumb navigation, and an autocomplete-driven sidebar search. No backend — open `index.html` (or serve the folder with any static host) and the app loads the entire WordNet graph as a single JSON file in the browser.

The center of the graph is your focused word. Around it are clusters of related synsets (hypernyms, hyponyms, meronyms, similar-tos, …), each connected to the center, with the actual lemmas inside each cluster colour-coded by language. Clicking any lemma re-focuses the graph on that word; breadcrumbs at the top let you rewind.

## Run it

Any static file server works. Easiest:

```bash
python -m http.server 8000
```

Then open http://127.0.0.1:8000.

(Opening `index.html` directly via `file://` will fail because browsers block `fetch()` of local JSON over the file protocol — use a local server, or just deploy the folder to GitHub Pages / Netlify / S3 / etc.)

## Sidebar settings

- **Per-relation cap** — how many lemmas to show inside each relation cluster.
- **Graph depth** — `1` = direct neighbors only; `2` = also expand one more hop on each neighbor.
- **Sense to display** — pick which WordNet sense of an ambiguous head word to explore.
- **Language toggles** — show/hide English, Latin, Greek separately.

## Data

The app loads `data/wordnet.json` on first paint (~6 MB gzipped, ~20 MB uncompressed, served once and cached by the browser). It contains:

- ~117k synsets with definition, POS, English + Greek lemmas, and per-relation neighbor pointers
- ~147k English head-word index entries for autocomplete and lookup

### Regenerating the data

`build_data.py` walks NLTK's WordNet + OMW and emits `data/wordnet.json`:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt   # nltk only
python build_data.py
```

The first run downloads `wordnet` and `omw-1.4` (~30 MB) into `~/nltk_data`.

## Note on Latin

NLTK's bundled OMW (`omw-1.4`) does **not** include Latin lemmas, so Latin slots are typically empty unless you wire in an external Latin WordNet (e.g. LatinWordNet from the Open Greek and Latin project) and extend `build_data.py`. English and modern Greek (transliterated for legibility, with the original script kept as a sub-label) populate normally.

## Stack

- Vanilla JS + [d3](https://d3js.org/) for the SVG layout, pan, and zoom — no bundler, no framework.
- Python build script using NLTK + WordNet + OMW for the one-shot data export.
