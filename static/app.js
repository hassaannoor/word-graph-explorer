(() => {
  // ----------------------- state -----------------------
  const state = {
    db: null,                     // loaded wordnet.json payload
    sortedWords: [],              // sorted lower-case English head words for autocomplete
    crumbs: [],                   // [{word, senseIndex}]
    cursor: -1,
    currentWord: "",
    currentSenseIdx: 0,
    settings: {
      limit: 10,
      depth: 1,
      showEng: true,
      showLat: true,              // present so the toggle exists; lat data is empty
      showGrc: true,
    },
    autocomplete: { items: [], active: -1 },
  };

  // Group labels for the relation methods (matches build_data.py).
  const RELATION_LABELS = {
    hypernyms: "Hypernyms (broader)",
    hyponyms: "Hyponyms (narrower)",
    similar_tos: "Similar",
    also_sees: "Also see",
    member_holonyms: "Member of",
    member_meronyms: "Members",
    part_holonyms: "Part of",
    part_meronyms: "Parts",
    substance_holonyms: "Substance of",
    substance_meronyms: "Substances",
    attributes: "Attributes",
    entailments: "Entails",
    causes: "Causes",
    verb_groups: "Verb group",
  };

  const $ = (sel) => document.querySelector(sel);
  const breadcrumbsEl = $("#breadcrumbs");
  const statusEl = $("#status");
  const svg = d3.select("#graph");
  const searchInput = $("#search-input");
  const searchBtn = $("#search-btn");
  const acEl = $("#autocomplete");
  const senseSelect = $("#setting-sense");

  function setStatus(msg) {
    if (!msg) {
      statusEl.classList.add("hidden");
      statusEl.textContent = "";
    } else {
      statusEl.classList.remove("hidden");
      statusEl.textContent = msg;
    }
  }

  // ----------------------- Greek transliteration (port of english_sound) -----------------------
  const GREEK_DIGRAPHS = {
    "αι":"ai","ει":"ei","οι":"oi","ου":"ou",
    "αυ":"av","ευ":"ev","ηυ":"iv",
    "γγ":"ng","γκ":"gk","γχ":"nch",
    "τσ":"ts","τζ":"tz","μπ":"b","ντ":"d",
  };
  const GREEK_SINGLES = {
    "α":"a","β":"v","γ":"g","δ":"d","ε":"e","ζ":"z","η":"i","θ":"th",
    "ι":"i","κ":"k","λ":"l","μ":"m","ν":"n","ξ":"x","ο":"o","π":"p",
    "ρ":"r","σ":"s","ς":"s","τ":"t","υ":"y","φ":"f","χ":"ch","ψ":"ps","ω":"o",
  };

  function stripDiacritics(s) {
    return s.normalize("NFD").replace(/\p{M}/gu, "");
  }

  function transliterateGreek(text) {
    const t = stripDiacritics(text).toLowerCase();
    let out = "", i = 0;
    while (i < t.length) {
      const pair = t.slice(i, i + 2);
      if (GREEK_DIGRAPHS[pair]) { out += GREEK_DIGRAPHS[pair]; i += 2; continue; }
      const c = t[i];
      out += GREEK_SINGLES[c] !== undefined ? GREEK_SINGLES[c] : c;
      i += 1;
    }
    return out;
  }

  function spokenForm(word, language) {
    if (language === "greek") return transliterateGreek(word);
    if (language === "latin") return stripDiacritics(word).toLowerCase();
    return word;
  }

  // ----------------------- DB loading -----------------------
  async function loadDB() {
    setStatus("loading WordNet data (~6 MB gzipped)…");
    const t0 = performance.now();
    const res = await fetch("data/wordnet.json");
    if (!res.ok) throw new Error(`failed to fetch data/wordnet.json (${res.status})`);
    const data = await res.json();
    state.db = data;
    state.sortedWords = Object.keys(data.by_word).sort();
    const dt = ((performance.now() - t0) / 1000).toFixed(2);
    setStatus(`loaded ${data.synsets.length.toLocaleString()} synsets in ${dt}s`);
    setTimeout(() => setStatus(""), 1800);
  }

  // ----------------------- graph build (mirrors build_graph in app.py) -----------------------
  function relationsOf(synsetEntry) { return synsetEntry[5] || {}; }

  function neighborsByRelation(synsetIdx) {
    return relationsOf(state.db.synsets[synsetIdx]);
  }

  function expandOnce(ids) {
    // depth=2: append the immediate neighbors (any relation) of each id,
    // mirroring related_synsets() in similar_words_eng_lat_grc.py.
    const out = ids.slice();
    const seen = new Set(ids);
    for (const id of ids) {
      const rels = neighborsByRelation(id);
      for (const r of Object.keys(rels)) {
        for (const n of rels[r]) {
          if (!seen.has(n)) { seen.add(n); out.push(n); }
        }
      }
    }
    return out;
  }

  function lemmaPayload(text, language) {
    const spoken = spokenForm(text, language);
    return {
      word: text,
      spoken,
      language,
      clickWord: language !== "english" ? spoken : text,
    };
  }

  function buildSense(synsetIdx, focusedWordLower, settings) {
    const entry = state.db.synsets[synsetIdx];
    const [pos, name, definition, engL, ellL, relations] = entry;

    const sense = {
      id: name,
      definition,
      pos,
      lemmas: { english: engL, latin: [], greek: ellL },
      groups: [],
    };

    const seenNeighborIds = new Set();

    for (let relIdx = 0; relIdx < state.db.relations.length; relIdx++) {
      const relName = state.db.relations[relIdx];
      let neighborIds = relations[relIdx];
      if (!neighborIds || !neighborIds.length) continue;

      if (settings.depth > 1) neighborIds = expandOnce(neighborIds);

      const wordsByLang = { english: new Map(), latin: new Map(), greek: new Map() };
      for (const nIdx of neighborIds) {
        if (seenNeighborIds.has(nIdx) && relName !== "hypernyms") continue;
        seenNeighborIds.add(nIdx);

        const ne = state.db.synsets[nIdx];
        const ne_eng = ne[3], ne_ell = ne[4];

        const consume = (text, lang) => {
          const norm = text.toLowerCase();
          if (norm === focusedWordLower) return;
          if (wordsByLang[lang].has(norm)) return;
          wordsByLang[lang].set(norm, lemmaPayload(text, lang));
        };

        for (const t of ne_eng) consume(t, "english");
        for (const t of ne_ell) consume(t, "greek");
        // latin: NLTK OMW does not ship Latin lemmas; intentionally empty.
      }

      const items = [];
      for (const lang of ["english", "latin", "greek"]) {
        let arr = Array.from(wordsByLang[lang].values());
        if (settings.limit && arr.length > settings.limit) arr = arr.slice(0, settings.limit);
        items.push(...arr);
      }
      if (items.length === 0) continue;

      sense.groups.push({
        id: `${name}::${relName}`,
        relation: relName,
        label: RELATION_LABELS[relName] || relName,
        items,
      });
    }

    return sense;
  }

  function buildGraph(word, settings) {
    const lower = word.trim().toLowerCase();
    if (!lower) return { word: "", senses: [], found: false };
    const senseIdxs = state.db.by_word[lower];
    if (!senseIdxs || !senseIdxs.length) return { word, senses: [], found: false };
    const senses = senseIdxs.map((idx) => buildSense(idx, lower, settings));
    return { word, senses, found: true };
  }

  // ----------------------- breadcrumbs -----------------------
  function pushCrumb(word) {
    word = word.trim().toLowerCase();
    if (!word) return;
    const existing = state.crumbs.findIndex((c) => c.word === word);
    if (existing !== -1) {
      state.cursor = existing;
    } else {
      state.crumbs = state.crumbs.slice(0, state.cursor + 1);
      state.crumbs.push({ word, senseIndex: 0 });
      state.cursor = state.crumbs.length - 1;
    }
    renderBreadcrumbs();
  }

  function renderBreadcrumbs() {
    breadcrumbsEl.innerHTML = "";
    state.crumbs.forEach((c, idx) => {
      const el = document.createElement("span");
      el.className = "crumb" + (idx === state.cursor ? " current" : "");
      el.textContent = c.word;
      el.title = idx === state.cursor ? "current focus" : "click to jump back";
      el.addEventListener("click", () => {
        if (idx === state.cursor) return;
        state.cursor = idx;
        focusWord(c.word, { skipPush: true });
      });
      breadcrumbsEl.appendChild(el);
      if (idx < state.crumbs.length - 1) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "›";
        breadcrumbsEl.appendChild(sep);
      }
    });
  }

  // ----------------------- focus / draw orchestration -----------------------
  let lastPayload = null;

  function focusWord(word, { skipPush = false } = {}) {
    word = word.trim();
    if (!word) return;
    const payload = buildGraph(word, state.settings);
    if (!payload.found || !payload.senses.length) {
      lastPayload = payload;
      state.currentWord = word;
      populateSenseSelect(payload);
      drawEmpty(word);
      if (!skipPush) pushCrumb(word);
      return;
    }
    if (!skipPush) pushCrumb(word);
    state.currentWord = word;
    state.currentSenseIdx = state.crumbs[state.cursor]?.senseIndex ?? 0;
    if (state.currentSenseIdx >= payload.senses.length) state.currentSenseIdx = 0;
    lastPayload = payload;
    populateSenseSelect(payload);
    drawGraph();
  }

  function populateSenseSelect(payload) {
    senseSelect.innerHTML = "";
    if (!payload || !payload.senses.length) {
      const opt = document.createElement("option");
      opt.textContent = "— none —";
      senseSelect.appendChild(opt);
      senseSelect.disabled = true;
      return;
    }
    senseSelect.disabled = false;
    payload.senses.forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      const def = s.definition.length > 60 ? s.definition.slice(0, 57) + "…" : s.definition;
      opt.textContent = `${i + 1}. (${s.pos}) ${def}`;
      senseSelect.appendChild(opt);
    });
    senseSelect.value = String(state.currentSenseIdx);
  }

  // ----------------------- drawing -----------------------
  function drawEmpty(word) {
    svg.selectAll("*").remove();
    const { width, height } = svg.node().getBoundingClientRect();
    svg
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#8b96a5")
      .text(`No WordNet entry for "${word}"`);
  }

  function visibleLemmas(items) {
    return items.filter((it) => {
      if (it.language === "english") return state.settings.showEng;
      if (it.language === "latin") return state.settings.showLat;
      if (it.language === "greek") return state.settings.showGrc;
      return true;
    });
  }

  function drawGraph() {
    svg.selectAll("*").remove();
    if (!lastPayload) return;
    const sense = lastPayload.senses[state.currentSenseIdx];
    if (!sense) return;

    const { width, height } = svg.node().getBoundingClientRect();
    const cx = width / 2;
    const cy = height / 2;

    const groups = sense.groups
      .map((g) => ({ ...g, items: visibleLemmas(g.items) }))
      .filter((g) => g.items.length > 0);

    const groupRing = Math.min(width, height) * 0.22;
    const lemmaRing = Math.min(width, height) * 0.18;

    const groupNodes = [];
    const lemmaNodes = [];
    const links = [];

    const G = groups.length || 1;
    groups.forEach((g, gi) => {
      const angle = (gi / G) * Math.PI * 2 - Math.PI / 2;
      const gx = cx + Math.cos(angle) * groupRing;
      const gy = cy + Math.sin(angle) * groupRing;
      const gNode = { id: g.id, kind: "group", x: gx, y: gy, label: g.label, relation: g.relation, size: 9 };
      groupNodes.push(gNode);
      links.push({ source: { x: cx, y: cy }, target: gNode, kind: "center-group" });

      const N = g.items.length;
      const arcSpan = Math.min(Math.PI * 0.9, 0.35 + N * 0.18);
      const startAngle = angle - arcSpan / 2;
      g.items.forEach((it, i) => {
        const t = N === 1 ? 0.5 : i / (N - 1);
        const a = startAngle + arcSpan * t;
        const r = lemmaRing + (i % 2) * 22;
        const lx = gx + Math.cos(a) * r;
        const ly = gy + Math.sin(a) * r;
        lemmaNodes.push({
          id: `${g.id}::${it.language}::${it.word}`,
          kind: "lemma",
          x: lx, y: ly,
          label: it.spoken,
          original: it.word,
          language: it.language,
          clickWord: it.clickWord,
          size: 5,
        });
        links.push({ source: gNode, target: lemmaNodes[lemmaNodes.length - 1], kind: "group-lemma" });
      });
    });

    const root = svg.append("g").attr("class", "viewport");
    svg.call(d3.zoom().scaleExtent([0.4, 2.5]).on("zoom", (e) => root.attr("transform", e.transform)));

    root.append("g")
      .selectAll("line")
      .data(links).enter().append("line")
      .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y)
      .attr("stroke", (d) => (d.kind === "center-group" ? "#3a4658" : "#2c3441"))
      .attr("stroke-width", (d) => (d.kind === "center-group" ? 1.4 : 0.9));

    const centerG = root.append("g").attr("transform", `translate(${cx}, ${cy})`);
    centerG.append("circle").attr("r", 26).attr("fill", "#1f2630").attr("stroke", "#f6e58d").attr("stroke-width", 2);
    centerG.append("text").attr("class", "center-label").attr("text-anchor", "middle").attr("dy", "0.35em").attr("fill", "#f6e58d").text(state.currentWord);

    const gSel = root.append("g").selectAll("g")
      .data(groupNodes).enter().append("g")
      .attr("transform", (d) => `translate(${d.x}, ${d.y})`);
    gSel.append("circle").attr("r", (d) => d.size).attr("fill", "#4ec9a8").attr("stroke", "#1f2630").attr("stroke-width", 2);
    gSel.append("text").attr("class", "group-label").attr("text-anchor", "middle").attr("dy", -14).attr("fill", "#9ad6c1").text((d) => d.label);

    const lSel = root.append("g").selectAll("g")
      .data(lemmaNodes).enter().append("g")
      .attr("transform", (d) => `translate(${d.x}, ${d.y})`)
      .style("cursor", "pointer")
      .on("click", (event, d) => focusWord(d.clickWord));
    lSel.append("circle").attr("r", (d) => d.size).attr("class", (d) => `lemma-${langCode(d.language)}`).attr("stroke", "#0e1116").attr("stroke-width", 1.5);
    lSel.append("text").attr("class", "node-label").attr("text-anchor", "middle").attr("dy", -10).attr("fill", "#e6edf3").text((d) => d.label);
    lSel.filter((d) => d.original !== d.label).append("text").attr("class", "node-sub").attr("text-anchor", "middle").attr("dy", 16).text((d) => d.original);
  }

  function langCode(name) {
    if (name === "english") return "eng";
    if (name === "latin") return "lat";
    if (name === "greek") return "grc";
    return "eng";
  }

  // ----------------------- autocomplete -----------------------
  function lowerBound(prefix) {
    const arr = state.sortedWords;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < prefix) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function autocompleteMatches(prefix, n) {
    if (!state.db) return [];
    const start = lowerBound(prefix);
    const out = [];
    for (let i = start; i < state.sortedWords.length && out.length < n; i++) {
      const w = state.sortedWords[i];
      if (!w.startsWith(prefix)) break;
      out.push(w);
    }
    return out;
  }

  let acTimer = null;
  function refreshAutocomplete() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { hideAutocomplete(); return; }
    clearTimeout(acTimer);
    acTimer = setTimeout(() => {
      renderAutocomplete(autocompleteMatches(q, 12));
    }, 30);
  }

  function renderAutocomplete(items) {
    state.autocomplete.items = items;
    state.autocomplete.active = -1;
    if (!items.length) { hideAutocomplete(); return; }
    acEl.innerHTML = "";
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.textContent = it;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); chooseAutocomplete(i); });
      acEl.appendChild(li);
    });
    acEl.classList.remove("hidden");
  }

  function hideAutocomplete() {
    acEl.classList.add("hidden");
    state.autocomplete.items = [];
    state.autocomplete.active = -1;
  }

  function moveAutocomplete(dir) {
    if (!state.autocomplete.items.length) return;
    const total = state.autocomplete.items.length;
    state.autocomplete.active = (state.autocomplete.active + dir + total) % total;
    [...acEl.children].forEach((li, i) => {
      li.classList.toggle("active", i === state.autocomplete.active);
    });
  }

  function chooseAutocomplete(i) {
    const word = state.autocomplete.items[i];
    if (!word) return;
    searchInput.value = word;
    hideAutocomplete();
    focusWord(word);
  }

  // ----------------------- wiring -----------------------
  function bindUI() {
    searchInput.addEventListener("input", refreshAutocomplete);
    searchInput.addEventListener("focus", refreshAutocomplete);
    searchInput.addEventListener("blur", () => setTimeout(hideAutocomplete, 120));
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveAutocomplete(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveAutocomplete(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (state.autocomplete.active >= 0) chooseAutocomplete(state.autocomplete.active);
        else {
          const v = searchInput.value.trim();
          if (v) { hideAutocomplete(); focusWord(v); }
        }
      } else if (e.key === "Escape") hideAutocomplete();
    });
    searchBtn.addEventListener("click", () => {
      const v = searchInput.value.trim();
      if (v) focusWord(v);
    });

    const limitEl = $("#setting-limit");
    const limitOut = $("#setting-limit-out");
    limitEl.addEventListener("input", () => {
      state.settings.limit = +limitEl.value;
      limitOut.textContent = limitEl.value;
    });
    limitEl.addEventListener("change", () => {
      if (state.crumbs.length) focusWord(state.crumbs[state.cursor].word, { skipPush: true });
    });

    const depthEl = $("#setting-depth");
    const depthOut = $("#setting-depth-out");
    depthEl.addEventListener("input", () => {
      state.settings.depth = +depthEl.value;
      depthOut.textContent = depthEl.value;
    });
    depthEl.addEventListener("change", () => {
      if (state.crumbs.length) focusWord(state.crumbs[state.cursor].word, { skipPush: true });
    });

    senseSelect.addEventListener("change", () => {
      state.currentSenseIdx = +senseSelect.value || 0;
      if (state.crumbs[state.cursor]) state.crumbs[state.cursor].senseIndex = state.currentSenseIdx;
      drawGraph();
    });

    $("#setting-show-eng").addEventListener("change", (e) => { state.settings.showEng = e.target.checked; drawGraph(); });
    $("#setting-show-lat").addEventListener("change", (e) => { state.settings.showLat = e.target.checked; drawGraph(); });
    $("#setting-show-grc").addEventListener("change", (e) => { state.settings.showGrc = e.target.checked; drawGraph(); });

    window.addEventListener("resize", () => { if (lastPayload) drawGraph(); });
  }

  // ----------------------- boot -----------------------
  bindUI();
  loadDB()
    .then(() => focusWord("king"))
    .catch((err) => setStatus(`failed to load data: ${err.message || err}`));
})();
