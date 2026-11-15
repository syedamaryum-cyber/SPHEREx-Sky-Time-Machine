(() => {
  const root = document.getElementById("time-machine");
  if (!root) return;

  const style = document.createElement("style");
  style.textContent = `
    .timeline-panel{margin:14px 0 16px;padding:15px;background:linear-gradient(120deg,#0b1d2a,#11182b);border:1px solid #31516b;border-radius:12px}
    .timeline-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    .timeline-heading strong{display:block;color:#dff8ff;font-size:14px;letter-spacing:.02em}
    .timeline-heading span{display:block;color:#8faac2;font-size:11px}
    .timeline-index{font:700 12px ui-monospace,monospace!important;color:#67e8f9!important;white-space:nowrap}
    .timeline-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .timeline-actions button{border:1px solid #34546a;border-radius:7px;padding:8px 11px;background:#10283a;color:#d9f5ff;font:700 12px inherit;cursor:pointer}
    .timeline-actions button:disabled{opacity:.4;cursor:not-allowed}
    .timeline-actions label{margin:0 0 0 6px;color:#9db4c9;font-size:11px}
    .timeline-actions select{width:auto;min-width:210px;max-width:100%;padding:8px;background:#081221;border:1px solid #30445f;border-radius:7px;color:#edf4ff;font-size:12px}
    #timeline-range{display:block;width:100%;margin:14px 0 7px;accent-color:#67e8f9;cursor:pointer}
    .timeline-caption{color:#d5e3f6;font:12px ui-monospace,monospace;overflow-wrap:anywhere}
    .timeline-caption[data-state="loading"]{color:#ffd18a}
    .timeline-caption[data-state="error"]{color:#ffb18b}
    .timeline-note{margin-top:8px;color:#819bb4;font-size:10px;line-height:1.45}
    .timeline-failures{margin-top:9px;border:1px solid #704a3b;border-radius:8px;background:#211914;color:#ffd2b5;font-size:11px}
    .timeline-failures summary{padding:8px 10px;cursor:pointer}
    .timeline-failures ul{margin:0;padding:0 28px 10px;max-height:180px;overflow:auto}
    .timeline-failures li{margin:5px 0;overflow-wrap:anywhere}
    @media(max-width:600px){.timeline-actions label{margin-left:0}.timeline-actions select{flex:1;min-width:150px}}
  `;
  document.head.appendChild(style);

  const range = document.getElementById("timeline-range");
  const previous = document.getElementById("timeline-prev");
  const play = document.getElementById("timeline-play");
  const next = document.getElementById("timeline-next");
  const productSelect = document.getElementById("timeline-product");
  const modeSelect = document.getElementById("timeline-mode");
  const summary = document.getElementById("timeline-summary");
  const indexLabel = document.getElementById("timeline-index");
  const caption = document.getElementById("timeline-caption");
  const failurePanel = document.createElement("details");
  failurePanel.className = "timeline-failures";
  failurePanel.hidden = true;
  failurePanel.innerHTML = '<summary>Failed observations · <span>0</span></summary><ul></ul>';
  caption.insertAdjacentElement("afterend", failurePanel);
  const failureCount = failurePanel.querySelector("summary span");
  const failureList = failurePanel.querySelector("ul");

  let epochs = [];
  let allEpochs = [];
  let activeIndex = 0;
  let activeProduct = 0;
  let searchCoordinates = null;
  let playing = false;
  let playbackToken = 0;
  let selectionToken = 0;
  let failedEpochs = new Map();

  function renderFailures() {
    failurePanel.hidden = failedEpochs.size === 0;
    failureCount.textContent = String(failedEpochs.size);
    failureList.replaceChildren();
    for (const item of failedEpochs.values()) {
      const li = document.createElement("li");
      li.textContent = item.label + " — " + item.errors.join(" | ");
      failureList.appendChild(li);
    }
  }

  const number = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  function productLabel(record, position) {
    const band = record.energy_bandpassname || record.band || record.instrument_name || ("Product " + (position + 1));
    const low = number(record.em_min);
    const high = number(record.em_max);
    if (low !== null && high !== null && low > 0 && high > 0) {
      return band + " · " + (low * 1e6).toFixed(3) + "–" + (high * 1e6).toFixed(3) + " μm";
    }
    return String(band);
  }

  function utcFromMjd(mjd) {
    if (mjd === null) return "UTC time unavailable";
    const date = new Date((mjd - 40587) * 86400000);
    return Number.isNaN(date.getTime())
      ? "UTC time unavailable"
      : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  }

  function stopPlayback() {
    playing = false;
    playbackToken++;
    play.textContent = "▶ Play";
  }

  function buildEpochs(rows) {
    const usable = rows.filter(row =>
      row && typeof row.access_url === "string" &&
      /^https:\/\/irsa\.ipac\.caltech\.edu\/ibe\/data\/spherex\//i.test(row.access_url) &&
      number(row.t_min ?? row.mjd_obs ?? row.mjd) !== null
    );

    const groups = new Map();
    for (const row of usable) {
      const mjd = number(row.t_min ?? row.mjd_obs ?? row.mjd);
      const observationId = row.obs_id || row.obs_publisher_did || null;
      const key = observationId ? "obs:" + observationId : "mjd:" + mjd.toFixed(8);
      if (!groups.has(key)) groups.set(key, { observationId, mjd, products: [] });
      const group = groups.get(key);
      group.mjd = Math.min(group.mjd, mjd);
      group.products.push(row);
    }

    return [...groups.values()]
      .map(epoch => ({
        ...epoch,
        products: epoch.products.sort((a, b) =>
          (number(a.em_min) ?? Infinity) - (number(b.em_min) ?? Infinity)
        )
      }))
      .sort((a, b) => a.mjd - b.mjd);
  }

  const preloadQueue = [];
  const queuedPreloads = new Set();
  let preloadWorkersRunning = 0;
  const PRELOAD_WORKERS = 2;

  function runPreloadWorkers() {
    while (preloadWorkersRunning < PRELOAD_WORKERS && preloadQueue.length) {
      const job = preloadQueue.shift();
      preloadWorkersRunning++;
      Promise.resolve(window.SpherexViewer.preloadRecord(job.record, job.coordinates))
        .catch(error => console.warn("Timeline preload failed:", error))
        .finally(() => {
          preloadWorkersRunning--;
          runPreloadWorkers();
        });
    }
  }

  function preloadUpcoming(index) {
    if (!window.SpherexViewer?.preloadRecord || epochs.length < 2) return;

    // Keep only a short look-ahead. Preloading the entire timeline can
    // launch more than a hundred archive requests for a single search.
    const lookAhead = Math.min(2, epochs.length - 1);
    for (let offset = 1; offset <= lookAhead; offset++) {
      const epoch = epochs[index + offset];
      if (!epoch) continue;
      const record = epoch?.products?.[0];
      const key = record?.access_url + "|" + searchCoordinates.ra + "|" + searchCoordinates.dec;
      if (record && record.access_url && !queuedPreloads.has(key)) {
        queuedPreloads.add(key);
        preloadQueue.push({ record, key, coordinates: { ...searchCoordinates } });
      }
    }
    runPreloadWorkers();
  }

  function chooseSequence(source, mode) {
    if (mode === "all" || source.length <= 12) return source.slice();
    const count = 12;
    const chosen = [];
    for (let i = 0; i < count; i++) {
      const index = Math.round(i * (source.length - 1) / (count - 1));
      if (!chosen.length || chosen[chosen.length - 1] !== source[index]) chosen.push(source[index]);
    }
    return chosen;
  }

  function productIdentity(record) {
    return String(record.energy_bandpassname || record.band || record.instrument_name || "")
      .trim().toLowerCase();
  }

  async function selectEpoch(index, productIndex = null, direction = 1) {
    if (!epochs.length) return false;
    const previousEpoch = epochs[activeIndex];
    const previousRecord = previousEpoch?.products?.[activeProduct];
    const preferredProduct = productIdentity(previousRecord);
    const token = ++selectionToken;
    const step = direction < 0 ? -1 : 1;
    const firstIndex = (index + epochs.length) % epochs.length;

    summary.textContent = epochs.length + " playback epochs · " + allEpochs.length +
      " total archive epochs · " + allEpochs.reduce((total, item) => total + item.products.length, 0) + " FITS products";

    for (let offset = 0; offset < epochs.length; offset++) {
      const epochIndex = (firstIndex + step * offset + epochs.length * 2) % epochs.length;
      const epoch = epochs[epochIndex];
      if (!epoch?.products?.length) continue;

      activeIndex = epochIndex;
      const matchingProduct = preferredProduct
        ? epoch.products.findIndex(item => productIdentity(item) === preferredProduct)
        : -1;
      const requestedProduct = offset === 0 && productIndex !== null && productIndex !== undefined
        ? Math.max(0, Math.min(epoch.products.length - 1, productIndex))
        : (matchingProduct >= 0 ? matchingProduct : 0);

      const productOrder = [
        requestedProduct,
        ...epoch.products.map((_, i) => i).filter(i => i !== requestedProduct)
      ];

      range.value = String(activeIndex);
      indexLabel.textContent = (activeIndex + 1) + " / " + epochs.length;
      caption.textContent =
        utcFromMjd(epoch.mjd) + " · MJD " + epoch.mjd.toFixed(6) +
        (epoch.observationId ? " · " + epoch.observationId : "");
      productSelect.innerHTML = "";
      epoch.products.forEach((item, i) => {
        const option = document.createElement("option");
        option.value = String(i);
        option.textContent = productLabel(item, i);
        productSelect.appendChild(option);
      });

      root.dataset.loading = "true";
      caption.dataset.state = "loading";
      let loaded = false;
      let loadedProduct = -1;
      const attemptErrors = [];

      for (const candidate of productOrder) {
        if (token !== selectionToken) return false;
        activeProduct = candidate;
        productSelect.value = String(candidate);
        loaded = await window.SpherexViewer.loadRecord(epoch.products[candidate], searchCoordinates, {
          quiet: true,
          onError: error => attemptErrors.push(productLabel(epoch.products[candidate], candidate) + ": " + (error?.message || String(error)))
        });
        if (token !== selectionToken) return false;
        if (loaded) {
          loadedProduct = candidate;
          break;
        }
      }

      root.dataset.loading = "false";
      if (loaded) {
        caption.dataset.state = "loaded";
        if (loadedProduct !== requestedProduct) {
          caption.textContent += " · preferred product unavailable; loaded another product.";
        }
        if (offset > 0) {
          caption.textContent += " · skipped " + offset + " unavailable epoch" + (offset === 1 ? "" : "s") + ".";
        }
        preloadUpcoming(activeIndex);
        return true;
      }

      // Preserve the failure details for later inspection while keeping
      // failed frames out of the visible playback sequence.
      const failureKey = epoch.observationId || String(epoch.mjd);
      failedEpochs.set(failureKey, {
        label: utcFromMjd(epoch.mjd) + (epoch.observationId ? " · " + epoch.observationId : ""),
        errors: attemptErrors.length ? attemptErrors : ["No usable FITS product returned."]
      });
      renderFailures();
    }

    root.dataset.loading = "false";
    caption.dataset.state = "error";
    caption.textContent = "No loadable FITS observations were found in this sequence. The archive records remain available in the results table.";
    return false;
  }

  const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));

  async function advance(token) {
    // A single controlled loop avoids recursive playback races and continues
    // only after the current FITS request has settled.
    while (playing && token === playbackToken && epochs.length > 1) {
      const nextIndex = (activeIndex + 1) % epochs.length;
      const loaded = await selectEpoch(nextIndex, null, 1);
      if (!playing || token !== playbackToken) return;
      if (!loaded) {
        stopPlayback();
        caption.dataset.state = "error";
        caption.textContent = "Playback stopped: no loadable FITS observations remain.";
        return;
      }
      await wait(1100);
    }
  }

  function setTimeline(rows, ra, dec) {
    stopPlayback();
    selectionToken++;
    preloadQueue.length = 0;
    queuedPreloads.clear();
    allEpochs = buildEpochs(Array.isArray(rows) ? rows : []);
    failedEpochs = new Map();
    renderFailures();
    modeSelect.value = "highlights";
    epochs = chooseSequence(allEpochs, "highlights");
    searchCoordinates = { ra, dec };
    activeIndex = 0;
    activeProduct = 0;

    if (!allEpochs.length) {
      root.hidden = true;
      return;
    }

    root.hidden = false;
    modeSelect.disabled = allEpochs.length <= 1;
    range.min = "0";
    range.max = String(epochs.length - 1);
    range.value = "0";
    range.disabled = epochs.length < 2;
    previous.disabled = epochs.length < 2;
    next.disabled = epochs.length < 2;
    play.disabled = epochs.length < 2;
    productSelect.disabled = false;
    selectEpoch(0, 0, 1);
  }

  modeSelect.addEventListener("change", () => {
    stopPlayback();
    epochs = chooseSequence(allEpochs, modeSelect.value);
    activeIndex = 0;
    range.max = String(epochs.length - 1);
    range.value = "0";
    range.disabled = epochs.length < 2;
    previous.disabled = epochs.length < 2;
    next.disabled = epochs.length < 2;
    play.disabled = epochs.length < 2;
    selectEpoch(0, 0, 1);
  });

  previous.addEventListener("click", () => {
    stopPlayback();
    selectEpoch((activeIndex - 1 + epochs.length) % epochs.length, null, -1);
  });

  next.addEventListener("click", () => {
    stopPlayback();
    selectEpoch((activeIndex + 1) % epochs.length, null, 1);
  });

  range.addEventListener("change", () => {
    stopPlayback();
    selectEpoch(Number(range.value), null, 1);
  });

  productSelect.addEventListener("change", () => {
    stopPlayback();
    selectEpoch(activeIndex, Number(productSelect.value), 1);
  });

  play.addEventListener("click", () => {
    if (playing) {
      stopPlayback();
      return;
    }
    if (epochs.length < 2) return;
    playing = true;
    play.textContent = "Ⅱ Pause";
    const token = ++playbackToken;
    advance(token);
  });

  window.addEventListener("spherex:search-results", event => {
    const detail = event.detail || {};
    setTimeline(detail.rows, detail.ra, detail.dec);
  });
})();