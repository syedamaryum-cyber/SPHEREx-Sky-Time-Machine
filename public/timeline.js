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
    @media(max-width:600px){.timeline-actions label{margin-left:0}.timeline-actions select{flex:1;min-width:150px}}
  `;
  document.head.appendChild(style);

  const range = document.getElementById("timeline-range");
  const previous = document.getElementById("timeline-prev");
  const play = document.getElementById("timeline-play");
  const next = document.getElementById("timeline-next");
  const productSelect = document.getElementById("timeline-product");
  const summary = document.getElementById("timeline-summary");
  const indexLabel = document.getElementById("timeline-index");
  const caption = document.getElementById("timeline-caption");

  let epochs = [];
  let activeIndex = 0;
  let activeProduct = 0;
  let searchCoordinates = null;
  let playing = false;
  let playbackToken = 0;
  let selectionToken = 0;

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
  const PRELOAD_WORKERS = 1;

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
    const lookAhead = Math.min(1, epochs.length - 1);
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

    summary.textContent = epochs.length + " observing epochs · " +
      epochs.reduce((total, item) => total + item.products.length, 0) + " FITS products";

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

      for (const candidate of productOrder) {
        if (token !== selectionToken) return false;
        activeProduct = candidate;
        productSelect.value = String(candidate);
        loaded = await window.SpherexViewer.loadRecord(epoch.products[candidate], searchCoordinates);
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

      caption.dataset.state = "error";
      caption.textContent += " · observation unavailable; automatically trying the next epoch…";
    }

    root.dataset.loading = "false";
    caption.dataset.state = "error";
    caption.textContent = "No loadable FITS observations were found in this timeline. Try another target or search range.";
    return false;
  }

  async function advance(token) {
    if (!playing || token !== playbackToken) return;
    const nextIndex = (activeIndex + 1) % epochs.length;
    const loaded = await selectEpoch(nextIndex, null, 1);
    if (!playing || token !== playbackToken) return;
    if (!loaded) {
      stopPlayback();
      caption.dataset.state = "error";
      caption.textContent = "Playback stopped: no loadable FITS images were found in this timeline.";
      return;
    }
    window.setTimeout(() => advance(token), 900);
  }

  function setTimeline(rows, ra, dec) {
    stopPlayback();
    selectionToken++;
    preloadQueue.length = 0;
    queuedPreloads.clear();
    epochs = buildEpochs(Array.isArray(rows) ? rows : []);
    searchCoordinates = { ra, dec };
    activeIndex = 0;
    activeProduct = 0;

    if (!epochs.length) {
      root.hidden = true;
      return;
    }

    root.hidden = false;
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