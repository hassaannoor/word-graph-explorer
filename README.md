# word-graph-explorer

An interactive web app for exploring WordNet-related synsets across **English, Latin, and Greek**, with clickable nodes, breadcrumb navigation, and an autocomplete-driven sidebar search.

The center of the graph is your focused word. Around it are clusters of related synsets (hypernyms, hyponyms, meronyms, similar-tos, …), each connected to the center, with the actual lemmas inside each cluster colour-coded by language. Clicking any lemma re-focuses the graph on that word; breadcrumbs at the top let you rewind.

## Run it

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:5050.

On first launch NLTK will download `wordnet` and `omw-1.4` (~30 MB) into `~/nltk_data`.

## Endpoints

- `GET /api/graph?word=<w>&limit=<n>&max_depth=<1|2>` — grouped synset payload for the given English head word.
- `GET /api/autocomplete?q=<prefix>&n=<n>` — prefix-matched English lemmas.

## Sidebar settings

- **Per-relation cap** — how many lemmas to show inside each relation cluster.
- **Graph depth** — `1` = direct neighbors only; `2` = also expand one more hop on each neighbor.
- **Sense to display** — pick which WordNet sense of an ambiguous head word to explore.
- **Language toggles** — show/hide English, Latin, Greek separately.

## Note on Latin

NLTK's bundled OMW (`omw-1.4`) does **not** include Latin lemmas. As a result, Latin slots are typically empty unless you wire in an external Latin WordNet (e.g. LatinWordNet from the Open Greek and Latin project). English and modern Greek (transliterated for legibility, with the original script kept as a sub-label) populate normally.

## Stack

- Python 3 + Flask backend, NLTK + WordNet + OMW for the lexical graph.
- Vanilla JS frontend with [d3](https://d3js.org/) for the SVG layout, pan, and zoom.
