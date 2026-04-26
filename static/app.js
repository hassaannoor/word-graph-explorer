(() => {
  const state = {
    crumbs: [],          // [{word, senseIndex}]
    cursor: -1,          // index into crumbs of the currently focused entry
    currentData: null,   // last graph payload from /api/graph
    currentSense: 0,
    settings: {
      limit: 10,
      depth: 1,
      showEng: true,
      showLat: true,
      showGrc: true,
    },
    autocomplete: { items: [], active: -1 },
    fetchToken: 0,
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

  // ---------- breadcrumbs ----------
  function pushCrumb(word) {
    word = word.trim().toLowerCase();
    if (!word) return;
    // If the word already exists earlier in the breadcrumb chain, rewind to it
    // instead of appending a duplicate.
    const existing = state.crumbs.findIndex((c) => c.word === word);
    if (existing !== -1) {
      state.cursor = existing;
      // Do NOT truncate the trailing crumbs: keep them as forward history.
    } else {
      // Trim any forward history when starting a new branch.
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
        loadWord(c.word, { skipPush: true });
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

  // ---------- data loading ----------
  async function loadWord(word, { skipPush = false } = {}) {
    word = word.trim();
    if (!word) return;
    setStatus(`loading "${word}"…`);

    const params = new URLSearchParams({
      word,
      limit: String(state.settings.limit),
      max_depth: String(state.settings.depth),
    });

    const myToken = ++state.fetchToken;
    let payload;
    try {
      const res = await fetch(`/api/graph?${params.toString()}`);
      payload = await res.json();
    } catch (err) {
      setStatus(`error loading: ${err.message || err}`);
      return;
    }
    if (myToken !== state.fetchToken) return; // a newer request superseded us

    if (!payload.found || !payload.senses.length) {
      setStatus(`no WordNet entry for "${word}"`);
      state.currentData = payload;
      state.currentSense = 0;
      populateSenseSelect();
      drawEmpty(word);
      if (!skipPush) pushCrumb(word);
      return;
    }

    setStatus("");
    state.currentData = payload;
    if (!skipPush) pushCrumb(word);
    state.currentSense = state.crumbs[state.cursor]?.senseIndex ?? 0;
    if (state.currentSense >= payload.senses.length) state.currentSense = 0;
    populateSenseSelect();
    drawGraph();
  }

  function populateSenseSelect() {
    senseSelect.innerHTML = "";
    if (!state.currentData || !state.currentData.senses.length) {
      const opt = document.createElement("option");
      opt.textContent = "— none —";
      senseSelect.appendChild(opt);
      senseSelect.disabled = true;
      return;
    }
    senseSelect.disabled = false;
    state.currentData.senses.forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      const def = s.definition.length > 60 ? s.definition.slice(0, 57) + "…" : s.definition;
      opt.textContent = `${i + 1}. (${s.pos}) ${def}`;
      senseSelect.appendChild(opt);
    });
    senseSelect.value = String(state.currentSense);
  }

  // ---------- drawing ----------
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
    if (!state.currentData) return;
    const sense = state.currentData.senses[state.currentSense];
    if (!sense) return;

    const { width, height } = svg.node().getBoundingClientRect();
    const cx = width / 2;
    const cy = height / 2;

    // Layout: center node = focused word.
    // Around it, group nodes for each relation type, evenly spaced.
    // Around each group node, lemma nodes fanning outward.
    const groups = sense.groups
      .map((g) => ({ ...g, items: visibleLemmas(g.items) }))
      .filter((g) => g.items.length > 0);

    // arrange groups on a circle around the center.
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
      const gNode = {
        id: g.id,
        kind: "group",
        x: gx,
        y: gy,
        label: g.label,
        relation: g.relation,
        size: 9,
      };
      groupNodes.push(gNode);
      links.push({ source: { x: cx, y: cy }, target: gNode, kind: "center-group" });

      const N = g.items.length;
      // distribute lemmas in an arc on the outside of the group node, centered
      // on the radial direction (away from the center).
      const arcSpan = Math.min(Math.PI * 0.9, 0.35 + N * 0.18);
      const startAngle = angle - arcSpan / 2;
      g.items.forEach((it, i) => {
        const t = N === 1 ? 0.5 : i / (N - 1);
        const a = startAngle + arcSpan * t;
        const r = lemmaRing + (i % 2) * 22;
        const lx = gx + Math.cos(a) * r;
        const ly = gy + Math.sin(a) * r;
        const lNode = {
          id: `${g.id}::${it.language}::${it.word}`,
          kind: "lemma",
          x: lx,
          y: ly,
          label: it.spoken,
          original: it.word,
          language: it.language,
          clickWord: it.click_word,
          size: 5,
        };
        lemmaNodes.push(lNode);
        links.push({ source: gNode, target: lNode, kind: "group-lemma" });
      });
    });

    // ---------- render ----------
    // Group + drag to pan.
    const root = svg
      .append("g")
      .attr("class", "viewport");

    svg.call(
      d3
        .zoom()
        .scaleExtent([0.4, 2.5])
        .on("zoom", (e) => root.attr("transform", e.transform))
    );

    // links
    root
      .append("g")
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y)
      .attr("stroke", (d) => (d.kind === "center-group" ? "#3a4658" : "#2c3441"))
      .attr("stroke-width", (d) => (d.kind === "center-group" ? 1.4 : 0.9));

    // center
    const centerG = root
      .append("g")
      .attr("transform", `translate(${cx}, ${cy})`);
    centerG
      .append("circle")
      .attr("r", 26)
      .attr("fill", "#1f2630")
      .attr("stroke", "var(--center)")
      .attr("stroke", "#f6e58d")
      .attr("stroke-width", 2);
    centerG
      .append("text")
      .attr("class", "center-label")
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("fill", "#f6e58d")
      .text(state.currentData.word);

    // group nodes
    const gSel = root
      .append("g")
      .selectAll("g")
      .data(groupNodes)
      .enter()
      .append("g")
      .attr("transform", (d) => `translate(${d.x}, ${d.y})`);
    gSel
      .append("circle")
      .attr("r", (d) => d.size)
      .attr("fill", "#4ec9a8")
      .attr("stroke", "#1f2630")
      .attr("stroke-width", 2);
    gSel
      .append("text")
      .attr("class", "group-label")
      .attr("text-anchor", "middle")
      .attr("dy", -14)
      .attr("fill", "#9ad6c1")
      .text((d) => d.label);

    // lemma nodes
    const lSel = root
      .append("g")
      .selectAll("g")
      .data(lemmaNodes)
      .enter()
      .append("g")
      .attr("transform", (d) => `translate(${d.x}, ${d.y})`)
      .style("cursor", "pointer")
      .on("click", (event, d) => {
        loadWord(d.clickWord);
      });
    lSel
      .append("circle")
      .attr("r", (d) => d.size)
      .attr("class", (d) => `lemma-${langCode(d.language)}`)
      .attr("stroke", "#0e1116")
      .attr("stroke-width", 1.5);
    lSel
      .append("text")
      .attr("class", "node-label")
      .attr("text-anchor", "middle")
      .attr("dy", -10)
      .attr("fill", "#e6edf3")
      .text((d) => d.label);
    lSel
      .filter((d) => d.original !== d.label)
      .append("text")
      .attr("class", "node-sub")
      .attr("text-anchor", "middle")
      .attr("dy", 16)
      .text((d) => d.original);
  }

  function langCode(name) {
    if (name === "english") return "eng";
    if (name === "latin") return "lat";
    if (name === "greek") return "grc";
    return "eng";
  }

  // ---------- autocomplete ----------
  let acTimer = null;
  function refreshAutocomplete() {
    const q = searchInput.value.trim();
    if (!q) {
      hideAutocomplete();
      return;
    }
    clearTimeout(acTimer);
    acTimer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/autocomplete?q=${encodeURIComponent(q)}&n=12`
        );
        const data = await res.json();
        renderAutocomplete(data.matches || []);
      } catch (_) {
        hideAutocomplete();
      }
    }, 110);
  }

  function renderAutocomplete(items) {
    state.autocomplete.items = items;
    state.autocomplete.active = -1;
    if (!items.length) {
      hideAutocomplete();
      return;
    }
    acEl.innerHTML = "";
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.textContent = it;
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        chooseAutocomplete(i);
      });
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
    loadWord(word);
  }

  // ---------- wiring ----------
  function bindUI() {
    searchInput.addEventListener("input", refreshAutocomplete);
    searchInput.addEventListener("focus", refreshAutocomplete);
    searchInput.addEventListener("blur", () => setTimeout(hideAutocomplete, 120));
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveAutocomplete(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveAutocomplete(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (state.autocomplete.active >= 0) {
          chooseAutocomplete(state.autocomplete.active);
        } else {
          const v = searchInput.value.trim();
          if (v) {
            hideAutocomplete();
            loadWord(v);
          }
        }
      } else if (e.key === "Escape") {
        hideAutocomplete();
      }
    });
    searchBtn.addEventListener("click", () => {
      const v = searchInput.value.trim();
      if (v) loadWord(v);
    });

    const limitEl = $("#setting-limit");
    const limitOut = $("#setting-limit-out");
    limitEl.addEventListener("input", () => {
      state.settings.limit = +limitEl.value;
      limitOut.textContent = limitEl.value;
    });
    limitEl.addEventListener("change", () => {
      if (state.crumbs.length) loadWord(state.crumbs[state.cursor].word, { skipPush: true });
    });

    const depthEl = $("#setting-depth");
    const depthOut = $("#setting-depth-out");
    depthEl.addEventListener("input", () => {
      state.settings.depth = +depthEl.value;
      depthOut.textContent = depthEl.value;
    });
    depthEl.addEventListener("change", () => {
      if (state.crumbs.length) loadWord(state.crumbs[state.cursor].word, { skipPush: true });
    });

    senseSelect.addEventListener("change", () => {
      state.currentSense = +senseSelect.value || 0;
      if (state.crumbs[state.cursor]) {
        state.crumbs[state.cursor].senseIndex = state.currentSense;
      }
      drawGraph();
    });

    $("#setting-show-eng").addEventListener("change", (e) => {
      state.settings.showEng = e.target.checked;
      drawGraph();
    });
    $("#setting-show-lat").addEventListener("change", (e) => {
      state.settings.showLat = e.target.checked;
      drawGraph();
    });
    $("#setting-show-grc").addEventListener("change", (e) => {
      state.settings.showGrc = e.target.checked;
      drawGraph();
    });

    window.addEventListener("resize", () => {
      if (state.currentData) drawGraph();
    });
  }

  bindUI();
  // Boot with a sample word so the canvas isn't empty on first paint.
  loadWord("king");
})();
