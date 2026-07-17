(function(){
  'use strict';

  const CFG = {
    nodeRadius: 46,
    edgeLength: 300,          // spring rest length
    repulsion: 300000,        // higher = airier layout, nodes hold each other further off
    spring: 0.02,
    damping: 0.86,
    centerPull: 0.005,        // the only thing stopping the graph drifting away for good
    focusPull: 0.022,         // pulls the clip we are playing towards the middle
    maxCycleLength: 6,        // longest loop we detect for click-to-repeat

    // How early to start the next clip, in seconds. A video element takes a few
    // frames to actually begin playing, and if we only start it once the current
    // clip has ended, that startup shows as a frozen frame. Starting it this far
    // ahead hides the startup behind the tail of the outgoing clip. The cost is
    // that we may cut up to this much off that tail — at 80ms, invisible.
    preroll: 0.08,

    // Autoplay: score = loopLength + recencyWeight / (1 + clipsSincePlayed).
    // Lowest score wins, ties broken at random. A clip is never played twice in
    // a row while another option exists.
    noLoopScore: 99,          // an edge you cannot get back from
    recencyWeight: 2.5,       // >0 stops the graph settling into one tight loop
  };

  let G = { nodes: [], edges: [], byId: {}, out: {}, dist: {} };
  let cycles = [];

  const play = {
    edge: null,               // edge currently on screen
    progress: 0,              // 0..1 through that edge
    queue: [],                // user-queued edges, played in order
    loop: null,               // cycle we are locked to, if any
    loopAt: 0,
    next: null,               // the edge we have committed to (and preloaded)
    history: [],              // edge ids, most recent last
    parked: null,             // node we are stopped on
    paused: false,
    repeat: false,            // Loop toggle: replay the current clip, never move on
  };

  const svg = document.getElementById('graph');
  const scene = document.getElementById('scene');
  const layers = {
    loops: document.getElementById('layer-loops'),
    edges: document.getElementById('layer-edges'),
    nodes: document.getElementById('layer-nodes'),
  };

  // Viewport. Node coordinates are world coordinates and are never clamped to
  // the window; this transform is the only thing that decides what you can see.
  const view = { x: 0, y: 0, k: 1 };
  const applyView = () => scene.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);

  // Until you pan or zoom, the camera keeps the whole graph framed by itself —
  // otherwise an unclamped node could wander off with no way to find it again.
  // Any manual pan/zoom hands control over to you; Fit takes it back.
  let autoFit = true;
  const videos = [document.getElementById('video-a'), document.getElementById('video-b')];
  let live = 0;
  let handing = false;        // a hand-over is in flight: the next clip is already rolling
  let hover = { node: null, edge: null, loop: null };
  let W = 0, H = 0;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* --------------------------------------------------------------- graph */

  async function loadGraph() {
    // Pull the whole library, then build this graph by resolving each node/edge's
    // item id to a served media URL. A graph lives in media.graphs — pick the one
    // named in ?graph=, else the first.
    const media = await (await fetch('/api/media')).json();
    const byItem = {};
    for (const it of media.items || []) byItem[it.id] = it;
    const urlOf = (id) => (byItem[id] ? byItem[id].url : null);

    const graphs = media.graphs || {};
    const names = Object.keys(graphs);
    const want = new URLSearchParams(location.search).get('graph');
    const gname = want && graphs[want] ? want : names[0];
    const g = gname ? graphs[gname] : { nodes: [], edges: [] };

    const title = (g && g.title) || gname || 'Video Graph';
    document.getElementById('graph-title').textContent = names.length ? title : 'No graph defined';
    document.title = title;

    // Switcher — shown only when there's more than one graph. Changing it
    // reloads with ?graph=<name> so playback state resets cleanly.
    const sw = document.getElementById('graph-switcher');
    if (sw) {
      if (names.length > 1) {
        sw.innerHTML = '';
        for (const n of names) {
          const o = document.createElement('option');
          o.value = n;
          o.textContent = (graphs[n] && graphs[n].title) || n;
          if (n === gname) o.selected = true;
          sw.appendChild(o);
        }
        sw.hidden = false;
        sw.onchange = () => { location.search = '?graph=' + encodeURIComponent(sw.value); };
      } else {
        sw.hidden = true;
      }
    }

    G.nodes = (g.nodes || []).map((n) => ({
      id: n.id, name: n.name || n.id, image: urlOf(n.item),
      x: 0, y: 0, vx: 0, vy: 0,
    }));
    // An edge with no item is a jump cut (no clip) — the viewer already handles
    // a null video that way.
    G.edges = (g.edges || []).map((e) => ({
      id: e.id, name: e.name || e.id, from: e.from, to: e.to,
      video: e.item ? urlOf(e.item) : null,
    }));
    G.byId = {};
    G.out = {};

    for (const n of G.nodes) { G.byId[n.id] = n; G.out[n.id] = []; }
    for (const e of G.edges) {
      if (!G.byId[e.from] || !G.byId[e.to]) { console.warn(`edge ${e.id} references a missing node`); continue; }
      G.out[e.from].push(e);
      e.self = e.from === e.to;
      // An edge with no video is a jump cut: it is traversed instantly, and the
      // picture cuts straight from the clip before it to the clip after it.
      e.jump = !e.video;
    }

    // Parallel edges get fanned out so they don't draw on top of each other.
    const bundles = {};
    for (const e of G.edges) {
      const key = e.self ? `self:${e.from}` : [e.from, e.to].sort().join('~');
      (bundles[key] ||= []).push(e);
    }
    for (const key in bundles) {
      bundles[key].forEach((e, i) => { e.slot = i; e.slots = bundles[key].length; });
    }

    // Seed on a circle so the simulation opens up rather than exploding out of a point.
    const cx = W / 2, cy = H / 2;
    G.nodes.forEach((n, i) => {
      const a = (i / G.nodes.length) * Math.PI * 2;
      n.x = cx + Math.cos(a) * 160;
      n.y = cy + Math.sin(a) * 160;
    });

    computeDistances();
    cycles = findCycles();
  }

  // All-pairs shortest hop counts (BFS from every node). Graphs here are tiny.
  function computeDistances() {
    G.dist = {};
    for (const src of G.nodes) {
      const d = { [src.id]: 0 };
      const q = [src.id];
      while (q.length) {
        const cur = q.shift();
        for (const e of G.out[cur]) {
          if (!(e.to in d)) { d[e.to] = d[cur] + 1; q.push(e.to); }
        }
      }
      G.dist[src.id] = d;
    }
  }

  const hops = (from, to) => {
    const d = G.dist[from];
    return d && to in d ? d[to] : Infinity;
  };

  // Shortest edge-path from `from` to `to`. Equal-length paths chosen at random.
  function shortestPath(from, to) {
    if (from === to) return [];
    const prev = {};
    const seen = new Set([from]);
    let frontier = [from];

    while (frontier.length) {
      const next = [];
      for (const cur of shuffle(frontier.slice())) {
        for (const e of shuffle(G.out[cur].slice())) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          prev[e.to] = e;
          if (e.to === to) {
            const path = [];
            for (let at = to; at !== from; at = prev[at].from) path.unshift(prev[at]);
            return path;
          }
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return null;               // unreachable
  }

  // Every simple cycle up to CFG.maxCycleLength, deduped by edge set.
  function findCycles() {
    const found = [];
    const seen = new Set();
    const index = {};
    G.nodes.forEach((n, i) => (index[n.id] = i));

    const walk = (start, cur, pathEdges, visited) => {
      for (const e of G.out[cur]) {
        if (e.to === start) {
          const edges = [...pathEdges, e];
          const key = edges.map((x) => x.id).sort().join(',');
          if (!seen.has(key)) { seen.add(key); found.push({ edges, nodes: edges.map((x) => x.from) }); }
          continue;
        }
        // only extend through nodes "after" the start, so each cycle is found once
        if (index[e.to] < index[start] || visited.has(e.to)) continue;
        if (pathEdges.length + 1 >= CFG.maxCycleLength) continue;
        visited.add(e.to);
        walk(start, e.to, [...pathEdges, e], visited);
        visited.delete(e.to);
      }
    };

    for (const n of G.nodes) walk(n.id, n.id, [], new Set([n.id]));
    return found.sort((a, b) => a.edges.length - b.edges.length);
  }

  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  /* ------------------------------------------------------------- autoplay */

  // Prefer the exit with the shortest loop back to here; if nothing loops back,
  // effectively random.
  function autoPick(node, avoidEdgeId) {
    let options = G.out[node] || [];
    if (!options.length) return null;
    if (options.length > 1 && avoidEdgeId) {
      const trimmed = options.filter((e) => e.id !== avoidEdgeId);
      if (trimmed.length) options = trimmed;
    }

    const scored = options.map((e) => {
      const back = hops(e.to, node);
      const loopLen = back === Infinity ? CFG.noLoopScore : 1 + back;
      const idx = play.history.lastIndexOf(e.id);
      const since = idx === -1 ? Infinity : play.history.length - idx;
      const recency = idx === -1 ? 0 : CFG.recencyWeight / (1 + since);
      return { e, score: loopLen + recency };
    });

    const best = Math.min(...scored.map((s) => s.score));
    const winners = scored.filter((s) => s.score <= best + 1e-9);
    return winners[Math.floor(Math.random() * winners.length)].e;
  }

  /* ----------------------------------------------------- planning / routing */

  // Route from wherever the current clip is heading — we never cut a clip short.
  const planOrigin = () => (play.edge ? play.edge.to : play.parked);

  function plannedEnd() {
    if (play.queue.length) return play.queue[play.queue.length - 1].to;
    return planOrigin();
  }

  function routeToNode(nodeId, append) {
    const from = append ? plannedEnd() : planOrigin();
    const path = shortestPath(from, nodeId);
    if (!path) return;

    // Clicking the node you are already on (or already heading to) has nowhere
    // to travel, so the path comes back empty and the click would do nothing at
    // all. Read it as "play what this node has": if it carries a loop clip, that
    // is its footage, so play it — explicitly asked for, so even if it has just
    // been played.
    if (!path.length) {
      const held = pendingLoop(nodeId, null);
      if (held) path.push(held);
    }

    if (!append) { play.queue = []; play.loop = null; }
    play.queue.push(...path);
    planChanged();
  }

  function routeToEdge(edge, append) {
    const from = append ? plannedEnd() : planOrigin();
    const lead = shortestPath(from, edge.from);
    if (!lead) return;
    if (!append) { play.queue = []; play.loop = null; }
    play.queue.push(...lead, edge);
    planChanged();
  }

  function lockLoop(cycle) {
    const from = planOrigin();
    let bestEntry = null, bestPath = null;
    for (const nid of cycle.nodes) {
      const p = shortestPath(from, nid);
      if (p && (!bestPath || p.length < bestPath.length)) { bestPath = p; bestEntry = nid; }
    }
    if (!bestPath) return;

    play.queue = [...bestPath];
    play.loop = cycle;
    play.loopAt = cycle.edges.findIndex((e) => e.from === bestEntry);
    if (play.loopAt < 0) play.loopAt = 0;
    planChanged();
  }

  // The plan changed: recommit and re-preload whatever comes next.
  function planChanged() {
    const committed = chainClip();
    replan();
    if (chainClip() !== committed) preloadNext();

    // Picking a destination while parked is the cue to start moving again.
    // advance() walks the chain, so this works whether the first step is a clip
    // or a jump cut.
    if (play.parked && play.chain.length && (play.queue.length || play.loop)) {
      advance();
      return;
    }
    render();
  }

  // What happens after this clip, up to and including the next thing that
  // actually has footage.
  //
  // Normally that is one edge. But jump cuts carry no clip, so a plan can run
  // through several of them before reaching real footage — and it is that clip,
  // not the jump, that we must preload if the cut is to stay seamless. So we
  // resolve the whole chain ahead of time: zero or more jumps, then one clip.
  //
  // Decisions are taken here ONCE and held in play.chain, because autoPick is
  // random: asking twice would give two different answers, and we would preload
  // a clip we then do not play.
  function buildChain() {
    const chain = [];
    let origin = planOrigin();
    if (origin == null) return chain;

    // walk a copy of the plan's cursors, committing nothing
    let qi = 0;
    let loopAt = play.loopAt;
    let lastId = play.edge ? play.edge.id : null;

    for (let guard = 0; guard < 16; guard++) {
      // peek at the next step WITHOUT consuming it, so we can still put a loop
      // clip in front of it below
      let e = null, fromQueue = false, fromLoop = false;
      if (qi < play.queue.length) { e = play.queue[qi]; fromQueue = true; }
      else if (play.loop) { e = play.loop.edges[loopAt % play.loop.edges.length]; fromLoop = true; }
      else if (play.repeat && play.edge && !play.edge.jump) e = play.edge;
      else e = autoPick(origin, lastId);

      if (!e) break;

      // A jump cut shows nothing. If we are about to leave this node by one, but
      // the node has a loop clip we have not just played, play that first — the
      // jump keeps its place and is taken next time round. Without this, a route
      // that happens to pass through here skips the node's own footage entirely,
      // and if nothing leads back, you never see it at all.
      if (e.jump) {
        const held = pendingLoop(origin, lastId);
        if (held) { chain.push(held); break; }   // note: queue/loop cursors NOT advanced
      }

      if (fromQueue) qi++;
      else if (fromLoop) loopAt++;

      chain.push(e);
      if (!e.jump) break;              // reached real footage: chain is complete
      origin = e.to;                   // step through the jump and keep looking
      lastId = e.id;
    }
    return chain;                      // an all-jump chain (no clip) is possible, and handled
  }

  // A loop clip on this node that is still owed a play: it has footage, and it
  // is not the clip we have just come off. Least recently played wins.
  function pendingLoop(nodeId, lastId) {
    const held = (G.out[nodeId] || []).filter((e) => e.self && !e.jump && e.id !== lastId);
    if (!held.length) return null;

    let best = null, bestSince = -1;
    for (const e of held) {
      const idx = play.history.lastIndexOf(e.id);
      const since = idx === -1 ? Infinity : play.history.length - idx;
      if (since > bestSince) { bestSince = since; best = e; }
    }
    return best;
  }

  // The clip at the end of the chain — the one we should be buffering.
  function chainClip() {
    if (!play.chain || !play.chain.length) return null;
    const last = play.chain[play.chain.length - 1];
    return last.jump ? null : last;
  }

  // Recompute what comes next, from wherever the plan now stands.
  function replan() {
    play.chain = buildChain();
    play.next = play.chain[0] || null;
  }

  // Consume whatever produced `edge`, so the plan advances by one.
  function commitNext(edge) {
    if (play.queue.length && play.queue[0] === edge) {
      play.queue.shift();
      // dropping out of a routed path back into a locked loop: line the loop up
      if (!play.queue.length && play.loop) {
        const i = play.loop.edges.indexOf(edge);
        if (i >= 0) play.loopAt = i + 1;
      }
    } else if (play.loop && play.loop.edges[play.loopAt % play.loop.edges.length] === edge) {
      play.loopAt = (play.loopAt + 1) % play.loop.edges.length;
    }
  }

  /* -------------------------------------------------- playback (2 buffers) */

  function videoFor(edge, idx) {
    const v = videos[idx];
    if (v.dataset.edge !== edge.id) {
      v.dataset.edge = edge.id;
      v.src = edge.video;
      v.load();
    }
    return v;
  }

  // Buffer the committed next clip into the element we are NOT driving.
  //
  // Never do this mid-hand-over: until the swap completes, the element we are
  // not driving is the outgoing one, still playing its tail on screen. Loading
  // over it would kill the clip in view. show() re-runs this once it is free.
  function preloadNext() {
    if (handing) return;
    const clip = chainClip();          // look THROUGH any jump cuts to real footage
    if (!clip) return;
    const v = videoFor(clip, 1 - live);
    v.pause();
    try { v.currentTime = 0; } catch { /* not seekable yet; load() lands at 0 */ }
  }

  function startEdge(edge, videoIdx) {
    play.edge = edge;
    play.parked = null;
    play.progress = 0;
    remember(edge);

    const v = videoFor(edge, videoIdx);
    videos.forEach((x, i) => x.classList.toggle('live', i === videoIdx));
    live = videoIdx;
    v.currentTime = 0;
    if (!play.paused) v.play().catch(() => {});

    replan();
    preloadNext();
    render();
  }

  function remember(edge) {
    play.history.push(edge.id);
    if (play.history.length > 40) play.history.shift();
  }

  // Cut to `edge` on the idle element. The outgoing clip's last frame and the
  // incoming clip's first frame are the same still, so holding the old frame for
  // the beat it takes the new element to decode is invisible — that is what
  // makes the cut look seamless.
  function transitionTo(edge) {
    const idx = 1 - live;               // the idle element becomes the incoming one
    const old = videos[live];
    const v = videoFor(edge, idx);

    handing = true;
    live = idx;                         // drive the incoming element from here on,
                                        // so nothing else can target it as "idle"
    play.edge = edge;
    play.parked = null;
    play.progress = 0;
    remember(edge);

    // The outgoing element keeps playing, and stays visible, right up to the
    // moment the incoming one paints its first frame — so there is never a
    // moment with nothing to show.
    const show = () => {
      if (!handing) return;             // already swapped
      videos.forEach((x, i) => x.classList.toggle('live', i === idx));
      old.pause();
      handing = false;
      preloadNext();                    // only now is the other element free
    };

    const go = () => {
      if (v.currentTime > 0) v.currentTime = 0;   // avoid a needless seek/flush
      if (play.paused) { show(); return; }
      Promise.resolve(v.play())
        .then(() => {
          // swap on the incoming element's first painted frame
          if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(show);
          else show();
        })
        .catch(show);
    };

    if (v.readyState >= 2) go();
    else v.addEventListener('loadeddata', go, { once: true });

    replan();
    render();
  }

  // Hand over to whatever the plan says is next: step through any jump cuts
  // instantly, then play the first clip with real footage behind it.
  function advance() {
    if (handing) return;                 // already rolling into the next clip

    const chain = (play.chain && play.chain.length) ? play.chain : buildChain();
    if (!chain.length) { park(play.edge ? play.edge.to : play.parked); return; }   // dead end

    for (const e of chain) {
      commitNext(e);
      if (!e.jump) { transitionTo(e); return; }
      // a jump cut has no duration: cross it and keep going, without touching
      // the video elements — the outgoing clip stays on screen until the next
      // real clip paints, which is exactly what makes it read as a cut
      remember(e);
      play.edge = e;
      play.parked = null;
    }

    // nothing but jumps and then nowhere to go
    park(chain[chain.length - 1].to);
  }

  // Double-click a connection: abandon the plan and take it now.
  function jumpToEdge(edge) {
    play.queue = [];
    play.loop = null;

    if (edge.jump) {                   // no footage: cross it and play what follows
      remember(edge);
      play.edge = edge;
      play.parked = null;
      replan();
      advance();
      return;
    }
    transitionTo(edge);
  }

  // Double-click a node: arrive now and STOP, holding its still, so the user can
  // choose a direction. Autoplay does not resume on its own.
  //
  // Unless there is nothing to choose: with exactly one way out, stopping to ask
  // is just a dead pause, so we take it.
  function park(nodeId) {
    play.queue = [];
    play.loop = null;
    play.edge = null;
    play.parked = nodeId;
    play.progress = 0;

    // A node with a loop clip has footage of its own, so there is nothing to ask
    // about yet: play the loop and carry on. No special case afterwards — the
    // loop was simply the last clip played, so the ordinary autoplay rule takes
    // it from there and moves on to the next edge.
    const held = pendingLoop(nodeId, null);
    if (held) { transitionTo(held); return; }

    // advance() walks jump cuts, so this is right even when the only way out of
    // here is a jump.
    if ((G.out[nodeId] || []).length === 1) { replan(); advance(); return; }

    videos.forEach((v) => { v.pause(); v.classList.remove('live'); });
    document.getElementById('scrub-fill').style.width = '0%';

    // Buffer the likeliest exit, so whatever they pick is more likely to be warm.
    replan();
    preloadNext();
    render();
  }

  function jumpToLoop(cycle) {
    play.queue = [];
    play.loop = cycle;
    play.loopAt = 0;
    replan();
    advance();                         // handles a cycle that opens with a jump cut
  }

  function tick() {
    const v = videos[live];
    if (play.edge && v.duration) {
      play.progress = Math.min(1, v.currentTime / v.duration);
      document.getElementById('scrub-fill').style.width = `${play.progress * 100}%`;

      // Start the next clip before this one ends, so its startup latency is
      // spent while the current clip is still on screen rather than after it.
      const remaining = v.duration - v.currentTime;
      if (!handing && !play.paused && play.chain && play.chain.length
          && remaining > 0 && remaining <= CFG.preroll) {
        advance();          // walks any jump cuts, then plays the next real clip
      }
    }
    simulate();
    if (autoFit) fitView();
    draw();
    requestAnimationFrame(tick);
  }

  /* --------------------------------------------------------- force layout */

  function simulate() {
    const cx = W / 2, cy = H / 2;
    const focus = play.edge ? play.edge.to : play.parked;

    for (let i = 0; i < G.nodes.length; i++) {
      const a = G.nodes[i];
      let fx = 0, fy = 0;

      for (let j = 0; j < G.nodes.length; j++) {
        if (i === j) continue;
        const b = G.nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = CFG.repulsion / d2;
        const d = Math.sqrt(d2);
        fx += (dx / d) * f;
        fy += (dy / d) * f;
      }

      fx += (cx - a.x) * CFG.centerPull;
      fy += (cy - a.y) * CFG.centerPull;

      // bias the layout around what is playing, so options open up in view
      if (a.id === focus) {
        fx += (cx - a.x) * CFG.focusPull;
        fy += (cy - a.y) * CFG.focusPull;
      }

      a.vx = (a.vx + fx * 0.01) * CFG.damping;
      a.vy = (a.vy + fy * 0.01) * CFG.damping;
    }

    for (const e of G.edges) {
      if (e.self) continue;
      const a = G.byId[e.from], b = G.byId[e.to];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - CFG.edgeLength) * CFG.spring;
      const ux = (dx / d) * f, uy = (dy / d) * f;
      a.vx += ux; a.vy += uy;
      b.vx -= ux; b.vy -= uy;
    }

    // No clamping to the window: nodes live in world space and may sit off
    // screen. The gentle pull towards the centre above is what keeps the layout
    // from drifting away for good; pan and zoom decide what is actually visible.
    for (const n of G.nodes) {
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  // Frame the whole graph.
  function fitView() {
    if (!G.nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of G.nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = CFG.nodeRadius + 70;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    view.k = Math.min(W / (maxX - minX), H / (maxY - minY), 1.6);
    view.x = W / 2 - ((minX + maxX) / 2) * view.k;
    view.y = H / 2 - ((minY + maxY) / 2) * view.k;
    applyView();
  }

  /* -------------------------------------------------------------- geometry */

  // Edge as an SVG path, trimmed to the node rims. Parallel edges bow apart;
  // self-loops become a teardrop off the node.
  function edgePath(e) {
    const a = G.byId[e.from], b = G.byId[e.to];
    const R = CFG.nodeRadius;

    if (e.self) {
      const spread = 0.55, lift = 118 + e.slot * 46;
      // Throw the loop into free space rather than always straight up: point it
      // away from the node's neighbours, so the teardrop stops landing on top of
      // whatever happens to be sitting above.
      const base = freeAngle(a) + e.slot * 0.9;
      const p1 = { x: a.x + Math.cos(base - spread) * R, y: a.y + Math.sin(base - spread) * R };
      const p2 = { x: a.x + Math.cos(base + spread) * R, y: a.y + Math.sin(base + spread) * R };
      const c1 = { x: a.x + Math.cos(base - spread) * lift, y: a.y + Math.sin(base - spread) * lift };
      const c2 = { x: a.x + Math.cos(base + spread) * lift, y: a.y + Math.sin(base + spread) * lift };
      return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
    }

    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const bow = (e.slot - (e.slots - 1) / 2) * 62;      // fan parallel edges out
    const mx = (a.x + b.x) / 2 - (dy / d) * bow;
    const my = (a.y + b.y) / 2 + (dx / d) * bow;

    const a1 = Math.atan2(my - a.y, mx - a.x);
    const a2 = Math.atan2(my - b.y, mx - b.x);
    const sx = a.x + Math.cos(a1) * R, sy = a.y + Math.sin(a1) * R;
    const ex = b.x + Math.cos(a2) * (R + 9), ey = b.y + Math.sin(a2) * (R + 9);

    return `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`;
  }

  // The emptiest direction out of a node: opposite the average bearing of its
  // neighbours. Used to aim self-loops away from the rest of the graph.
  function freeAngle(n) {
    let sx = 0, sy = 0;
    for (const e of G.edges) {
      if (e.self) continue;
      let other = null;
      if (e.from === n.id) other = G.byId[e.to];
      else if (e.to === n.id) other = G.byId[e.from];
      if (!other) continue;
      const dx = other.x - n.x, dy = other.y - n.y;
      const d = Math.hypot(dx, dy) || 1;
      sx += dx / d;
      sy += dy / d;
    }
    if (Math.hypot(sx, sy) < 0.01) return -Math.PI / 2;   // no neighbours: straight up
    return Math.atan2(-sy, -sx);                          // away from the crowd
  }

  // Closed outline of a cycle — the clickable "inside the loop" region.
  function cyclePath(cycle) {
    const pts = [];
    for (const e of cycle.edges) {
      const p = cycle.paths[e.id];
      if (!p) continue;
      const L = p.getTotalLength();
      const steps = e.self ? 14 : 8;
      for (let i = 0; i <= steps; i++) {
        const pt = p.getPointAtLength((L * i) / steps);
        pts.push(`${pt.x} ${pt.y}`);
      }
    }
    return pts.length ? `M ${pts.join(' L ')} Z` : '';
  }

  /* ---------------------------------------------------------- click routing */

  // A single click has to hold back long enough to know a second one isn't
  // coming. ⌘/Ctrl-click (queue) can't be doubled, so it fires straight away.
  const DOUBLE_CLICK_MS = 230;
  let pendingClick = null;

  function onSingle(ev, route) {
    ev.stopPropagation();
    if (ev.metaKey || ev.ctrlKey) { route(true); return; }
    clearTimeout(pendingClick);
    pendingClick = setTimeout(() => { pendingClick = null; route(false); }, DOUBLE_CLICK_MS);
  }

  function onDouble(ev, jump) {
    ev.stopPropagation();
    clearTimeout(pendingClick);
    pendingClick = null;
    jump();
  }

  /* ------------------------------------------------------------- rendering */

  const gfx = { nodes: {}, edges: {}, loops: [] };

  function buildScene() {
    layers.loops.innerHTML = '';
    layers.edges.innerHTML = '';
    layers.nodes.innerHTML = '';
    gfx.nodes = {}; gfx.edges = {}; gfx.loops = [];

    // loop regions sit under everything; smallest drawn last so it wins the click
    cycles.forEach((cycle) => {
      const region = el('path', { class: 'loop-region' });
      region.addEventListener('mouseenter', () => { hover.loop = cycle; render(); });
      region.addEventListener('mouseleave', () => { if (hover.loop === cycle) hover.loop = null; render(); });
      region.addEventListener('click', (ev) => onSingle(ev, () => lockLoop(cycle)));
      region.addEventListener('dblclick', (ev) => onDouble(ev, () => jumpToLoop(cycle)));
      layers.loops.appendChild(region);
      gfx.loops.push({ cycle, region });
      cycle.paths = {};
    });

    for (const e of G.edges) {
      const g = el('g', { class: 'edge' });
      const base = el('path', { class: 'edge-base' });
      const prog = el('path', { class: 'edge-progress' });
      const hit = el('path', { class: 'edge-hit' });
      const arrow = el('path', { class: 'edge-arrow' });
      const label = el('text', { class: 'edge-label' });
      label.textContent = e.name || e.id;

      hit.addEventListener('mouseenter', () => { hover.edge = e; render(); });
      hit.addEventListener('mouseleave', () => { if (hover.edge === e) hover.edge = null; render(); });
      hit.addEventListener('click', (ev) => onSingle(ev, (append) => routeToEdge(e, append)));
      hit.addEventListener('dblclick', (ev) => onDouble(ev, () => jumpToEdge(e)));

      g.append(base, prog, arrow, hit, label);
      layers.edges.appendChild(g);
      gfx.edges[e.id] = { g, base, prog, hit, arrow, label };

      for (const { cycle } of gfx.loops) {
        if (cycle.edges.includes(e)) cycle.paths[e.id] = base;
      }
    }

    for (const n of G.nodes) {
      const g = el('g', { class: 'node' });
      const clipId = `clip-${n.id}`;
      const clip = el('clipPath', { id: clipId });
      clip.appendChild(el('circle', { r: CFG.nodeRadius - 2 }));

      const img = el('image', {
        class: 'node-img',
        href: n.image,
        width: CFG.nodeRadius * 2,
        height: CFG.nodeRadius * 2,
        x: -CFG.nodeRadius,
        y: -CFG.nodeRadius,
        preserveAspectRatio: 'xMidYMid slice',
        'clip-path': `url(#${clipId})`,
      });
      const ring = el('circle', { class: 'node-ring', r: CFG.nodeRadius });
      const hit = el('circle', { class: 'node-hit', r: CFG.nodeRadius, fill: 'transparent' });
      const label = el('text', { class: 'node-label', y: CFG.nodeRadius + 20 });
      label.textContent = n.name || n.id;

      const badge = el('g', { class: 'node-badge' });
      badge.append(el('circle', { r: 9, cx: CFG.nodeRadius - 6, cy: -CFG.nodeRadius + 6 }));
      const badgeText = el('text', { x: CFG.nodeRadius - 6, y: -CFG.nodeRadius + 6 });
      badge.appendChild(badgeText);
      badge.style.display = 'none';

      g.addEventListener('mouseenter', () => { hover.node = n; render(); });
      g.addEventListener('mouseleave', () => { if (hover.node === n) hover.node = null; render(); });
      g.addEventListener('click', (ev) => onSingle(ev, (append) => routeToNode(n.id, append)));
      g.addEventListener('dblclick', (ev) => onDouble(ev, () => park(n.id)));

      g.append(clip, img, ring, hit, badge, label);
      layers.nodes.appendChild(g);
      gfx.nodes[n.id] = { g, badge, badgeText };
    }
  }

  // Positions change every frame; classes only when the plan does.
  function draw() {
    for (const e of G.edges) {
      const gg = gfx.edges[e.id];
      const d = edgePath(e);
      gg.base.setAttribute('d', d);
      gg.prog.setAttribute('d', d);
      gg.hit.setAttribute('d', d);

      const L = gg.base.getTotalLength();
      const tip = gg.base.getPointAtLength(L);
      const before = gg.base.getPointAtLength(Math.max(0, L - 1));
      const ang = (Math.atan2(tip.y - before.y, tip.x - before.x) * 180) / Math.PI;
      gg.arrow.setAttribute('d', 'M 0 -5 L 10 0 L 0 5 Z');
      gg.arrow.setAttribute('transform', `translate(${tip.x} ${tip.y}) rotate(${ang})`);

      const mid = gg.base.getPointAtLength(L / 2);
      gg.label.setAttribute('x', mid.x);
      gg.label.setAttribute('y', mid.y - 8);
    }

    for (const n of G.nodes) {
      gfx.nodes[n.id].g.setAttribute('transform', `translate(${n.x} ${n.y})`);
    }

    for (const { cycle, region } of gfx.loops) {
      region.setAttribute('d', cyclePath(cycle));
    }

    paintProgress();
  }

  function paintProgress() {
    for (const e of G.edges) {
      const gg = gfx.edges[e.id];
      if (play.edge && e.id === play.edge.id) {
        const L = gg.base.getTotalLength();
        gg.prog.setAttribute('stroke-dasharray', `${L * play.progress} ${L}`);
      } else {
        gg.prog.setAttribute('stroke-dasharray', '0 1');
      }
    }
  }

  // Highlight: the current edge and its two nodes, the options one step ahead,
  // and the options after those.
  function render() {
    const cur = play.edge;
    const target = cur ? cur.to : play.parked;

    const nextEdges = new Set();
    const futureEdges = new Set();
    const nextNodes = new Set();
    const futureNodes = new Set();

    if (target) {
      for (const e of G.out[target] || []) {
        nextEdges.add(e.id);
        nextNodes.add(e.to);
        for (const e2 of G.out[e.to] || []) {
          futureEdges.add(e2.id);
          futureNodes.add(e2.to);
        }
      }
    }

    const queuedEdges = new Set(play.queue.map((e) => e.id));
    const queuePos = {};
    play.queue.forEach((e, i) => { if (!(e.to in queuePos)) queuePos[e.to] = i + 1; });

    for (const e of G.edges) {
      const c = gfx.edges[e.id].g.classList;
      c.toggle('jump', !!e.jump);
      c.toggle('active', !!cur && e.id === cur.id);
      c.toggle('next', nextEdges.has(e.id) && (!cur || e.id !== cur.id));
      c.toggle('future', futureEdges.has(e.id) && !nextEdges.has(e.id) && (!cur || e.id !== cur.id));
      c.toggle('queued', queuedEdges.has(e.id));
      c.toggle('hover', hover.edge === e);
    }

    for (const n of G.nodes) {
      const gg = gfx.nodes[n.id];
      const c = gg.g.classList;
      c.toggle('source', !!cur && n.id === cur.from);
      c.toggle('target', n.id === target);
      c.toggle('next', nextNodes.has(n.id) && n.id !== target);
      c.toggle('future', futureNodes.has(n.id) && !nextNodes.has(n.id) && n.id !== target);
      c.toggle('queued', n.id in queuePos);
      c.toggle('hover', hover.node === n);

      if (n.id in queuePos) {
        gg.badge.style.display = '';
        gg.badgeText.textContent = queuePos[n.id];
      } else {
        gg.badge.style.display = 'none';
      }
    }

    for (const { cycle, region } of gfx.loops) {
      region.classList.toggle('hover', hover.loop === cycle);
      region.classList.toggle('locked', play.loop === cycle);
    }

    // player chrome
    const parked = !cur && play.parked;
    const still = document.getElementById('still');
    if (parked) {
      const src = G.byId[play.parked].image;
      if (!still.src.endsWith(src)) still.src = src;
    }
    still.classList.toggle('live', !!parked);
    document.getElementById('park-hint').classList.toggle('live', !!parked);

    document.getElementById('np-from').textContent = cur ? G.byId[cur.from].name : '—';
    document.getElementById('np-to').textContent = target ? G.byId[target].name : '—';
    document.getElementById('np-edge').textContent =
      cur ? (cur.name || cur.id) : parked ? 'stopped' : 'idle';

    const q = document.getElementById('queue');
    q.innerHTML = '';
    if (play.loop) {
      const chip = document.createElement('span');
      chip.className = 'chip loop';
      chip.textContent = `↻ ${play.loop.edges.map((e) => G.byId[e.from].name).join(' → ')}`;
      q.appendChild(chip);
    }
    play.queue.slice(0, 6).forEach((e) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = e.name || e.id;
      q.appendChild(chip);
    });
  }

  /* -------------------------------------------------------------- controls */

  function wire() {
    videos.forEach((v) => {
      v.addEventListener('ended', () => { if (v === videos[live]) advance(); });
    });

    const btnPlay = document.getElementById('btn-play');
    btnPlay.addEventListener('click', () => {
      if (play.parked) {                 // stopped on a node: carry on under autoplay
        play.paused = false;
        btnPlay.textContent = 'Pause';
        advance();
        return;
      }
      play.paused = !play.paused;
      btnPlay.textContent = play.paused ? 'Play' : 'Pause';
      if (play.paused) videos[live].pause();
      else videos[live].play().catch(() => {});
    });

    const btnMute = document.getElementById('btn-mute');
    btnMute.addEventListener('click', () => {
      const muted = !videos[0].muted;
      videos.forEach((v) => (v.muted = muted));
      btnMute.textContent = muted ? 'Unmute' : 'Mute';
      btnMute.classList.toggle('muted', muted);
      btnMute.classList.toggle('on', !muted);
    });

    const btnLoop = document.getElementById('btn-loop');
    btnLoop.addEventListener('click', () => {
      play.repeat = !play.repeat;
      btnLoop.classList.toggle('on', play.repeat);
      planChanged();                     // recommit and re-preload what comes next
    });

    // Skip means "move on now", so it overrides the hold rather than fighting it.
    document.getElementById("btn-skip").addEventListener("click", () => {
      if (play.repeat && play.edge) {
        const on = autoPick(play.edge.to, play.edge.id);
        if (on) { commitNext(on); transitionTo(on); return; }
      }
      advance();
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      play.queue = [];
      play.loop = null;
      planChanged();
    });

    svg.addEventListener('click', () => { hover.loop = null; render(); });
    document.getElementById('btn-fit').addEventListener('click', () => { autoFit = true; fitView(); });

    /* ---- pan ---- */

    let drag = null;
    let panned = false;      // the pointer moved far enough that this was a pan

    // Deliberately NOT using setPointerCapture here. Capturing on the <svg>
    // retargets the pointer events — and the click they produce — to the <svg>
    // itself, so clicks would never reach the node and edge handlers. Tracking
    // the drag on `window` instead keeps dragging working past the edge of the
    // pane without stealing anything's click.
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
      svg.style.cursor = 'grabbing';
    });

    window.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved > 4) autoFit = false;     // you are driving the camera now
      view.x += dx;
      view.y += dy;
      applyView();
    });

    const endPan = () => {
      if (!drag) return;
      if (drag.moved > 4) panned = true;      // swallow the click this produces
      drag = null;
      svg.style.cursor = '';
    };
    window.addEventListener('pointerup', endPan);
    window.addEventListener('pointercancel', endPan);

    // Capture phase, so a pan that finishes over a node never reaches the node's
    // own click handler and starts routing playback.
    svg.addEventListener('click', (ev) => {
      if (!panned) return;
      panned = false;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);

    /* ---- zoom ---- */

    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const r = svg.getBoundingClientRect();
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;

      // Normalise to pixels: some inputs report deltaY in lines (deltaMode 1) or
      // pages (2) with tiny magnitudes, which would make the zoom imperceptible;
      // trackpads report pixels but with large momentum bursts, which would make
      // it jumpy. Normalise, then cap, so one factor works for mouse and trackpad.
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? r.height : 1;
      let delta = ev.deltaY * unit;
      if (!delta) return;
      delta = Math.max(-60, Math.min(60, delta));

      const k0 = view.k;
      const k1 = Math.min(4, Math.max(0.15, k0 * Math.exp(-delta * 0.0025)));
      if (k1 === k0) return;
      autoFit = false;                        // you are driving the camera now

      // keep whatever is under the cursor pinned under the cursor
      view.x = sx - ((sx - view.x) / k0) * k1;
      view.y = sy - ((sy - view.y) / k0) * k1;
      view.k = k1;
      applyView();
    }, { passive: false });

    window.addEventListener('resize', resize);
  }

  function resize() {
    const r = svg.getBoundingClientRect();
    W = r.width; H = r.height;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  }

  /* ------------------------------------------------------------------ boot */

  (async function main() {
    resize();
    await loadGraph();
    buildScene();
    wire();
    render();
    requestAnimationFrame(tick);

    // Kick off from the first node. Muted, so autoplay is never blocked.
    const first = autoPick(G.nodes[0].id, null);
    if (first) startEdge(first, 0);
    else { play.parked = G.nodes[0].id; render(); }
  })();
})();
