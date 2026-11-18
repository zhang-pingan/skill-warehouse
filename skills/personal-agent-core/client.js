window.__ModuleLoader__.load({
  id: '@local/personal-agent-core',
  factory(require) {
    /** Owns the animated graph, with shared projected paths for drawing and picking. */
    function createStarMapRenderer(cv, { graph, onSelect, labels = {}, reducedMotion = false }) {
      const ctx = cv.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is unavailable');
      const document = cv.ownerDocument, nebula = createNebulaBackdrop(document);
      const colors = { memory: '#7fc8ff', entity: '#9fe6c8', 'session-task': '#ffb86b', task: '#ff8fc7' };
      const anchors = { memory: [0, -.52, .12], entity: [.68, -.02, -.15], 'session-task': [-.68, -.03, .12], task: [-.12, .52, -.25] };
      const tint = (color, alpha) => { const n = parseInt(color.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${alpha})`; };
      const hash = text => { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0; };
      const groups = Object.keys(colors).map(type => ({ type, nodes: graph.nodes.filter(node => node.type === type).sort((a, b) => a.key.localeCompare(b.key)) })).filter(group => group.nodes.length);
      const positions = groups.flatMap(group => {
        const center = groups.length > 1 ? anchors[group.type] : [0, 0, 0];
        const spread = groups.length > 1 ? .34 : .85;
        group.center = center; group.spread = spread;
        return group.nodes.map((node, i) => {
          const y = 1 - 2 * (i + .5) / group.nodes.length, r = Math.sqrt(1 - y * y), angle = i * Math.PI * (3 - Math.sqrt(5));
          return { ...node, phase: hash(node.key) / 4294967296 * Math.PI * 2, x: center[0] + spread * r * Math.cos(angle), y: center[1] + spread * y * .8, z: center[2] + spread * r * Math.sin(angle) };
        });
      });
      const pairs = new Map();
      const edges = graph.edges.map((edge, i) => {
        const pair = [edge.from, edge.to].sort().join('|');
        const peers = pairs.get(pair) || []; pairs.set(pair, peers);
        const value = { ...edge, key: 'relation:' + edge.record.id, phase: hash(edge.record.id) / 4294967296, index: i, pair, lane: peers.length };
        peers.push(value); return value;
      });
      const extent = Math.max(.85, ...groups.map(group => Math.hypot(group.center[0], group.center[2]) + group.spread));
      let width = 0, height = 0, zoom = 1, targetZoom = 1, yaw = -.35, pitch = .22, panX = 0, panY = 0, targetX = 0, targetY = 0;
      let yawVelocity = 0, pitchVelocity = 0, selected = null, hover = null, pointer = null, drag = null, disposed = false, frame = 0;
      let lastTime = null, time = 0, sceneTime = 0, projected = [], paths = [], regions = [];
      const focus = new Map();
      const point = event => { const box = cv.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
      const camera = (x, y, z) => {
        const rx = x * Math.cos(yaw) + z * Math.sin(yaw), rz = z * Math.cos(yaw) - x * Math.sin(yaw);
        const ry = y * Math.cos(pitch) - rz * Math.sin(pitch), depth = rz * Math.cos(pitch) + y * Math.sin(pitch);
        const radius = Math.max(70, Math.min(height * .34, width > 900 ? (width - 600) * .49 : width * .40)) * zoom;
        const scale = 1 / (1 + depth * .22);
        return { px: width / 2 + panX + rx * radius * scale, py: height / 2 + panY + ry * radius * scale, depth, scale, radius };
      };
      function project() {
        regions = groups.map(group => { const p = camera(...group.center); return { ...p, type: group.type, color: colors[group.type], label: labels[group.type] || '', radius: Math.max(28, group.spread * p.radius * p.scale * 1.5) }; });
        projected = positions.map(node => {
          const drift = reducedMotion ? 0 : .009;
          const p = camera(node.x + Math.sin(sceneTime * .52 + node.phase) * drift, node.y + Math.cos(sceneTime * .41 + node.phase) * drift, node.z + Math.sin(sceneTime * .33 + node.phase) * drift);
          const distance = pointer ? Math.hypot(p.px - pointer.x, p.py - pointer.y) : Infinity;
          const influence = Math.max(0, 1 - distance / 110);
          if (pointer && !drag) { const expansion = .65 * influence * influence; p.px += (p.px - pointer.x) * expansion; p.py += (p.py - pointer.y) * expansion; }
          return { ...node, ...p, radius: (3.2 + p.scale) * (1 + 1.8 * influence * influence * (3 - 2 * influence)) };
        });
        const byKey = new Map(projected.map(node => [node.key, node]));
        paths = edges.flatMap(edge => {
          const a = byKey.get(edge.from), b = byKey.get(edge.to); if (!a || !b) return [];
          const dx = b.px - a.px, dy = b.py - a.py, length = Math.hypot(dx, dy);
          const count = pairs.get(edge.pair).length, direction = edge.from < edge.to ? 1 : -1;
          const bend = count > 1 ? (edge.lane - (count - 1) / 2) * 24 + 12 : Math.min(44, length * .10);
          const cx = (a.px + b.px) / 2 - dy / (length || 1) * bend * direction;
          const cy = (a.py + b.py) / 2 + dx / (length || 1) * bend * direction;
          const at = t => ({ x: (1 - t) ** 2 * a.px + 2 * (1 - t) * t * cx + t * t * b.px, y: (1 - t) ** 2 * a.py + 2 * (1 - t) * t * cy + t * t * b.py });
          const samples = Array.from({ length: 25 }, (_, i) => at(i / 24));
          return [{ ...edge, a, b, cx, cy, length, at, samples }];
        });
      }
      function hit(p, touch = false) {
        let result = null, best = Infinity;
        for (const node of projected) {
          const distance = Math.hypot(node.px - p.x, node.py - p.y);
          if (distance <= Math.max(node.radius + 5, touch ? 18 : 9) && distance < best) { result = node; best = distance; }
        }
        if (result) return result;
        best = touch ? 11 : 6;
        for (const edge of paths) for (let i = 1; i < edge.samples.length; i++) {
          const a = edge.samples[i - 1], b = edge.samples[i], dx = b.x - a.x, dy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
          const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
          if (distance < best) { result = edge; best = distance; }
        }
        return result;
      }
      function strokePath(edge) { ctx.beginPath(); ctx.moveTo(edge.a.px, edge.a.py); ctx.quadraticCurveTo(edge.cx, edge.cy, edge.b.px, edge.b.py); ctx.stroke(); }
      function drawStar(node, amount) {
        const color = colors[node.type], r = node.radius * .3 * (1 + amount * .12);
        const depth = Math.max(.48, Math.min(1, .78 - node.depth * .22));
        const density = Math.max(.72, Math.min(1, Math.pow(120 / positions.length, .12)));
        const glow = r * (5 + Math.abs(node.depth) * 2), light = ctx.createRadialGradient(node.px, node.py, 0, node.px, node.py, glow);
        for (const [stop, alpha] of [[0, .92], [.18, .86], [.44, .62], [.72, .24], [.9, .07], [1, 0]]) light.addColorStop(stop, stop === 0 ? `rgba(255,255,255,${alpha})` : tint(color, alpha));
        const breath = reducedMotion ? 1 : .95 + .05 * Math.sin(time * .7 + node.phase);
        ctx.save(); ctx.globalAlpha = Math.min(.8, (.42 * depth * density + .24 * amount) * breath); ctx.fillStyle = light; ctx.fillRect(node.px - glow, node.py - glow, glow * 2, glow * 2);
        ctx.globalAlpha = Math.min(1, .72 * depth + .23 * amount); ctx.fillStyle = amount > .1 ? '#ffffff' : color; ctx.strokeStyle = color; ctx.lineWidth = .8;
        ctx.beginPath(); ctx.arc(node.px, node.py, r, 0, Math.PI * 2); if (node.contextOnly) ctx.stroke(); else ctx.fill(); ctx.restore();
      }
      function drawFocus(node, amount) {
        const pulse = reducedMotion ? 1 : .95 + .05 * Math.sin(time * 2.2), mobile = width <= 900;
        const inner = (mobile ? 22 : 30) * pulse, outer = (mobile ? 36 : 48) * pulse, extent = outer * 2;
        ctx.save(); nebula.focus(ctx, node.px, node.py, outer, amount);
        ctx.globalAlpha = amount; ctx.strokeStyle = 'rgba(255,192,234,.82)'; ctx.lineWidth = 1.25; ctx.beginPath(); ctx.arc(node.px, node.py, inner, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(196,168,255,.32)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(node.px, node.py, outer, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = .9; ctx.beginPath();
        ctx.moveTo(node.px - extent, node.py); ctx.lineTo(node.px - outer * 1.02, node.py); ctx.moveTo(node.px + outer * 1.02, node.py); ctx.lineTo(node.px + extent, node.py);
        ctx.moveTo(node.px, node.py - extent); ctx.lineTo(node.px, node.py - outer * 1.02); ctx.moveTo(node.px, node.py + outer * 1.02); ctx.lineTo(node.px, node.py + extent); ctx.stroke(); ctx.restore();
      }
      function drawRegionLabels() {
        const used = []; ctx.save(); ctx.font = `${width <= 900 ? 10 : 11}px system-ui`;
        for (const region of regions) {
          if (!region.label) continue;
          const w = ctx.measureText(region.label).width + 20;
          const minX = width > 900 ? 328 : 14, maxX = width > 900 ? width - 328 : width - 14;
          const x = Math.max(minX, Math.min(maxX - w, region.px - w / 2));
          let y = Math.max(120, Math.min(height - 110, region.py - region.radius * .75));
          for (let tries = 0; tries < 6 && used.some(box => x < box.x + box.w && x + w > box.x && Math.abs(y - box.y) < 20); tries++) y += 20;
          used.push({ x, y, w }); ctx.globalAlpha = .82; ctx.fillStyle = tint(region.color, .95); ctx.strokeStyle = tint(region.color, .62); ctx.lineWidth = 1;
          ctx.strokeRect(x, y - 6, 5, 5); ctx.beginPath(); ctx.moveTo(x + 6, y - 3.5); ctx.lineTo(x + 12, y - 3.5); ctx.stroke(); ctx.fillText(region.label, x + 16, y);
        }
        ctx.restore();
      }
      function draw(now = 0) {
        frame = 0; if (disposed || !width || !height || document.hidden) return;
        const dt = lastTime === null ? 0 : Math.max(0, Math.min(.05, (now - lastTime) / 1000)); lastTime = now;
        if (!reducedMotion) {
          time += dt;
          if (!drag) {
            yaw += yawVelocity * dt;
            pitch = Math.max(-1.3, Math.min(1.3, pitch + pitchVelocity * dt));
            if (!pointer && !selected) { sceneTime += dt; yaw += .096 * dt; }
          }
          yawVelocity *= Math.pow(.93, dt * 60); pitchVelocity *= Math.pow(.93, dt * 60);
        }
        const ease = reducedMotion ? 1 : 1 - Math.exp(-12 * dt);
        zoom += (targetZoom - zoom) * ease; panX += (targetX - panX) * ease; panY += (targetY - panY) * ease;
        project(); hover = pointer && !drag ? hit(pointer)?.key ?? null : null;
        ctx.clearRect(0, 0, width, height);
        nebula.draw(ctx, { width, height, zoom, yaw, pitch, panX, panY, pixelRatio: Math.min(window.devicePixelRatio || 1, 2), time, regions, orbitRadius: 120 * extent });
        ctx.save(); ctx.lineCap = 'round';
        for (const edge of paths) {
          const active = edge.key === hover || edge.key === selected || [hover, selected].some(key => key && (edge.from === key || edge.to === key));
          const target = active ? 1 : 0, previous = focus.get(edge.key) || 0, amount = reducedMotion ? target : previous + (target - previous) * ease; focus.set(edge.key, amount);
          const breath = reducedMotion ? 1 : .94 + .06 * Math.sin(time * .6 + edge.phase * 6.28);
          ctx.strokeStyle = tint(edge.index % 3 === 0 ? '#6c5aa8' : '#4f6d9c', .025 + amount * .035); ctx.lineWidth = 4 + edge.index % 3 * 2; strokePath(edge);
          ctx.strokeStyle = tint(amount > .05 ? (edge.index % 3 === 0 ? '#ffc7ee' : '#b9c9ff') : '#6c8ec8', (.18 + .48 * amount) * breath); ctx.lineWidth = .7 + .45 * amount; strokePath(edge);
          if (!reducedMotion && edge.index % Math.max(1, Math.ceil(paths.length / 48)) === 0) {
            const t = (time * .11 + edge.phase) % 1, p = edge.at(t), glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 5);
            glow.addColorStop(0, 'rgba(216,235,255,.85)'); glow.addColorStop(1, 'rgba(127,200,255,0)'); ctx.fillStyle = glow; ctx.globalAlpha = .2 + .65 * Math.sin(Math.PI * t); ctx.fillRect(p.x - 5, p.y - 5, 10, 10); ctx.globalAlpha = 1;
          }
        }
        ctx.restore();
        const selectedEdge = paths.find(edge => edge.key === selected || edge.key === hover);
        for (const node of [...projected].sort((a, b) => b.depth - a.depth)) {
          const target = node.key === hover || node.key === selected ? 1 : selectedEdge && (selectedEdge.from === node.key || selectedEdge.to === node.key) ? .55 : 0;
          const amount = reducedMotion ? target : (focus.get(node.key) || 0) + (target - (focus.get(node.key) || 0)) * ease; focus.set(node.key, amount);
          drawStar(node, amount); if (amount > .02) drawFocus(node, amount);
        }
        drawRegionLabels();
        const target = projected.find(node => node.key === (hover || selected)) || paths.find(edge => edge.key === (hover || selected));
        if (target) {
          const anchor = target.at ? target.at(.5) : { x: target.px + 48, y: target.py - 18 };
          const label = String(target.label || ''), text = label.length > 44 ? label.slice(0, 44) + '…' : label;
          ctx.save(); ctx.font = '12px system-ui'; ctx.fillStyle = '#cfddf4'; ctx.shadowColor = '#04060d'; ctx.shadowBlur = 4;
          const labelWidth = Math.min(width - 28, ctx.measureText(text).width + 4);
          ctx.fillText(text, Math.max(14, Math.min(width - labelWidth - 14, anchor.x)), Math.max(100, Math.min(height - 100, anchor.y)), labelWidth); ctx.restore();
        }
        cv.style.cursor = drag ? 'grabbing' : hover ? 'pointer' : 'grab';
        if (!reducedMotion) render();
      }
      const render = () => { if (!disposed && !document.hidden && !frame) frame = window.requestAnimationFrame(draw); };
      const resize = () => { const box = cv.getBoundingClientRect(); width = box.width; height = box.height; const ratio = Math.min(window.devicePixelRatio || 1, 2); cv.width = Math.round(width * ratio); cv.height = Math.round(height * ratio); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); render(); };
      const clear = () => { selected = null; hover = null; pointer = null; yawVelocity = pitchVelocity = 0; };
      const handlers = {
        pointerdown: event => {
          if (event.button !== 0 || drag) return;
          const p = point(event), touch = event.pointerType === 'touch';
          drag = { target: hit(p, touch), id: event.pointerId, start: p, last: p, moved: false, pan: event.shiftKey, touch };
          pointer = touch ? null : p; yawVelocity = pitchVelocity = 0; cv.setPointerCapture(event.pointerId); render();
        },
        pointermove: event => {
          const p = point(event);
          if (drag && drag.id === event.pointerId) {
            const dx = p.x - drag.last.x, dy = p.y - drag.last.y; drag.moved ||= Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 5;
            if (drag.moved) {
              if (drag.pan) { targetX += dx; targetY += dy; }
              else { yaw += dx * .006; pitch = Math.max(-1.3, Math.min(1.3, pitch + dy * .006)); yawVelocity = reducedMotion ? 0 : dx * .15; pitchVelocity = reducedMotion ? 0 : dy * .12; }
            }
            drag.last = p;
          } else if (event.pointerType !== 'touch') pointer = p;
          render();
        },
        pointerup: event => {
          if (!drag || drag.id !== event.pointerId) return;
          const { moved, target, touch } = drag; drag = null; if (cv.hasPointerCapture(event.pointerId)) cv.releasePointerCapture(event.pointerId);
          if (!moved) {
            if (!target || selected === target.key) { clear(); onSelect(null); }
            else { selected = target.key; onSelect(target.record); }
          }
          if (touch || moved) pointer = null; render();
        },
        pointercancel: event => { if (drag?.id !== event.pointerId) return; drag = null; pointer = null; yawVelocity = pitchVelocity = 0; if (cv.hasPointerCapture(event.pointerId)) cv.releasePointerCapture(event.pointerId); render(); },
        lostpointercapture: event => { if (drag?.id === event.pointerId) { drag = null; pointer = null; yawVelocity = pitchVelocity = 0; render(); } },
        pointerleave: () => { if (!drag) pointer = null; hover = null; render(); },
        wheel: event => {
          event.preventDefault(); const p = point(event), next = Math.max(.4, Math.min(3, targetZoom * Math.exp(-(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY) * .001))), factor = next / targetZoom;
          targetX = p.x - width / 2 + (targetX - p.x + width / 2) * factor; targetY = p.y - height / 2 + (targetY - p.y + height / 2) * factor; targetZoom = next; render();
        },
        dblclick: () => { targetZoom = 1; targetX = targetY = 0; yaw = -.35; pitch = .22; yawVelocity = pitchVelocity = 0; render(); }
      };
      const visibility = () => { window.cancelAnimationFrame(frame); frame = 0; lastTime = null; render(); };
      const observer = new ResizeObserver(resize);
      const api = {
        select(record) { if (record) selected = record.type + ':' + record.id; else clear(); render(); },
        dispose() { if (disposed) return; disposed = true; window.cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', visibility); for (const [name, handler] of Object.entries(handlers)) cv.removeEventListener(name, handler); if (drag && cv.hasPointerCapture(drag.id)) cv.releasePointerCapture(drag.id); drag = null; nebula.dispose(); cv.width = cv.height = 1; }
      };
      try { for (const [name, handler] of Object.entries(handlers)) cv.addEventListener(name, handler, name === 'wheel' ? { passive: false } : undefined); document.addEventListener('visibilitychange', visibility); observer.observe(cv); resize(); }
      catch (error) { api.dispose(); throw error; }
      return api;
    }

    /** Decorative textures and five dust orbits use painter-7/memory-starmap's visual treatment. These pixels never participate in record picking. */
    function createNebulaBackdrop(document) {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D is unavailable');
        const dotCache = {}, sprite = {}, regionTextures = {};
        const focusTexture = makeNebula('#ffd6f2', '#a97bff', 168, 211, 1.1);
        let orbitRadius = 120;
        let W = 0, H = 0, DPR = 1, MOBILE = false, T = 0, focal = 900, bgCv = null, orbits = [];
        let yaw = -.35, pitch = .22;
        const fogMain = makeNebula('#f4eeff', '#8f6bff', 300, 11, 1.22);
        const fogCool = makeNebula('#d8ecff', '#4f7fd8', 300, 29, .92);
        const coreGlow = makeNebula('#ffffff', '#ffd9f4', 190, 47, .88);
        const fogSoft = { memory: makeNebula('#ffffff', '#7fc8ff', 168, 101, 1.04) };
        sprite.memory = makeSprite('#7fc8ff', .58);
        sprite.task = makeSprite('#ff8fc7', .58);
        function project(x, y, z) {
            const rx = x * Math.cos(yaw) + z * Math.sin(yaw), rz = z * Math.cos(yaw) - x * Math.sin(yaw);
            return [rx, y * Math.cos(pitch) - rz * Math.sin(pitch), rz * Math.cos(pitch) + y * Math.sin(pitch)];
        }
        function makeSprite(color, lum) {
            var s = 64, c = document.createElement('canvas');
            c.width = c.height = s;
            var g = c.getContext('2d');
            var L = (lum == null) ? 1 : lum;
            var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
            grd.addColorStop(0, 'rgba(255,255,255,' + (0.92 * L).toFixed(3) + ')');
            grd.addColorStop(0.18, hexA(color, 0.86 * L));
            grd.addColorStop(0.44, hexA(color, 0.62 * L));
            grd.addColorStop(0.72, hexA(color, 0.24 * L));
            grd.addColorStop(0.90, hexA(color, 0.07 * L));
            grd.addColorStop(1, hexA(color, 0));
            g.fillStyle = grd;
            g.fillRect(0, 0, s, s);
            return c;
        }
        function hexA(hex, a) {
            var h = hex.replace('#', '');
            var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
            return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        }
        function hashN(v) {
            v = (v ^ 61) ^ (v >>> 16);
            v = (v + (v << 3)) | 0;
            v = v ^ (v >>> 4);
            v = Math.imul(v, 0x27d4eb2d);
            v = v ^ (v >>> 15);
            return v >>> 0;
        }
        function buildBackdrop() {
            if (!W || !H)
                return;
            bgCv = document.createElement('canvas');
            bgCv.width = Math.max(2, Math.floor(W));
            bgCv.height = Math.max(2, Math.floor(H));
            var g = bgCv.getContext('2d');
            g.fillStyle = 'rgba(4,6,13,0.20)';
            g.fillRect(0, 0, W, H);
            var cx = W / 2, cy = H * 0.47;
            var R = Math.max(W, H) * 0.78;
            var grd = g.createRadialGradient(cx, cy, 0, cx, cy, R);
            grd.addColorStop(0, 'rgba(34,24,70,0.30)');
            grd.addColorStop(0.34, 'rgba(16,18,46,0.22)');
            grd.addColorStop(0.70, 'rgba(7,10,22,0.13)');
            grd.addColorStop(1, 'rgba(3,4,10,0)');
            g.fillStyle = grd;
            g.fillRect(0, 0, W, H);
            var vg = g.createRadialGradient(cx, cy, Math.min(W, H) * 0.38, cx, cy, Math.max(W, H) * 0.80);
            vg.addColorStop(0, 'rgba(0,0,0,0)');
            vg.addColorStop(0.72, 'rgba(0,0,0,0.26)');
            vg.addColorStop(1, 'rgba(0,0,0,0.66)');
            g.fillStyle = vg;
            g.fillRect(0, 0, W, H);
        }
        function drawDust() {
            var n = Math.floor((MOBILE ? 54 : 120) * 1);
            for (var s = 0; s < n; s++) {
                var h = hashN(s * 2654435 + 7);
                var ax = (h % 10000) / 10000 * W;
                var ay = ((h >>> 14) % 10000) / 10000 * H;
                var ph = ((h >>> 26) % 100) / 100;
                var tw = 0.5 + 0.5 * Math.sin(T * (0.55 + ph) + ph * 6.28);
                var sz = 0.8 + ph * 1.5;
                ctx.globalAlpha = (0.12 + 0.52 * tw * ph);
                ctx.fillStyle = (s % 7 === 0) ? '#cfd8ff' : '#8fb4ff';
                ctx.fillRect(ax, ay, sz, sz);
            }
            ctx.globalAlpha = 1;
        }
        function dotSprite(color) {
            var c = dotCache[color];
            if (c)
                return c;
            var s = 24, cv = document.createElement('canvas');
            cv.width = cv.height = s;
            var g = cv.getContext('2d');
            var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
            grd.addColorStop(0, hexA(color, 1));
            grd.addColorStop(0.50, hexA(color, 0.95));
            grd.addColorStop(0.80, hexA(color, 0.18));
            grd.addColorStop(1, hexA(color, 0));
            g.fillStyle = grd;
            g.fillRect(0, 0, s, s);
            dotCache[color] = cv;
            return cv;
        }
        function rgbOf(hex) {
            var h = hex.replace('#', '');
            return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
        }
        function nz(x, y, seed) {
            var xi = Math.floor(x), yi = Math.floor(y);
            var xf = x - xi, yf = y - yi;
            var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
            var s = seed * 2654435;
            var h00 = (hashN((xi * 374761 + yi * 668265 + s) | 0) % 4096) / 4096;
            var h10 = (hashN(((xi + 1) * 374761 + yi * 668265 + s) | 0) % 4096) / 4096;
            var h01 = (hashN((xi * 374761 + (yi + 1) * 668265 + s) | 0) % 4096) / 4096;
            var h11 = (hashN(((xi + 1) * 374761 + (yi + 1) * 668265 + s) | 0) % 4096) / 4096;
            var a = h00 + (h10 - h00) * u, b = h01 + (h11 - h01) * u;
            return a + (b - a) * v;
        }
        function fbm(x, y, seed, oct) {
            var sum = 0, amp = 0.5, tot = 0, f = 1;
            for (var i = 0; i < oct; i++) {
                sum += nz(x * f, y * f, seed + i * 71) * amp;
                tot += amp;
                amp *= 0.52;
                f *= 2.07;
            }
            return sum / tot;
        }
        function makeNebula(inner, outer, size, seed, strength) {
            var s = size || 256, c = document.createElement('canvas');
            c.width = c.height = s;
            var g = c.getContext('2d');
            var img = g.createImageData(s, s), d = img.data;
            var A = rgbOf(inner), B = rgbOf(outer);
            var half = s / 2, inv = 1 / half;
            var str = (strength == null) ? 1 : strength;
            var x, y, p;
            for (y = 0; y < s; y++) {
                var dy = (y + 0.5 - half) * inv;
                for (x = 0; x < s; x++) {
                    var dx = (x + 0.5 - half) * inv;
                    var r = Math.sqrt(dx * dx + dy * dy);
                    if (r > 1.02)
                        continue;
                    var th = Math.atan2(dy, dx);
                    var nx = Math.cos(th) * r * 6.2 + 3.1;
                    var ny = (Math.sin(th) * r * 6.2 + 1.9 + r * 2.2) * 0.62;
                    var v = fbm(nx, ny, seed, 5);
                    var armS = Math.sin(th * 2 + r * 3.6 - v * 1.8);
                    var swirl = armS > 0 ? Math.pow(armS, 1.90) : 0;
                    var m = Math.pow(Math.max(0, 1 - r), 1.35);
                    var t2 = v * 2.10 - 0.62;
                    if (t2 <= 0)
                        continue;
                    var a = Math.pow(t2, 1.45) * m * (0.11 + 1.30 * swirl) * str;
                    if (a <= 0.004)
                        continue;
                    if (a > 0.96)
                        a = 0.96;
                    var mix = (v - 0.32) * 2.5;
                    if (mix < 0)
                        mix = 0;
                    if (mix > 1)
                        mix = 1;
                    p = (y * s + x) * 4;
                    d[p] = A[0] + (B[0] - A[0]) * mix;
                    d[p + 1] = A[1] + (B[1] - A[1]) * mix;
                    d[p + 2] = A[2] + (B[2] - A[2]) * mix;
                    d[p + 3] = a * 255;
                }
            }
            g.putImageData(img, 0, 0);
            var cnt = Math.floor(s * 0.55);
            for (var i = 0; i < cnt; i++) {
                var h = hashN(i * 7919 + seed * 131 + 13);
                var rd = Math.sqrt((h % 1000) / 1000) * half * 0.94;
                var tha = ((h >>> 10) % 3600) / 3600 * 6.2832;
                g.globalAlpha = 0.03 + ((h >>> 20) % 100) / 1500;
                g.fillStyle = '#ffffff';
                g.fillRect(half + Math.cos(tha) * rd, half + Math.sin(tha) * rd * 0.82, 1.4, 1.4);
            }
            g.globalAlpha = 1;
            return c;
        }
        function initOrbits() {
            var R = orbitRadius;
            orbits = [
                { r: R * 1.12, tilt: -0.44, yaw0: 1.15, spd: -0.036, color: '#8fc6ff', a: 0.52, bs: 0.37, ph: 1.85, gk: 1.18, dots: [], dust: [], stars: [] },
                { r: R * 1.40, tilt: 0.58, yaw0: 2.40, spd: 0.023, color: '#9fe6ff', a: 0.40, bs: 0.30, ph: 3.60, gk: 1.45, dots: [], dust: [], stars: [] },
                { r: R * 1.72, tilt: -0.22, yaw0: 0.62, spd: -0.017, color: '#aac9ff', a: 0.30, bs: 0.25, ph: 5.10, gk: 0.98, dots: [], dust: [], stars: [] },
                { r: R * 2.06, tilt: 0.34, yaw0: 1.88, spd: 0.013, color: '#bcb6ff', a: 0.22, bs: 0.21, ph: 2.65, gk: 0.80, dots: [], dust: [], stars: [] },
                { r: R * 2.44, tilt: -0.55, yaw0: 3.10, spd: -0.010, color: '#d6b8ff', a: 0.15, bs: 0.18, ph: 4.30, gk: 0.64, dots: [], dust: [], stars: [] }
            ];
            for (var oi = 0; oi < orbits.length; oi++) {
                var o = orbits[oi], cnt = (MOBILE ? 5 : 8) - Math.min(oi, 4);
                for (var i = 0; i < cnt; i++) {
                    var h = hashN(oi * 7717 + i * 131 + 3);
                    o.dots.push({
                        ph: (h % 1000) / 1000,
                        sz: 0.5 + ((h >>> 8) % 100) / 90,
                        sp: 0.7 + ((h >>> 16) % 100) / 180,
                        warm: ((h >>> 22) % 2) === 0
                    });
                }
                var dN = Math.round((MOBILE ? 165 : 300) * (1.12 + oi * 0.33) * 1);
                for (var d = 0; d < dN; d++) {
                    var hd = hashN(oi * 91193 + d * 7919 + 11);
                    var dAng = ((hd % 4096) / 4096) * 6.2832;
                    o.dust.push({
                        ang: dAng,
                        rr: 1 + (((hd >>> 12) % 200) / 200 - 0.5) * 0.032,
                        jy: ((((hd >>> 20) % 200) / 200) - 0.5) * o.r * 0.055,
                        sz: 0.7 + ((hd >>> 4) % 100) / 100 * 1.6,
                        a: 0.30 + ((hd >>> 8) % 100) / 100 * 0.70,
                        ph: ((hd >>> 16) % 1000) / 1000 * 6.2832,
                        sp: 0.82 + ((hd >>> 24) % 100) / 100 * 2.30,
                        warm: ((hd >>> 3) % 5) === 0
                    });
                }
                var sN = Math.round((MOBILE ? 14 : 28) * (1 - oi * 0.12));
                for (var s2 = 0; s2 < sN; s2++) {
                    var hs = hashN(oi * 31337 + s2 * 7919 + 97);
                    o.stars.push({
                        ang: ((hs % 4096) / 4096) * 6.2832,
                        rr: 1 + (((hs >>> 12) % 120) / 120 - 0.5) * 0.020,
                        jy: ((((hs >>> 20) % 200) / 200) - 0.5) * o.r * 0.035,
                        sz: 1.5 + ((hs >>> 4) % 100) / 100 * 1.7,
                        ph: ((hs >>> 8) % 1000) / 1000 * 6.2832,
                        sp: 1.42 + ((hs >>> 18) % 100) / 100 * 4.05,
                        warm: ((hs >>> 6) % 6) === 0
                    });
                }
            }
        }
        function orbitPoint(o, ang, rr, dy) {
            var rad = (rr == null) ? o.r : rr;
            var x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
            var ct = Math.cos(o.tilt), st = Math.sin(o.tilt);
            var y1 = -z * st + (dy || 0), z1 = z * ct;
            var yw = o.yaw0 + T * o.spd;
            var cyw = Math.cos(yw), syw = Math.sin(yw);
            return [x * cyw + z1 * syw, y1, -x * syw + z1 * cyw];
        }
        function drawFog(cx, cy) {
            if (!fogMain)
                return;
            var base = Math.min(W, H) * (MOBILE ? 0.92 : 0.80);
            var dim = (MOBILE ? 0.58 : 0.50);
            var layers = 2;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (var k = 0; k < layers; k++) {
                var ph = T * 0.05 + k * 0.85;
                var sc = base * (1 - k * 0.24) * (1 + 0.028 * Math.sin(T * 0.27 + k * 1.9));
                var dx = Math.cos(ph) * base * 0.042;
                var dy = Math.sin(ph * 0.77) * base * 0.038;
                ctx.save();
                ctx.translate(cx + dx, cy + dy);
                ctx.rotate(T * 0.052 + k * 0.19);
                var breathA = 1 + 0.075 * Math.sin(T * (0.30 + k * 0.11) + k * 2.1);
                ctx.globalAlpha = (k === 0 ? 0.54 : 0.30) * dim * breathA;
                ctx.drawImage(k === 1 ? fogCool : fogMain, -sc, -sc * 0.82, sc * 2, sc * 1.64);
                ctx.restore();
            }
            ctx.restore();
            ctx.globalAlpha = 1;
        }
        function drawCore(cx, cy) {
            if (!coreGlow)
                return;
            var base = Math.min(W, H);
            var dim = 1;
            var R = base * (MOBILE ? 0.34 : 0.31);
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = (0.38 + 0.085 * Math.sin(T * 0.8)) * dim;
            ctx.drawImage(coreGlow, cx - R, cy - R, R * 2, R * 2);
            var cr = base * (MOBILE ? 0.076 : 0.062) * (1 + 0.035 * Math.sin(T * 0.9));
            var rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
            rg.addColorStop(0, 'rgba(255,252,255,0.72)');
            rg.addColorStop(0.22, 'rgba(232,224,255,0.38)');
            rg.addColorStop(0.55, 'rgba(168,150,255,0.14)');
            rg.addColorStop(1, 'rgba(120,110,255,0)');
            ctx.globalAlpha = 0.70 * dim;
            ctx.fillStyle = rg;
            ctx.beginPath();
            ctx.arc(cx, cy, cr, 0, 6.2832);
            ctx.fill();
            var arms = MOBILE ? 2 : 3;
            var spin = T * 0.09, i, u, ang, rr, px2, py2;
            for (var a = 0; a < arms; a++) {
                var off = a * 6.2832 / arms + spin;
                ctx.beginPath();
                for (i = 0; i <= 30; i++) {
                    u = i / 30;
                    ang = off + u * 2.7;
                    rr = base * (0.04 + u * 0.24);
                    px2 = cx + Math.cos(ang) * rr;
                    py2 = cy + Math.sin(ang) * rr * 0.62;
                    if (i === 0)
                        ctx.moveTo(px2, py2);
                    else
                        ctx.lineTo(px2, py2);
                }
                ctx.strokeStyle = '#8f7bff';
                ctx.lineWidth = MOBILE ? 5.0 : 6.5;
                ctx.globalAlpha = (0.10 - a * 0.025) * dim;
                ctx.stroke();
            }
            ctx.globalAlpha = 0.08 * dim;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            var L1 = base * 0.30, L2 = base * 0.19;
            ctx.beginPath();
            ctx.moveTo(cx - L1, cy);
            ctx.lineTo(cx + L1, cy);
            ctx.moveTo(cx, cy - L2);
            ctx.lineTo(cx, cy + L2);
            ctx.stroke();
            if (fogMain) {
                var fR = base * (MOBILE ? 0.62 : 0.54);
                ctx.globalAlpha = 0.22 * dim;
                ctx.drawImage(fogMain, cx - fR, cy - fR * 0.84, fR * 2, fR * 1.68);
            }
            ctx.restore();
            ctx.globalAlpha = 1;
        }
        function drawOrbits(cx, cy) {
            if (!orbits.length)
                return;
            var fade = 1;
            for (var oi = 0; oi < orbits.length; oi++) {
                var o = orbits[oi];
                var br = 0.70 + 0.30 * Math.sin(T * o.bs + o.ph);
                var dust = o.dust, dstep = 1;
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                for (var di = 0; di < dust.length; di += dstep) {
                    var q = dust[di];
                    var wd = orbitPoint(o, q.ang, o.r * q.rr, q.jy);
                    var pd = project(wd[0], wd[1], wd[2]);
                    var kd = focal / Math.max(420 + pd[2], 60);
                    var DX = cx + pd[0] * kd, DY = cy + pd[1] * kd;
                    if (DX < -30 || DX > W + 30 || DY < -30 || DY > H + 30)
                        continue;
                    var nd = 1 - Math.min(Math.abs(pd[2]) / 700, 0.76);
                    var twd = 0.5 + 0.5 * Math.sin(T * q.sp + q.ph);
                    ctx.globalAlpha = Math.min(1, (0.30 + 0.52 * twd) * q.a * nd * fade * (0.86 + o.a * 1.15) * 1.34);
                    var sbase = q.sz * (0.95 + nd * 0.65) * (focal / 1020);
                    var spr = dotSprite(q.warm ? '#ffeadc' : o.color);
                    var dd = Math.max(1.25, sbase * 2.2);
                    ctx.drawImage(spr, Math.round((DX - dd * 0.5) * DPR) / DPR, Math.round((DY - dd * 0.5) * DPR) / DPR, dd, dd);
                }
                ctx.restore();
                var stars = o.stars;
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                for (var si = 0; si < stars.length; si++) {
                    var st = stars[si];
                    var ws = orbitPoint(o, st.ang, o.r * st.rr, st.jy);
                    var ps = project(ws[0], ws[1], ws[2]);
                    var ks = focal / Math.max(420 + ps[2], 60);
                    var SX = cx + ps[0] * ks, SY = cy + ps[1] * ks;
                    if (SX < -40 || SX > W + 40 || SY < -40 || SY > H + 40)
                        continue;
                    var ns = 1 - Math.min(Math.abs(ps[2]) / 760, 0.80);
                    var twk = Math.pow(0.5 + 0.5 * Math.sin(T * st.sp + st.ph), 2.2);
                    var rs = st.sz * (MOBILE ? 2.2 : 2.9) * (0.55 + twk * 1.6) * (0.85 + ns * 0.4);
                    ctx.globalAlpha = Math.min(1, (0.24 + 0.80 * twk) * ns * fade * (0.58 + 0.42 * o.a) * (0.85 + 0.30 * br));
                    ctx.drawImage(st.warm ? sprite.task : sprite.memory, SX - rs, SY - rs, rs * 2, rs * 2);
                }
                ctx.restore();
                for (var d = 0; d < o.dots.length; d++) {
                    var q2 = o.dots[d];
                    var baseAng = T * o.spd * 1.9 * q2.sp + q2.ph * 6.2832;
                    for (var tg = 3; tg >= 0; tg--) {
                        var wa = orbitPoint(o, baseAng - tg * 0.013 * (o.spd > 0 ? 1 : -1));
                        var pf = project(wa[0], wa[1], wa[2]);
                        var kk = focal / Math.max(420 + pf[2], 60);
                        var DX2 = cx + pf[0] * kk, DY2 = cy + pf[1] * kk;
                        if (DX2 < -40 || DX2 > W + 40 || DY2 < -40 || DY2 > H + 40)
                            continue;
                        var near2 = 1 - Math.min(Math.abs(pf[2]) / 700, 0.76);
                        var sz = (MOBILE ? 2.4 : 3.0) * q2.sz * (1 - tg * 0.17) * (0.8 + near2 * 0.55);
                        ctx.globalAlpha = (tg === 0 ? 0.72 : 0.22 / tg) * near2 * fade;
                        ctx.drawImage(q2.warm ? sprite.task : sprite.memory, DX2 - sz, DY2 - sz, sz * 2, sz * 2);
                    }
                }
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                var bloomN = MOBILE ? 3 : 5;
                for (var bi = 0; bi < bloomN; bi++) {
                    var bAng = bi / bloomN * 6.2832 + T * o.spd * 0.35;
                    var bw2 = orbitPoint(o, bAng);
                    var bp2 = project(bw2[0], bw2[1], bw2[2]);
                    var bk2 = focal / Math.max(420 + bp2[2], 60);
                    var BX = cx + bp2[0] * bk2, BY = cy + bp2[1] * bk2;
                    var bn = 1 - Math.min(Math.abs(bp2[2]) / 700, 0.78);
                    if (BX < -W * 0.25 || BX > W * 1.25 || BY < -H * 0.25 || BY > H * 1.25)
                        continue;
                    for (var pu = 0; pu < 3; pu++) {
                        var cyp = (T * 0.11 + bi / bloomN + pu / 3) % 1;
                        var rr2 = Math.min(W, H) * (0.030 + 0.105 * cyp);
                        ctx.globalAlpha = 0.34 * Math.sin(cyp * Math.PI) * bn * (0.45 + 0.55 * o.a) * fade;
                        ctx.drawImage(fogSoft.memory || fogMain, BX - rr2, BY - rr2, rr2 * 2, rr2 * 2);
                    }
                    var cs = (MOBILE ? 2.6 : 3.4) * (0.85 + bn * 0.6);
                    ctx.globalAlpha = Math.min(1, 0.95 * bn * (0.55 + 0.45 * o.a) * fade);
                    ctx.drawImage(sprite.memory, BX - cs, BY - cs, cs * 2, cs * 2);
                }
                ctx.restore();
            }
            ctx.lineCap = 'butt';
            ctx.globalAlpha = 1;
        }
        return {
            draw(target, view) {
                const mobile = view.width <= 900 || Math.min(view.width, view.height) < 560;
                if (!orbits.length || mobile !== MOBILE || orbitRadius !== view.orbitRadius) { MOBILE = mobile; orbitRadius = view.orbitRadius; initOrbits(); }
                if (W !== view.width || H !== view.height || DPR !== view.pixelRatio) {
                    W = view.width; H = view.height; DPR = view.pixelRatio;
                    canvas.width = Math.max(1, Math.round(W * DPR)); canvas.height = Math.max(1, Math.round(H * DPR));
                    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
                    buildBackdrop();
                }
                T = view.time; yaw = view.yaw; pitch = view.pitch;
                focal = Math.min(W, H) * (MOBILE ? 1.34 : 1.02) * view.zoom;
                const cx = W / 2 + view.panX, cy = H / 2 + view.panY;
                ctx.clearRect(0, 0, W, H);
                ctx.drawImage(bgCv, 0, 0, W, H);
                drawDust(); drawFog(cx, cy); drawCore(cx, cy);
                ctx.save(); ctx.globalCompositeOperation = 'lighter';
                for (const region of view.regions) {
                    const texture = regionTextures[region.type] ??= makeNebula('#ffffff', region.color, 168, 101, 1.04);
                    const radius = region.radius;
                    ctx.save(); ctx.translate(region.px, region.py); ctx.rotate(Math.sin(T * .05 + region.depth) * .30);
                    ctx.globalAlpha = (.38 + .025 * Math.sin(T * .38 + region.depth)) * Math.max(.5, 1 - Math.abs(region.depth) * .3);
                    ctx.drawImage(texture, -radius, -radius, radius * 2, radius * 2);
                    ctx.globalAlpha *= .52; ctx.drawImage(texture, -radius * .56, -radius * .8, radius * 1.4, radius * 1.4); ctx.restore();
                }
                ctx.restore(); drawOrbits(cx, cy);
                target.drawImage(canvas, 0, 0, W, H);
            },
            focus(target, x, y, radius, amount) {
                target.save(); target.globalCompositeOperation = 'lighter'; target.globalAlpha = .40 * amount;
                target.drawImage(focusTexture, x - radius * 2.2, y - radius * 2.2, radius * 4.4, radius * 4.4); target.restore();
            },
            dispose() { for (const texture of [canvas, bgCv, fogMain, fogCool, coreGlow, focusTexture, ...Object.values(regionTextures), ...Object.values(fogSoft), ...Object.values(sprite), ...Object.values(dotCache)]) if (texture) { texture.width = 1; texture.height = 1; } }
        };
    }

    const React = require('react');
    const h = React.createElement;
    const { Button, Switch, Checkbox, Menu, Tooltip, IconRefreshOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconChevronLeftOutlineRegular, IconCloseOutlineRegular, IconChecklistOutlineRegular, IconBranchOutlineRegular, IconPanelLeftOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
    const glyphs = { panel: IconPanelLeftOutlineRegular, checklist: IconChecklistOutlineRegular, memory: IconBranchOutlineRegular, refresh: IconRefreshOutlineRegular, close: IconCloseOutlineRegular, chevron: IconChevronRightOutlineRegular, back: IconChevronLeftOutlineRegular };
    const Glyph = ({ name, className = '' }) => h(glyphs[name], { size: 18, className: `pac-glyph pac-glyph-${name} ${className}`, 'aria-hidden': true });
    const NS = 'personal-agent-core';
    const PANEL = 'personal-agent-core';

    const zh = {
      mainSessionGroup: "主会话",
      mainSessionTitle: "主会话名称",
      mainSessionTitleHint: "修改后自动生效；清空时按“名称-废弃会话-1、2、3…”命名旧会话，编号连续递增",
      mainSessionTitleError: "名称不能为空，最多 48 字节（约 16 个汉字）",
      mainSessionGroupHint: "管理桌面与微信共用的唯一对话，记忆系统独立保留",
      mainSessionClear: "清空主会话历史",
      mainSessionClearHint: "同步有效对话、归档旧会话并新建空会话。保留记忆、任务、设置和微信登录；旧会话的待处理消息、回复和审批不会转入新会话。",
      mainSessionClearConfirm: "清空当前主会话历史并开始新对话？\n\n旧会话的有效对话会同步到记忆系统，原会话归档保留。已有记忆、任务和设置不会删除；微信保持登录并自动切换到新主会话。旧会话的待处理消息、回复和审批不会转入新会话。\n\n主会话运行期间无法清空。",
      mainSessionClearing: "正在清理主会话…",
      mainSessionClearDraining: "正在暂停微信收发并检查会话状态…",
      mainSessionClearSyncing: "正在同步旧会话的有效对话…",
      mainSessionClearCreating: "正在创建新主会话并更新微信关联…",
      mainSessionCleared: "已创建空白主会话，旧会话已归档；记忆、任务和微信登录已保留",
      "jobsHint": "查看定时任务的执行情况、下次运行时间和最近错误",
      "wechatInteractionTtlMsHint": "微信问题或审批等待答复的时间，过期后不能继续确认",
      "wechatBackoffMaxMsHint": "连接失败后逐渐延长重试间隔，此值限制最长等待时间",
      "wechatSendBudgetHint": "每次收到微信消息后允许连续发送的条数，仍受服务端限制",
      "wechatContextTtlMsHint": "超过此时间需从微信再发消息刷新回复凭证；服务端可能更早使其失效",
      "wechatRemoteApprovalEnabledHint": "允许在微信确认单次操作，不提供永久授权",
      "wechatMirrorUserEnabledHint": "将你在桌面主会话输入的原文同步到本人微信",
      "codexWorkerHint": "启用后同步 Codex 历史，并连接服务以新建、续接或按要求分叉任务；关闭会断开连接并清理可移除的本地历史镜像",
      "workerHeartbeatEnabledHint": "让运行中的任务持续持有工作区写入资格",
      "workerHeartbeatMsHint": "执行仍在运行时续期写租约，间隔须小于租约有效期的一半",
      "leaseTtlMsHint": "限制同一工作区的并发写入；执行中由心跳续期",
      "routeAmbiguityGapHint": "前两名候选得分过于接近时不直接复用；此值越大越谨慎",
      "routeResumeThresholdHint": "关联得分达到此值才考虑复用已有执行会话，越高越保守",
      "workerBudgetMsHint": "一次 Worker 执行允许持续的最长时间",
      "memoryExtractionBudgetMsHint": "每次记忆提炼模型请求的最长等待时间",
      "memoryExtractionRetryLimitHint": "达到上限的失败作业需在提炼记录中手动重试",
      "memoryExtractionBatchSizeHint": "一次调度最多处理的任务批次，调高会增加本轮模型调用量",
      "backgroundModelPolicyHint": "选择 Worker 设置中定义的 DSH 模型策略；不指定时沿用默认模型",
      "analysisOutputCharsHint": "限制每次后台分析生成的文字量，过小可能截断结构化结果",
      "analysisInputCharsHint": "限制每次后台分析读取的文字量，较大会增加模型用量",
      "analysisBudgetMsHint": "每次任务关联分析最多等待多久；记忆提炼使用自己的时限",
      "semanticRoutingEnabledHint": "结合任务含义补充关联候选，会产生后台模型调用",
      "gib": "GiB",
      "archiveCapacityBytesHint": "达到上限后暂停新增历史写入，可提高上限或手动清理记录",
      "candidateReviewDaysHint": "候选记忆超过此天数会提示待复核，不会自动确认或删除",
      "hotHistoryDaysHint": "超过此天数的正文可转入压缩归档，原始来源保持不变",
      "historyRetentionDaysHint": "未指定日期时默认查询最近多少天，不限制历史导入范围",
      "wechatGroupHint": "让本人微信与私人助理桌面页面共用主会话，接收消息并同步最终答复",
      "workerGroupHint": "Worker 是替助理执行具体任务的工作会话，可使用 DSH 或 Codex",
      "analysisGroupHint": "后台会调用模型提炼记忆、判断任务关联；这里设置语言、模型和每次分析的资源限制",
      "cleanupGroupHint": "压缩较早的对话正文，控制存储用量；归档内容仍可检索",
      "backupGroupHint": "定期备份本地记忆与任务数据库，保留指定数量的备份用于恢复",
      "inboxGroupHint": "重新处理尚未写入任务账本的 Codex 事件，帮助恢复中断的状态同步",
      "memoryGroupHint": "从同步的对话中整理任务、过程和候选记忆，供以后查找与引用",
      "historyGroupHint": "将 DSH 与已启用的 Codex 历史同步到本地，供助理检索和提炼记忆",
      "settingsRestoreConfirm": "将这些设置恢复为配置默认值并立即应用？Codex 开关保持现状",
      "settingsRestoreHint": "恢复当前配置提供的默认值；Codex 开关保持现状",
      "settingsPending": "等待应用修改…",
      "settingsAutoApply": "修改自动生效",
      "wechatGroup": "微信接入",
      "wechatResumeRestored": "确认恢复微信同步",
      "wechatResumeConfirm": "从当前主会话重新开始同步；备份中的旧输入不会自动执行，旧待发内容将被隔离。是否继续？",
      "wechatPreviousBinding": "旧绑定记录",
      "wechatEnabled": "启用微信通道",
      "wechatSyncRepliesEnabled": "同步主会话最终答复",
      "wechatMirrorUserEnabled": "镜像桌面用户原文",
      "wechatRemoteApprovalEnabled": "允许微信一次性远程审批",
      "wechatHint": "微信与桌面共用同一个主会话和权限。请勿让其他微信插件同时使用同一机器人账号。远程审批默认关闭，不支持永久授权。",
      "wechatDisabledHint": "启用微信通道后即可扫码连接私人助理",
      "wechatOpenMain": "打开主会话",
      "wechatSharedMain": "微信与私人助理页面共用唯一主会话，无需另行绑定",
      "wechatSendRetryLimit": "连接未建立时的重试次数",
      "wechatConnection": "连接状态",
      "wechatLogin": "扫码连接私人助理",
      "wechatIdentityDetails": "账号标识",
      "wechatIdentity_local": "已绑定 · 此前已在本地确认",
      "wechatIdentity_verified": "已绑定 · 与扫码账号一致",
      "wechatIdentity_mismatch": "收到的消息与扫码账号不一致，尚未绑定；请使用扫码账号发送消息",
      "wechatIdentity_waiting-message": "请从扫码使用的微信发送一条消息，系统将自动验证并绑定",
      "wechatIdentity_scan-required": "需重新扫码以验证账号身份",
      "wechatIdentity_unbound": "尚未连接微信",
      "wechatLoginHint": "使用本人微信扫码，即授权该账号连接私人助理主会话；从扫码账号发送消息后自动核验绑定",
      "wechatCancelLogin": "取消登录",
      "wechatUnlink": "解绑微信",
      "wechatUnlinkConfirm": "解绑会停止收发并撤销登录凭证。旧队列不会发送给新身份。继续？",
      "wechatQrAlt": "微信登录二维码",
      "wechatScanToLogin": "使用本人微信扫码登录",
      "wechatScanned": "已扫码，请在手机确认",
      "wechatOwner": "本人微信身份",
      "wechatQueue": "收发队列（最多显示 50 条待处理记录）",
      "wechatQueueEmpty": "暂无待处理消息",
      "wechatRetryInput": "核对并重试输入",
      "wechatRetrySend": "重试发送",
      "wechatDiscard": "跳过发送",
      "wechatUnknownRetryConfirm": "发送结果未知，请先核对手机。再次发送可能重复，确定重发？",
      "wechatDiscardConfirm": "跳过这段待发内容？完整答复仍保留在原主会话中。",
      "wechatRequestTimeout": "请求超时",
      "wechatPollTimeout": "长轮询超时",
      "wechatBackoff": "重连退避上限",
      "wechatMessageChars": "每段文字上限",
      "wechatQueueCapacity": "队列容量",
      "wechatRetention": "已完成记录正文保留",
      "wechatInteractionTimeout": "应答有效期",
      "wechatContextTimeout": "回复凭证有效期",
      "wechatSendBudget": "每次互动发送预算",
      "wechatStatus_disabled": "未启用",
      "wechatStatus_login-required": "需要扫码登录",
      "wechatStatus_restore-hold": "备份恢复后暂停",
      "wechatStatus_binding-required": "等待扫码账号验证",
      "wechatStatus_connecting": "连接中",
      "wechatStatus_connected": "已连接",
      "wechatStatus_waiting-interaction": "等待微信互动",
      "wechatStatus_occupied": "账号被占用",
      "wechatStatus_error": "需要处理",
      "wechatStatus_login-pending": "等待扫码",
      "wechatQueue_pending": "待发",
      "wechatQueue_sending": "正在发送",
      "wechatQueue_accepted": "服务端已接受",
      "wechatQueue_unknown": "发送结果未知",
      "wechatQueue_waiting": "等待互动",
      "wechatQueue_failed": "失败",
      "wechatQueue_held": "输入暂停",
      "wechatQueue_dispatching": "输入接受待核对",
      "wechatQueue_completed": "已处理",
      "wechatQueue_command": "控制指令已处理",

      memoryClearSelection: '取消选中', memoryClearSelectionHint: '点击空白处、再次点击选中对象或按 Esc 取消选中',
      memoryDerivedRelation: '此关联来自会话任务及其记忆、实体记录，随任务内容更新', memoryStoredRelation: '此关系连接以下两个对象，可查看端点及来源',
      memoryRelationFrom: '起点', memoryRelationTo: '终点',
      graphLoaded:"星云已加载节点",
      graphContext:"空心节点为补充关联",
      needsReview:"待复核候选",
      defaultLanguageHint:"用于记忆提炼等后台生成内容，主会话跟随你的对话语言",
      sessionTask: "会话任务",
      defaultLanguage: "后台默认语言",
      languageSimplifiedChinese: "简体中文",
      languageEnglish: "English",
      "hotHistoryDays": "未压缩正文保留",
      "candidateReviewDays": "候选记忆复核提醒",
      "archiveCapacityBytes": "本地记忆容量上限",
      rawSearch: "搜索原始对话与执行记录",
      rawSearchHint: "在任务概述之外，检索用户消息、助手回复和工具输出",
      rawSupplementary: "尚未归属任务的原始记录",
      historyCoverage: "待归属会话",
      memoryProcess: "过程与结果",
      memoryManagement: "管理",
      historyMessages: "原始对话与来源",
      extractionRecent: "失败执行记录",
      noFailures: "暂无失败执行",
      memorySessions: "会话",
      memoryRawCount: "原始记录",
      rawMatches: "原文命中",
      retrySource: "重试读取来源",

      memoryInitialize: "初始化记忆",
      memoryInitializing: "正在初始化…",
      memoryInitializeConfirm: "初始化记忆将清空本插件的全部经历、记忆、实体、关系、任务和执行记录，以及关联的审批、队列、租约、基线、产物记录、用量、同步游标、提炼记录和托管数据库备份。保留配置、功能开关和私人助理主会话绑定；不会删除原始 DSH/Codex 会话或工作区文件。随后按当前配置重新导入历史，并恢复定时任务。此操作不可撤销，是否继续？",
      memoryInitializeDraining: "正在停止历史同步和记忆提炼，等待在途操作结束…",
      memoryInitializeClearing: "正在清空本地记忆和关联运行数据…",
      memoryInitializeImporting: "正在按当前配置重新导入历史…",
      memoryInitializeIndexing: "正在重建检索索引…",
      memoryInitialized: "记忆已初始化；历史按当前配置重新导入，候选记忆将由后续提炼逐步生成。",
      memoryInitializeFailed: "初始化未完成",
      memoryInitializeFailedAfterClear: "本地记录已清空，初始化未完成；请处理错误后重试",
      memoryInitializeStatusError: "无法读取初始化状态，请等待状态恢复后操作",
      memoryInitializeReconnecting: "正在恢复 Codex 连接…",

      extractionQueueErrors: "当前待处理作业的错误",
      extractionClose: "关闭提炼记录",
      extractionRecords: "记忆提炼 · 执行记录",  extractionRunning: "运行中", extractionQueued: "等待提炼", extractionIdle: "空闲", extractionDisabled: "定时已停用", extractionAttention: "需要关注", extractionUnavailable: "状态读取失败", extractionLoading: "读取状态中", extractionPending: "待处理作业", extractionFailed: "失败作业", extractionInput: "输入消息", extractionProcessed: "已处理", extractionLog: "查看执行日志", extractionHint: "提炼在后台子会话执行，日志保留在执行记录中。只有通过来源校验并写入记忆后，执行才会标记成功。", extractionRun_running: "运行中", extractionRun_succeeded: "已完成", extractionRun_failed: "失败", extractionRun_cancelled: "已取消", extractionRun_interrupted: "已中断",
      jobs: '后台运行状态', jobsRefresh: '刷新任务状态', jobHistory: '历史同步', jobHeartbeat: '执行租约心跳', jobInbox: '事件投影重试', jobMemory: '记忆提炼', jobCleanup: '历史归档', jobBackup: '账本备份', jobRunning: '运行中', jobScheduled: '已安排', jobDisabled: '定时执行已关闭', lastSuccess: '最近成功', nextRun: '下次运行', neverRun: '暂无记录', "settingsEffect": "管理记忆、后台任务与消息通道。修改自动生效，正在执行的操作按原配置收尾", settingsSource: '有效配置来源', savedSource: '账本中保存的设置', profileSource: 'Profile 配置及默认值', backlog: '积压与处理位置',
      settingsAdvanced: '高级设置', settingsRange: '请输入 {min} 到 {max}', "settingsValidationError": "部分设置尚未应用，请检查标记项", settingsHeartbeatError: '执行心跳间隔必须小于写租约有效期的一半。', settingsPresetError: '请选择已启用的 worker；DSH 模式必须在允许列表中。', settingsPresetReferenceError: '移除不可用的 preset，并检查默认 worker 模式。', settingsPolicyNameError: '策略名称不能为空且不能重复。', settingsRequired: '此项不能为空。', settingsPolicyReferenceError: '请选择适用于当前 Worker 的模型策略。', settingsAddPolicy: '添加模型策略', settingsRemovePolicy: '删除模型策略', settingsWorkerType: 'Worker 类型', settingsDshPreset: 'DSH preset', settingsCapabilities: '所需能力', settingsCapabilitiesHint: '用逗号分隔', settingsPolicy: '模型策略', settingsPolicyName: '策略名称', settingsProvider: '模型提供方 ID', settingsModel: '模型 ID', settingsEffort: '推理等级', settingsDefaultEffort: '沿用默认', settingsNoPolicy: '不指定', settingsUnnamedPolicy: '未命名策略', modelPoliciesHint: '为后台分析或特定 Worker 指定模型；引用的策略必须匹配 Worker 类型。', dshPresetsHint: '选择 DSH worker 可以使用的 Agent preset。', workerDsh: 'DSH worker', workerCodex: 'Codex worker', presetUnavailable: '当前 preset 不可用，可取消勾选移除。', preset_standard: '标准模式', preset_cordis: '创造模式', preset_ptc: 'PTC 模式', preset_minimal: '极简模式', presetDescription_standard: '适合大多数任务，可按需使用检索、编辑、终端等工具。', presetDescription_cordis: '用于创建和配置 DSH 插件、工具、preset 与界面。', presetDescription_ptc: '适合批量调用工具并筛选、整理、去重或汇总结果。', presetDescription_minimal: '仅提供基础工具，适合测试和对比基础表现。', presetDescriptionCustom: '自定义 Agent preset。', effort_none: '关闭', effort_minimal: '最低', effort_low: '低', effort_medium: '中', effort_high: '高', effort_xhigh: '极高', effort_max: '最大', effort_ultra: '超高',

      evaluation: '质量与用量', criterionRate: '验收条件通过率', verifiedExecutions: '全部条件通过的执行', evaluationScope: '按执行统计当前定义的验收条件；尚未提交的结果计为待验证。',
      noSamples: '暂无样本', executionSamples: '执行数 / 时延样本数', latency: '执行时延 P50 / P95（秒）', tokenReports: '原生用量记录', costUnavailable: '费用不可用：未提供模型价格。Codex 原生累计用量可能跨多个 turn，不累加为单次执行费用。', failedAcceptance: '未通过',

      workerHeartbeatEnabled: '续期执行写租约', routeAmbiguityGap: '候选歧义分差', "backgroundModelPolicy": "后台模型策略", leaseTtlMs: '写租约有效期', workerHeartbeatMs: '执行心跳间隔',
      memorySubtitle: "经历档案 · 上下文图 · 任务账本", memorySearchMicro: "SEARCH", memoryResults: "检索结果", memoryResultsMicro: "RECORDS", memoryAdvancedFilters: "更多筛选条件", memoryMaintenance: "索引与记忆维护", memoryComposition: "记忆构成", memoryCompositionMicro: "MEMORY MIX", memoryDetailMicro: "INSPECTOR", memoryGraphControls: "拖动旋转 · 滚轮缩放 · Shift 拖动平移 · 双击归位", memoryPanels: "记忆面板", memoryHidePanel: "收起",
      memoryGroup: '记忆提炼', memoryGraphError: '星图未能载入，仍可使用列表查询', memoryGraphHint: "展示当前已加载记录；连线为已有关系，背景星尘与轨道仅为装饰",
      memoryExtractionEnabled: '启用任务与记忆提炼',
      memoryExtractionIntervalMs: '提炼间隔',
      memoryExtractionBatchSize: '单次处理批数',
      memoryExtractionRetryLimit: '失败重试上限',
      memoryExtractionBudgetMs: '单次提炼时限',
      "cleanupGroup": "归档与保留",
      cleanupEnabled: '压缩归档较早正文',
      cleanupIntervalMs: '清理间隔',
      "analysisGroup": "后台分析",
      "analysisBudgetMs": "任务关联分析时限",
      analysisInputChars: '输入字符上限',
      analysisOutputChars: '输出字符上限',
      "semanticRoutingEnabled": "用模型判断任务关联",
      modelPolicies: '模型策略',

      meta: { title: '私人助理', description: '向私人助理发送请求，并管理顶级任务。' },
      panel: '私人助理', sending: '正在建立对话', sendError: '请求未能发送',
      contextUnavailable: '私人助理会话上下文未能载入', openDashboard: '打开任务看板', closeDashboard: '关闭任务看板', openMemory: '打开记忆系统', closeMemory: '关闭记忆系统',
      dashboard: '任务', refresh: '刷新', loading: '正在读取任务…', loadError: '暂时无法读取任务', retry: '重试',
      activeTasks: '进行中', completedTasks: '已结束', noActiveTasks: '暂无进行中的任务', noCompletedTasks: '暂无已结束的任务',
      taskDetails: '任务详情', back: '返回任务列表', objective: '任务目标', status: '状态', createdAt: '创建时间', updatedAt: '更新时间', completedAt: '结束时间',
      workers: 'Worker 会话', noWorkers: '暂无 Worker 会话', workerCapabilities: 'Worker 能力', dshWorker: 'DSH worker', codexWorker: 'Codex worker', available: '可用', unavailable: '不可用', acceptance: '验收', pendingAcceptance: '待验收', passedAcceptance: '已通过', session: '会话', system: '系统', model: '模型', route: '路由',
      codex: 'Codex', connected: 'Codex 已连接', disconnected: 'Codex 未连接', untitledTask: '未命名任务', unknown: '未知',
      settingsNav: '私人助理设置', "settingsTitle": "私人助理设置", historyGroup: '历史同步', historyStartupEnabled: '启动时同步历史', historyPeriodicEnabled: '周期同步历史',
      memoryTitle: '记忆系统', memorySearchLabel: '搜索记忆内容', memoryType: '数据类型', memoryState: '记忆状态', memorySource: '来源系统', memoryFrom: '开始时间', memoryTo: '结束时间', memoryAll: '全部类型', memoryExperience: '经历档案', memoryRecord: '记忆记录', memoryEntity: '实体', memoryRelation: '关系', memoryTask: '助理任务', memoryAnyState: '全部状态', memoryAnySource: '全部来源', memorySearch: '查询', memoryReset: '重置筛选', memoryNoResults: '没有匹配记录', memoryDetails: '记录详情', memorySources: '来源依据', memoryRelations: '关联关系', memoryContent: '内容', memoryEntityName: '实体名称', memoryEntityTags: '标签（逗号分隔）', memoryEntityAliases: '别名（逗号分隔）', memoryEntityAttributes: '属性', memoryAddAttribute: '添加属性', memoryAttributeKey: '属性名', memoryAttributeValue: '属性值', memorySave: '保存修改', memoryConfirm: '确认候选', memoryRetract: '撤回', memoryDelete: '删除', memoryDeleteConfirm: '确定删除这条记忆记录？', memoryDeleteEntityConfirm: '确定删除这个实体及其关系？', memoryDeleteExperienceConfirm: '确定删除这段本地经历镜像？上游会话不会删除。', memoryRebuild: '重建检索索引', memoryRetry: '重试失败提炼', memoryRun: '立即提炼', memoryOperationDone: '操作完成', memoryExtractionStarted: '已启动记忆提炼，可在私人助理的执行记录中查看进度。', memoryOperationError: '操作失败', memoryIndex: '索引状态', memoryBusy: '正在处理…', memoryQuote: '来源',
      memoryKind: '记忆类别', memoryPredicate: '关系谓词', memoryObject: '对象 JSON', memoryScope: '适用范围 JSON', memoryValidFrom: '生效时间', memoryValidTo: '失效时间', memoryRelationLabel: '关系名称', memoryEntityType: '实体类型', memoryExperienceNote: '本地备注', memoryAssociatedEntities: '关联实体', memoryLoadMore: '加载更多', memoryTaskDeleteConfirm: '确定删除此任务？有执行或运行记录依赖的任务不能删除。', memoryDeleteRelationConfirm: '确定删除这条关系及其记忆断言？',
      workerMigrationWarning:'旧规则中有无法转换的设置：{items}。迁移前配置已保留，请核对默认选择和模型策略。', workerReadiness:'Codex 执行状态', workerConnectionOff:'连接未启用', workerNewOff:'新建权限未启用', workerResumeOff:'续接权限未启用', workerReady:'已连接，可执行任务', workerConnecting:'正在连接 Codex…', workerDisconnected:'已启用，尚未连接', workerConnectionFailed:'连接或恢复失败，请检查 Codex 服务后重试', workerReconnect:'重新连接 Codex', workerGroup: 'Worker 设置', dshWorkerEnabled: '启用 DSH worker', codexWorkerEnabled: '启用 Codex 历史同步与 worker', dshPresets: '允许的 DSH presets', defaultWorkerPriority:'默认 worker 优先级', defaultWorkerPriorityHint:'新建或维护 DSH 插件时由模型选择创造模式；其他新建任务按此选择。继续已有任务时沿用原会话。', workerPriorityStandard:'DSH · 标准模式', workerPriorityCordis:'DSH · 创造模式', routeCandidateLimit:'每页执行候选上限', workerBudget: 'Worker 时间预算', routeThreshold: '恢复路由阈值',
      codexGroup: 'Codex', codexEnabling: '正在同步 Codex 历史并启用 worker…', codexDisabling: '正在清理 Codex 历史并停用 worker…', codexEnabledResult: 'Codex 历史同步与 worker 已启用。', codexDisabledResult: 'Codex 已关闭，可移除的本地历史记录已清理。',
      syncInterval: '同步间隔', retentionDays: '默认查询天数', batchSize: '每批记录数', batchTime: '批次时间预算',
      readBuffer: '读取缓冲区', importLimit: '单次同步上限', recordLimit: '单条记录上限', inboxGroup: '收件箱恢复',
      inboxBatchSize: '每批事件上限', inboxRetryLimit: '每条事件重试上限', inboxRetryBudgetMs: '批次时间预算', inboxEnabled: '自动重试未处理事件', retryInterval: '重试间隔', backupGroup: '数据库备份', backupEnabled: '自动创建备份',
      backupInterval: '备份间隔', backupRetention: '保留备份数',
      minute: '分钟', second: '秒', hour: '小时', day: '天', records: '条', milliseconds: '毫秒',
      mib: 'MiB', kib: 'KiB', settingsLoading: '正在读取设置…', settingsLoadError: '无法读取设置', "settingsSaving": "正在应用…",
      "settingsSaved": "修改已生效", "settingsSaveError": "修改未能确认生效", settingsRestore: '恢复配置默认值', settingsRetry: '重试'
    };
    const en = {
      mainSessionGroup: "Main conversation",
      mainSessionTitle: "Conversation name",
      mainSessionTitleHint: "Changes apply automatically. Archived conversations use “name-废弃会话-1, 2, 3…” with consecutive numbers.",
      mainSessionTitleError: "Enter a name of up to 48 UTF-8 bytes (about 16 Chinese characters).",
      mainSessionGroupHint: "Manage the conversation shared by desktop and WeChat, with memories kept separately",
      mainSessionClear: "Clear main conversation history",
      mainSessionClearHint: "Sync messages, archive the old conversation and start an empty one. Memories, tasks, settings and WeChat login are kept. Pending messages, replies and approvals stay with the old conversation.",
      mainSessionClearConfirm: "Clear the current main conversation and start a new one?\n\nThe old conversation is synced to memory and archived. Existing memories, tasks and settings are kept. WeChat stays signed in and switches to the new main conversation. Pending messages, replies and approvals stay with the old conversation.\n\nA running conversation cannot be cleared.",
      mainSessionClearing: "Clearing main conversation…",
      mainSessionClearDraining: "Pausing WeChat delivery and checking conversation activity…",
      mainSessionClearSyncing: "Syncing messages from the old conversation…",
      mainSessionClearCreating: "Creating the main conversation and updating WeChat…",
      mainSessionCleared: "An empty main conversation is ready. The old conversation is archived; memories, tasks and WeChat login are kept.",
      "jobsHint": "Review scheduled jobs, upcoming runs, and recent errors.",
      "wechatInteractionTtlMsHint": "Time allowed to answer a WeChat question or approval before it expires.",
      "wechatBackoffMaxMsHint": "Maximum delay between reconnection attempts after failures.",
      "wechatSendBudgetHint": "Consecutive messages allowed after receiving a WeChat message, subject to server limits.",
      "wechatContextTtlMsHint": "Send a new WeChat message to refresh expired reply credentials. The server may expire them sooner.",
      "wechatRemoteApprovalEnabledHint": "Approve individual operations in WeChat without granting permanent authorization.",
      "wechatMirrorUserEnabledHint": "Send your original desktop messages to your own WeChat account.",
      "codexWorkerHint": "Enable history sync and connect Codex to create, resume or explicitly fork tasks. Disabling disconnects and removes eligible local history copies.",
      "workerHeartbeatEnabledHint": "Keep the workspace write lease active while a task is running.",
      "workerHeartbeatMsHint": "Renew the write lease while running. Use an interval below half the lease duration.",
      "leaseTtlMsHint": "Limit concurrent writes to one workspace; running executions renew this lease.",
      "routeAmbiguityGapHint": "Avoid direct reuse when the top candidates are close. Higher values are more cautious.",
      "routeResumeThresholdHint": "Minimum association score for reusing an execution session. Higher values are more conservative.",
      "workerBudgetMsHint": "Maximum time allowed for one worker execution.",
      "memoryExtractionBudgetMsHint": "Maximum duration of each memory extraction model request.",
      "memoryExtractionRetryLimitHint": "Jobs that reach this limit require a manual retry from extraction records.",
      "memoryExtractionBatchSizeHint": "Maximum task batches per scheduled run. Higher values can increase model calls.",
      "backgroundModelPolicyHint": "Use a DSH model policy from Worker settings, or inherit the default model.",
      "analysisOutputCharsHint": "Limit generated text. A low limit may truncate structured results.",
      "analysisInputCharsHint": "Limit the text read by each analysis. Larger inputs can increase model usage.",
      "analysisBudgetMsHint": "Maximum duration for one task association analysis. Memory extraction has its own time limit.",
      "semanticRoutingEnabledHint": "Suggest related tasks by meaning; this uses background model calls.",
      "gib": "GiB",
      "archiveCapacityBytesHint": "Pause new history writes at this limit. Raise it or remove records manually to continue.",
      "candidateReviewDaysHint": "Flag older candidate memories for review without confirming or deleting them automatically.",
      "hotHistoryDaysHint": "Older text can move to compressed storage. Original sources stay unchanged.",
      "historyRetentionDaysHint": "Default search window when no dates are specified; it does not limit history imports.",
      "wechatGroupHint": "Share the desktop assistant session with your own WeChat account to send messages and receive final replies.",
      "workerGroupHint": "Workers are sessions that carry out tasks for the assistant using DSH or Codex.",
      "analysisGroupHint": "Background model calls extract memories and suggest task associations. Set their language, model, and per-request limits here.",
      "cleanupGroupHint": "Compress older conversation text to manage storage; archived content remains searchable.",
      "backupGroupHint": "Back up the local memory and task database regularly and keep a chosen number of recovery copies.",
      "inboxGroupHint": "Retry Codex events that have not reached the task ledger to recover interrupted state updates.",
      "memoryGroupHint": "Organize synced conversations into tasks, outcomes, and candidate memories for later recall.",
      "historyGroupHint": "Sync DSH and enabled Codex history locally so the assistant can search it and extract memories.",
      "settingsRestoreConfirm": "Restore and apply profile defaults now? The Codex switch will stay unchanged.",
      "settingsRestoreHint": "Restore profile defaults while keeping the Codex switch unchanged",
      "settingsPending": "Waiting to apply changes…",
      "settingsAutoApply": "Changes apply automatically",
      "wechatGroup": "WeChat",
      "wechatResumeRestored": "Resume restored channel",
      "wechatResumeConfirm": "Start syncing at the current session position. Restored inputs will not run automatically; previous deliveries will stay isolated. Continue?",
      "wechatPreviousBinding": "Previous binding",
      "wechatEnabled": "Enable WeChat channel",
      "wechatSyncRepliesEnabled": "Sync final main-session replies",
      "wechatMirrorUserEnabled": "Mirror desktop user messages",
      "wechatRemoteApprovalEnabled": "Allow one-time remote approval from WeChat",
      "wechatHint": "WeChat and desktop share one main session and its permissions. Do not use the same bot account with another WeChat plugin. Remote approval is off by default and cannot grant permanent access.",
      "wechatDisabledHint": "Enable the WeChat channel to scan and connect your assistant.",
      "wechatOpenMain": "Open main conversation",
      "wechatSharedMain": "WeChat shares the single conversation on the personal assistant page. No separate session binding is needed.",
      "wechatSendRetryLimit": "Retries before connection is established",
      "wechatConnection": "Connection",
      "wechatLogin": "Connect WeChat to the assistant",
      "wechatIdentityDetails": "Account identifier",
      "wechatIdentity_local": "Bound · Previously confirmed locally",
      "wechatIdentity_verified": "Bound · Matches the scanned account",
      "wechatIdentity_mismatch": "The sender does not match the scanned account. Send a message from the account used to scan",
      "wechatIdentity_waiting-message": "Send a message from the account used to scan. It will be verified and bound automatically",
      "wechatIdentity_scan-required": "Scan again to verify the account identity",
      "wechatIdentity_unbound": "No WeChat account connected",
      "wechatLoginHint": "Scanning authorizes this WeChat account to connect to the assistant main conversation. Send a message from that account to verify and bind automatically",
      "wechatCancelLogin": "Cancel sign-in",
      "wechatUnlink": "Unlink WeChat",
      "wechatUnlinkConfirm": "Stop delivery and revoke sign-in credentials? Old queues will not be sent to a new identity.",
      "wechatQrAlt": "WeChat sign-in QR code",
      "wechatScanToLogin": "Scan with your own WeChat account",
      "wechatScanned": "Scanned; confirm on your phone",
      "wechatOwner": "Authorized WeChat identity",
      "wechatQueue": "Delivery queue (up to 50 pending records)",
      "wechatQueueEmpty": "No pending messages",
      "wechatRetryInput": "Reconcile and retry input",
      "wechatRetrySend": "Retry send",
      "wechatDiscard": "Skip send",
      "wechatUnknownRetryConfirm": "The send outcome is unknown. Check your phone first. Resending may duplicate this message. Continue?",
      "wechatDiscardConfirm": "Skip this queued segment? The full reply remains in its original session.",
      "wechatRequestTimeout": "Request timeout",
      "wechatPollTimeout": "Long-poll timeout",
      "wechatBackoff": "Maximum reconnect backoff",
      "wechatMessageChars": "Characters per segment",
      "wechatQueueCapacity": "Queue capacity",
      "wechatRetention": "Completed body retention",
      "wechatInteractionTimeout": "Answer validity",
      "wechatContextTimeout": "Reply credential validity",
      "wechatSendBudget": "Send budget per interaction",
      "wechatStatus_disabled": "Disabled",
      "wechatStatus_login-required": "Sign-in required",
      "wechatStatus_restore-hold": "Paused after backup restore",
      "wechatStatus_binding-required": "Waiting to verify the scanned account",
      "wechatStatus_connecting": "Connecting",
      "wechatStatus_connected": "Connected",
      "wechatStatus_waiting-interaction": "Waiting for WeChat interaction",
      "wechatStatus_occupied": "Account in use",
      "wechatStatus_error": "Needs attention",
      "wechatStatus_login-pending": "Waiting for QR sign-in",
      "wechatQueue_pending": "Pending",
      "wechatQueue_sending": "Sending",
      "wechatQueue_accepted": "Accepted by server",
      "wechatQueue_unknown": "Send outcome unknown",
      "wechatQueue_waiting": "Waiting for interaction",
      "wechatQueue_failed": "Failed",
      "wechatQueue_held": "Input on hold",
      "wechatQueue_dispatching": "Input admission unconfirmed",
      "wechatQueue_completed": "Completed",
      "wechatQueue_command": "Command handled",

      memoryClearSelection: 'Clear selection', memoryClearSelectionHint: 'Click empty space, click the selected object again, or press Esc to clear selection',
      memoryDerivedRelation: 'This connection follows the session task and its linked memory or entity records.', memoryStoredRelation: 'This relationship connects the objects below. Open either endpoint or inspect its source.',
      memoryRelationFrom: 'From', memoryRelationTo: 'To',
      graphLoaded:"Loaded graph nodes",
      graphContext:"Outlined nodes are related context",
      needsReview:"Candidates needing review",
      defaultLanguageHint:"Used for background content; the main conversation follows your language.",
      sessionTask: "Session tasks",
      defaultLanguage: "Background output language",
      languageSimplifiedChinese: "简体中文",
      languageEnglish: "English",
      "hotHistoryDays": "Uncompressed text retention",
      "candidateReviewDays": "Candidate review reminder",
      "archiveCapacityBytes": "Local memory capacity",
      rawSearch: "Search original conversations and execution records",
      rawSearchHint: "Search user messages, assistant replies and tool output beyond task summaries",
      rawSupplementary: "Original records without task ownership",
      historyCoverage: "Sessions awaiting assignment",
      memoryProcess: "Process and results",
      memoryManagement: "Manage",
      historyMessages: "Original dialogue and sources",
      extractionRecent: "Failed executions",
      noFailures: "No failed executions",
      memorySessions: "Sessions",
      memoryRawCount: "Original records",
      rawMatches: "Source matches",
      retrySource: "Retry source read",

      memoryInitialize: "Initialize memory",
      memoryInitializing: "Initializing…",
      memoryInitializeConfirm: "This clears all plugin experiences, memories, entities, relationships, tasks and executions, together with related approvals, queues, leases, baselines, artifact records, usage, sync cursors, extraction runs and managed database backups. Settings, feature flags and the assistant Session binding remain. Original DSH/Codex Sessions and workspace files are preserved. History is then imported under the current configuration and scheduled work resumes. This cannot be undone. Continue?",
      memoryInitializeDraining: "Stopping history sync and extraction; waiting for accepted operations…",
      memoryInitializeClearing: "Clearing local memory and related operational records…",
      memoryInitializeImporting: "Importing history under the current configuration…",
      memoryInitializeIndexing: "Rebuilding search indexes…",
      memoryInitialized: "Memory initialized. History was imported under the current configuration; subsequent extraction will generate candidates gradually.",
      memoryInitializeFailed: "Initialization did not complete",
      memoryInitializeFailedAfterClear: "Local records were cleared, but initialization did not complete; resolve the error and retry",
      memoryInitializeStatusError: "Initialization status is unavailable; wait for status to recover",
      memoryInitializeReconnecting: "Restoring the Codex connection…",

      extractionQueueErrors: "Pending extraction errors",
      extractionClose: "Close extraction records",
      extractionRecords: "Memory extraction · Runs",  extractionRunning: "Running", extractionQueued: "Queued", extractionIdle: "Idle", extractionDisabled: "Schedule disabled", extractionAttention: "Needs attention", extractionUnavailable: "Status unavailable", extractionLoading: "Loading", extractionPending: "Pending jobs", extractionFailed: "Failed jobs", extractionInput: "Input messages", extractionProcessed: "Processed", extractionLog: "Open run log", extractionHint: "Extraction runs in background subagents. A run succeeds after source validation and memory writes complete.", extractionRun_running: "Running", extractionRun_succeeded: "Completed", extractionRun_failed: "Failed", extractionRun_cancelled: "Cancelled", extractionRun_interrupted: "Interrupted",
      jobs: 'Background status', jobsRefresh: 'Refresh job status', jobHistory: 'History sync', jobHeartbeat: 'Execution lease heartbeat', jobInbox: 'Event projection retries', jobMemory: 'Memory extraction', jobCleanup: 'History cleanup', jobBackup: 'Ledger backups', jobRunning: 'Running', jobScheduled: 'Scheduled', jobDisabled: 'Scheduled runs disabled', lastSuccess: 'Last success', nextRun: 'Next run', neverRun: 'No record', "settingsEffect": "Manage memory, background tasks, and messaging. Changes apply automatically; active operations finish with their original settings.", settingsSource: 'Effective settings source', savedSource: 'Settings saved in ledger', profileSource: 'Profile configuration and defaults', backlog: 'Backlog and checkpoints',
      settingsAdvanced: 'Advanced settings', settingsRange: 'Enter a value from {min} to {max}', "settingsValidationError": "Some changes need attention before they can apply", settingsHeartbeatError: 'The heartbeat interval must be less than half the write-lease duration.', settingsPresetError: 'Select an enabled worker and an allowed DSH preset.', settingsPresetReferenceError: 'Remove unavailable presets and check the default worker mode.', settingsPolicyNameError: 'Policy names are required and must be unique.', settingsRequired: 'This field is required.', settingsPolicyReferenceError: 'Choose a model policy for the selected worker.', settingsAddPolicy: 'Add model policy', settingsRemovePolicy: 'Remove model policy', settingsWorkerType: 'Worker type', settingsDshPreset: 'DSH preset', settingsCapabilities: 'Required capabilities', settingsCapabilitiesHint: 'Comma-separated', settingsPolicy: 'Model policy', settingsPolicyName: 'Policy name', settingsProvider: 'Model provider ID', settingsModel: 'Model ID', settingsEffort: 'Reasoning effort', settingsDefaultEffort: 'Use default', settingsNoPolicy: 'None', settingsUnnamedPolicy: 'Unnamed policy', modelPoliciesHint: 'Choose models for background analysis or individual workers; each reference must match the worker type.', dshPresetsHint: 'Choose which Agent presets DSH workers may use.', workerDsh: 'DSH worker', workerCodex: 'Codex worker', presetUnavailable: 'This preset is unavailable. Clear its checkbox to remove it.', preset_standard: 'Standard mode', preset_cordis: 'Creator mode', preset_ptc: 'PTC mode', preset_minimal: 'Minimal mode', presetDescription_standard: 'Suitable for most tasks, with search, editing, and terminal tools available as needed.', presetDescription_cordis: 'Create and configure DSH plugins, tools, presets, and interfaces.', presetDescription_ptc: 'Batch tool calls and filter, organize, deduplicate, or summarize results.', presetDescription_minimal: 'A small tool set for testing and comparing basic performance.', presetDescriptionCustom: 'Custom Agent preset.', effort_none: 'Off', effort_minimal: 'Minimal', effort_low: 'Low', effort_medium: 'Medium', effort_high: 'High', effort_xhigh: 'Extra high', effort_max: 'Max', effort_ultra: 'Ultra',

      evaluation: 'Quality and usage', criterionRate: 'Acceptance criterion pass rate', verifiedExecutions: 'Executions passing all criteria', evaluationScope: 'Current criterion definitions per execution; unsubmitted results count as pending.',
      noSamples: 'No samples', executionSamples: 'Executions / latency samples', latency: 'Execution latency P50 / P95 (seconds)', tokenReports: 'Native usage records', costUnavailable: 'Cost unavailable: model prices are not supplied. Native Codex totals may span turns and are not summed as per-execution costs.', failedAcceptance: 'Failed',

      workerHeartbeatEnabled: 'Renew execution write leases', routeAmbiguityGap: 'Candidate ambiguity gap', "backgroundModelPolicy": "Background model policy", leaseTtlMs: 'Write lease duration', workerHeartbeatMs: 'Worker heartbeat interval',
      memorySubtitle: "Experiences · Context graph · Task ledger", memorySearchMicro: "SEARCH", memoryResults: "Search results", memoryResultsMicro: "RECORDS", memoryAdvancedFilters: "More filters", memoryMaintenance: "Indexes and memory maintenance", memoryComposition: "Memory composition", memoryCompositionMicro: "MEMORY MIX", memoryDetailMicro: "INSPECTOR", memoryGraphControls: "Drag to rotate · Scroll to zoom · Shift-drag to pan · Double-click to reset", memoryPanels: "Memory panels", memoryHidePanel: "Hide",
      memoryGroup: 'Memory extraction', memoryGraphError: 'Star map unavailable; list search is still available', memoryGraphHint: "Showing loaded records. Lines are stored relationships; background dust and orbits are decorative.",
      memoryExtractionEnabled: 'Extract durable memories',
      memoryExtractionIntervalMs: 'Extraction interval',
      memoryExtractionBatchSize: 'Batches per run',
      memoryExtractionRetryLimit: 'Extraction retry limit',
      memoryExtractionBudgetMs: 'Time limit per extraction',
      "cleanupGroup": "Archive and retention",
      cleanupEnabled: 'Archive older bodies',
      cleanupIntervalMs: 'Cleanup interval',
      "analysisGroup": "Background analysis",
      "analysisBudgetMs": "Task association time limit",
      analysisInputChars: 'Input character limit',
      analysisOutputChars: 'Output character limit',
      "semanticRoutingEnabled": "Use a model for task associations",
      modelPolicies: 'Model policies',

      meta: { title: 'Personal assistant', description: 'Send requests to the personal assistant and manage top-level tasks.' },
      panel: 'Personal assistant', sending: 'Starting conversation', sendError: 'The request could not be sent',
      contextUnavailable: 'The personal-assistant session context could not be loaded', openDashboard: 'Open task dashboard', closeDashboard: 'Close task dashboard', openMemory: 'Open memory system', closeMemory: 'Close memory system',
      dashboard: 'Tasks', refresh: 'Refresh', loading: 'Loading tasks…', loadError: 'Tasks are temporarily unavailable', retry: 'Retry',
      activeTasks: 'In progress', completedTasks: 'Completed', noActiveTasks: 'No active tasks', noCompletedTasks: 'No completed tasks',
      taskDetails: 'Task details', back: 'Back to tasks', objective: 'Objective', status: 'Status', createdAt: 'Created', updatedAt: 'Updated', completedAt: 'Completed',
      workers: 'Worker sessions', noWorkers: 'No worker sessions', workerCapabilities: 'Worker capabilities', dshWorker: 'DSH worker', codexWorker: 'Codex worker', available: 'Available', unavailable: 'Unavailable', acceptance: 'Acceptance', pendingAcceptance: 'Pending verification', passedAcceptance: 'Passed', session: 'Session', system: 'System', model: 'Model', route: 'Route',
      codex: 'Codex', connected: 'Codex connected', disconnected: 'Codex disconnected', untitledTask: 'Untitled task', unknown: 'Unknown',
      settingsNav: 'Personal assistant settings', "settingsTitle": "Private assistant settings", historyGroup: 'History sync', historyStartupEnabled: 'Sync history at startup', historyPeriodicEnabled: 'Sync history periodically',
      memoryTitle: 'Memory system', memorySearchLabel: 'Search memory content', memoryType: 'Data type', memoryState: 'Memory state', memorySource: 'Source system', memoryFrom: 'From', memoryTo: 'To', memoryAll: 'All types', memoryExperience: 'Experience archive', memoryRecord: 'Memory record', memoryEntity: 'Entity', memoryRelation: 'Relation', memoryTask: 'Task', memoryAnyState: 'All states', memoryAnySource: 'All sources', memorySearch: 'Search', memoryReset: 'Reset filters', memoryNoResults: 'No matching records', memoryDetails: 'Record details', memorySources: 'Supporting sources', memoryRelations: 'Related records', memoryContent: 'Content', memoryEntityName: 'Entity name', memoryEntityTags: 'Tags (comma separated)', memoryEntityAliases: 'Aliases (comma separated)', memoryEntityAttributes: 'Attributes', memoryAddAttribute: 'Add attribute', memoryAttributeKey: 'Attribute name', memoryAttributeValue: 'Attribute value', memorySave: 'Save changes', memoryConfirm: 'Confirm candidate', memoryRetract: 'Retract', memoryDelete: 'Delete', memoryDeleteConfirm: 'Delete this memory record?', memoryDeleteEntityConfirm: 'Delete this entity and its relations?', memoryDeleteExperienceConfirm: 'Delete this local experience mirror? The upstream session is kept.', memoryRebuild: 'Rebuild search indexes', memoryRetry: 'Retry failed extraction', memoryRun: 'Extract now', memoryOperationDone: 'Operation completed', memoryExtractionStarted: 'Memory extraction started. View progress in the assistant execution records.', memoryOperationError: 'Operation failed', memoryIndex: 'Index status', memoryBusy: 'Working…', memoryQuote: 'Source',
      memoryKind: 'Memory kind', memoryPredicate: 'Relationship predicate', memoryObject: 'Object JSON', memoryScope: 'Scope JSON', memoryValidFrom: 'Valid from', memoryValidTo: 'Valid to', memoryRelationLabel: 'Relationship label', memoryEntityType: 'Entity type', memoryExperienceNote: 'Local note', memoryAssociatedEntities: 'Related entities', memoryLoadMore: 'Load more', memoryTaskDeleteConfirm: 'Delete this task? Tasks with executions or operational references cannot be deleted.', memoryDeleteRelationConfirm: 'Delete this relationship and its assertion?',
      workerMigrationWarning:'Some old rules could not be converted: {items}. The previous settings are retained; review the default and model policies.', workerReadiness:'Codex execution status', workerConnectionOff:'Connection disabled', workerNewOff:'New thread permission disabled', workerResumeOff:'Resume permission disabled', workerReady:'Connected and ready for tasks', workerConnecting:'Connecting to Codex…', workerDisconnected:'Enabled, not connected', workerConnectionFailed:'Connection or recovery failed. Check Codex and retry.', workerReconnect:'Reconnect Codex', workerGroup: 'Worker settings', dshWorkerEnabled: 'Enable DSH worker', codexWorkerEnabled: 'Enable Codex history sync and worker', dshPresets: 'Allowed DSH presets', defaultWorkerPriority:'Default worker priority', defaultWorkerPriorityHint:'The model selects creation mode for DSH plugin work. Other new tasks use this default. Existing tasks keep their original session.', workerPriorityStandard:'DSH · Standard', workerPriorityCordis:'DSH · Creation', routeCandidateLimit:'Execution candidates per page', workerBudget: 'Worker time budget', routeThreshold: 'Resume route threshold',
      codexGroup: 'Codex', codexEnabling: 'Syncing Codex history and enabling the worker…', codexDisabling: 'Cleaning Codex history and disabling the worker…', codexEnabledResult: 'Codex history sync and worker are enabled.', codexDisabledResult: 'Codex is disabled; removable local history records were cleared.',
      syncInterval: 'Sync interval', retentionDays: 'Default query days', batchSize: 'Records per batch', batchTime: 'Batch time budget',
      readBuffer: 'Read buffer', importLimit: 'Sync limit per run', recordLimit: 'Maximum record size', inboxGroup: 'Inbox recovery',
      inboxBatchSize: 'Events per retry batch', inboxRetryLimit: 'Retry limit per event', inboxRetryBudgetMs: 'Retry batch time budget', inboxEnabled: 'Retry pending events automatically', retryInterval: 'Retry interval', backupGroup: 'Database backups', backupEnabled: 'Create backups automatically',
      backupInterval: 'Backup interval', backupRetention: 'Backups to keep',
      minute: 'minutes', second: 'seconds', hour: 'hours', day: 'days', records: 'records', milliseconds: 'ms',
      mib: 'MiB', kib: 'KiB', settingsLoading: 'Loading settings…', settingsLoadError: 'Settings could not be loaded', "settingsSaving": "Applying…",
      "settingsSaved": "Changes applied", "settingsSaveError": "Changes could not be confirmed", settingsRestore: 'Restore profile defaults', settingsRetry: 'Retry'
    };

    const CSS = `
html[data-pac-assistant-session] [data-phase="hero"] button[class*="_workspace"][aria-haspopup="menu"]{display:none}
html[data-pac-assistant-session] [data-pac-hidden-context="true"]{display:none!important}
.pac-launch{display:flex;align-items:center;justify-content:center;height:100%;min-height:0;padding:24px;background:transparent;color:var(--dsw-alias-label-secondary);font:14px/1.5 inherit;color-scheme:inherit}.pac-launch p{margin:0}.pac-launch-error{max-width:520px;text-align:center;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.pac-assistant-page{display:flex;flex-direction:column;height:100%;min-width:0;min-height:0;container-type:inline-size;color:var(--dsw-alias-label-primary);--dsh-conversation-column-width:100cqw}.pac-assistant-heading{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}.pac-assistant-heading h1{flex:1;margin:0;font-family:inherit;font-size:16px;font-weight:500;line-height:1.5}.pac-assistant-heading button{-webkit-app-region:no-drag}.pac-assistant-conversation{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}.pac-launch{gap:12px;flex-direction:column}
.pac-assistant-conversation [data-conversation-content]{--dsh-chat-content-width:var(--dsh-chat-user-width,clamp(680px,calc(100cqw * .64),920px));--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width) + 32px);--dsh-composer-side-clearance:16px}
.pac-sidebar *{box-sizing:border-box}.pac-sidebar h2,.pac-sidebar h3,.pac-sidebar p,.pac-sidebar dl,.pac-sidebar dd{margin:0}
.pac-icon-button{width:32px;height:32px;min-width:32px;flex:0 0 32px;padding:0!important;color:var(--dsw-alias-label-secondary)}.pac-icon-button svg{width:18px;height:18px}.pac-icon-button[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-brand-primary)}.pac-icon-button:focus-visible,.pac-sidebar :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.pac-sidebar-header{gap:4px}
.pac-glyph{display:block;flex-shrink:0;color:inherit}
.pac-header-action{width:32px;height:32px;flex-basis:32px}.pac-spin{animation:pac-spin .9s linear infinite}@keyframes pac-spin{to{transform:rotate(360deg)}}
.pac-extraction-status{display:inline-flex;align-items:center;gap:6px;min-height:32px;max-width:100%;padding:4px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.pac-extraction-status:hover{background:var(--dsw-alias-interactive-bg-hover)}.pac-extraction-status:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.pac-extraction-state{color:var(--dsw-alias-label-tertiary)}.pac-extraction-dot{width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:currentColor}.pac-extraction-dot.extractionRunning{background:var(--dsw-alias-brand-primary);animation:pac-extraction-pulse 1.4s ease-in-out infinite}.pac-extraction-dot.extractionAttention,.pac-extraction-dot.extractionUnavailable{background:var(--dsw-alias-state-error-primary)}.pac-extraction-summary{padding:12px 18px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}.pac-extraction-current{font-size:14px;font-weight:500}.pac-extraction-heading{padding:16px 18px 4px;font-size:13px;font-weight:500}.pac-extraction-runs{list-style:none;padding:0;margin:0}.pac-extraction-run{padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}.pac-extraction-run-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.pac-extraction-run-head .pac-inline-button{margin:0;flex-shrink:0;font-size:12px}.pac-extraction-queue-errors{padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}.pac-extraction-queue-errors summary{cursor:pointer;min-height:24px}.pac-extraction-error{margin-top:8px!important;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}@keyframes pac-extraction-pulse{50%{opacity:.35}}@media(prefers-reduced-motion:reduce){.pac-extraction-dot{animation:none!important}}@media(max-width:600px){.pac-extraction-status{gap:4px;padding:4px}.pac-extraction-state{max-width:7em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.pac-sidebar{position:absolute;z-index:21;isolation:isolate;top:var(--dsh-frame-top-clearance,0px);right:0;bottom:0;display:flex;flex-direction:column;width:clamp(300px,45vw,70vw);min-height:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:-10px 0 28px rgba(0,0,0,.12);font:14px/1.5 inherit}.pac-sidebar:before{content:'';position:absolute;z-index:-1;inset:0;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));pointer-events:none}
.pac-sidebar-header{display:flex;align-items:center;min-height:54px;padding:9px 10px 9px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}.pac-sidebar-header h2{min-width:0;flex:1;font-size:16px;line-height:1.4;font-weight:500;letter-spacing:0}.pac-codex-dot{width:8px;height:8px;margin:0 8px;border-radius:50%;background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}.pac-codex-dot.connected{background:var(--dsw-alias-state-success-primary)}
.pac-sidebar-body{min-height:0;flex:1;overflow:auto;padding:8px 0 24px}.pac-message{padding:24px 18px;color:var(--dsw-alias-label-secondary);font-size:13px}.pac-message.error{color:var(--dsw-alias-state-error-primary)}.pac-inline-button{margin-top:10px}
.pac-task-group{margin:12px 14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);overflow:hidden}.pac-group-toggle{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;border:0;background:transparent;padding:9px 12px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;text-align:left}.pac-group-toggle svg{width:14px;height:14px;flex:0 0 14px;transition:transform .15s}.pac-group-toggle[aria-expanded=true] svg{transform:rotate(90deg)}.pac-group-count{margin-left:auto;min-width:24px;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}.pac-task-group:has(.pac-task-list) .pac-group-toggle{border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.pac-task-list{margin:0;padding:4px 6px;list-style:none}.pac-task-list li+li{border-top:0.5px solid var(--dsw-alias-border-l1)}.pac-task-button{display:grid;grid-template-columns:6px minmax(0,1fr);gap:4px 9px;width:100%;border:0;border-radius:var(--dsw-radius-sm);background:transparent;padding:10px 8px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}.pac-task-button:before{content:"";grid-column:1;grid-row:1;width:5px;height:5px;margin-top:7px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-brand-primary)}.pac-task-group[data-kind=completed] .pac-task-button:before{background:var(--dsw-alias-label-tertiary)}.pac-task-title{grid-column:2;font-size:13px;line-height:20px;overflow-wrap:anywhere}.pac-task-meta{grid-column:2;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}.pac-empty{padding:6px 12px 14px 34px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.pac-capabilities{margin:4px 14px 12px;padding:10px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}.pac-capabilities h3{margin-bottom:8px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}.pac-capability-list{display:flex;flex-wrap:wrap;gap:8px}.pac-capability{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.pac-capability:before{content:"";width:5px;height:5px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-tertiary)}.pac-capability.is-available:before{background:var(--dsw-alias-state-success-primary)}
.pac-detail-head{display:flex;align-items:center;gap:6px;padding:4px 10px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}.pac-detail-head h3{min-width:0;flex:1;font-size:13px;font-weight:500;letter-spacing:0}.pac-detail-title{padding:16px 18px 8px;font-size:16px;line-height:1.4;font-weight:500;overflow-wrap:anywhere}.pac-detail-copy{padding:0 18px 12px;color:var(--dsw-alias-label-secondary);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.pac-detail-list{display:grid;padding:4px 18px 14px}.pac-detail-row{display:grid;grid-template-columns:minmax(84px,.36fr) minmax(0,1fr);gap:12px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.pac-detail-row:last-child{border-bottom:0}.pac-detail-row dt{color:var(--dsw-alias-label-tertiary);font-size:12px}.pac-detail-row dd{overflow-wrap:anywhere}.pac-detail-section{padding:10px 18px 0;border-top:1px solid var(--dsw-alias-border-l1)}.pac-evaluation .pac-detail-list{padding:6px 0}.pac-evaluation-note{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:7px 0!important}.pac-evaluation pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.pac-evaluation summary{cursor:pointer;min-height:32px;padding:6px 0}.pac-detail-section h3{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}.pac-worker-list{display:grid;gap:0;margin:7px 0 0;padding:0;list-style:none}.pac-worker{padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.pac-worker:last-child{border-bottom:0}.pac-worker-name{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.pac-worker-meta{display:flex;flex-wrap:wrap;gap:5px 12px;margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:11px}
@media(max-width:760px){.pac-sidebar{top:var(--dsh-frame-top-clearance,0px);width:min(100%,480px)}}
@media(prefers-reduced-motion:reduce){.pac-spin{animation:none}.pac-group-toggle svg{transition:none}}
.pac-settings{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;min-width:0;overflow:hidden;padding:24px clamp(16px,3vw,36px) 32px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-family:inherit;font-size:13px;line-height:1.5;container-type:inline-size}
.pac-settings>*{width:100%;flex-shrink:0;max-width:900px;margin-right:auto;margin-left:auto}.pac-settings *{box-sizing:border-box}.pac-settings>.pac-settings-scroll{flex:1;min-height:0;overflow:auto;padding:2px 3px}.pac-settings h2,.pac-settings h3,.pac-settings p{margin:0}.pac-settings-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}.pac-settings-header>div{min-width:0}.pac-settings-title{font-size:18px;line-height:1.4;font-weight:500;overflow-wrap:anywhere}.pac-settings-description{margin-top:5px!important;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.pac-settings-source{color:var(--dsw-alias-label-tertiary);font-size:11px}
.pac-settings-feedback{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;min-height:38px;margin-bottom:16px;padding:8px 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}.pac-settings-feedback>span:first-child{display:flex;align-items:center;gap:7px}.pac-settings-feedback>span:first-child:before{content:"";width:5px;height:5px;flex:none;border-radius:50%;corner-shape:round;background:currentColor}.pac-settings-feedback[data-state=saved]{color:var(--dsw-alias-state-success-primary)}.pac-settings-feedback[data-state=error],.pac-settings-feedback[data-state=invalid]{color:var(--dsw-alias-state-error-primary)}.pac-settings-feedback[data-state=saving],.pac-settings-feedback[data-state=pending]{color:var(--dsw-alias-brand-primary)}
.pac-settings-icon{width:32px;height:32px;min-width:32px;padding:0!important;border-radius:var(--dsw-radius-sm)!important}.pac-settings-icon svg{width:16px;height:16px}.pac-spin{animation:pac-settings-spin .8s linear infinite}@keyframes pac-settings-spin{to{transform:rotate(360deg)}}.pac-settings-loading{display:flex;align-items:center;justify-content:center}
.pac-settings-group,.pac-job-overview{min-inline-size:0;margin:0 auto 14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 65%,transparent)}.pac-settings-group-heading,.pac-job-overview>summary{display:flex;align-items:center;gap:16px;padding:15px 18px;cursor:pointer;list-style:none;border-radius:inherit}.pac-settings-group-heading::-webkit-details-marker,.pac-job-overview>summary::-webkit-details-marker,.pac-settings-advanced>summary::-webkit-details-marker{display:none}@media(hover:hover){.pac-settings-group-heading:hover,.pac-job-overview>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}}.pac-settings-group-heading:focus-visible,.pac-job-overview>summary:focus-visible,.pac-settings-advanced>summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.pac-settings-group-copy{display:grid;gap:4px;min-width:0;flex:1}.pac-settings-group-title{font-size:14px;font-weight:500;line-height:21px}.pac-settings-group-description{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.pac-settings-group-chevron{flex:none;color:inherit;transition:transform .15s}.pac-settings-group[open]>.pac-settings-group-heading .pac-settings-group-chevron{transform:rotate(90deg)}.pac-settings-group[open]>.pac-settings-group-heading{border-radius:var(--dsw-radius-md) var(--dsw-radius-md) 0 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}.pac-settings-group-body{padding:4px 18px 14px;min-width:0}
.pac-job-overview>summary{min-height:48px;font-size:13px;font-weight:500}.pac-job-count{margin-left:auto;min-width:24px;padding:1px 6px;background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font-size:11px;text-align:center}.pac-job-table{margin:0 18px;border-top:0.5px solid var(--dsw-alias-border-l1)}.pac-job-row{display:grid;grid-template-columns:8px minmax(95px,1fr) minmax(70px,.65fr) repeat(2,minmax(110px,1fr));align-items:center;gap:8px 12px;min-height:40px;padding:8px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1);font-size:11px}.pac-job-row:last-child{border-bottom:0}.pac-job-indicator{width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-tertiary)}.pac-job-indicator.is-enabled{background:var(--dsw-alias-state-success-primary)}.pac-job-indicator.is-running{background:var(--dsw-alias-brand-primary)}.pac-job-name{min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}.pac-job-state,.pac-job-time{min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.pac-job-error{grid-column:2/-1;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}.pac-settings-progress{display:flex;flex-wrap:wrap;gap:4px 18px;padding:9px 18px 14px;color:var(--dsw-alias-label-secondary);font-size:11px}
.pac-settings-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(125px,210px);align-items:center;gap:8px 24px;min-height:54px;padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}.pac-settings-label{min-width:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}.pac-settings-hint{display:block;margin-top:4px!important;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;font-weight:400;overflow-wrap:anywhere}.pac-settings-control{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px}.pac-settings-row>input,.pac-settings-control input,.pac-settings-compact-field input,.pac-settings-compact-field select,.pac-settings-select{width:100%;min-width:0;height:34px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);padding:6px 10px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}.pac-settings-control input{max-width:120px;text-align:right;font-variant-numeric:tabular-nums}@media(hover:hover){.pac-settings-row>input:hover,.pac-settings-control input:hover,.pac-settings-select:hover{background:var(--dsw-alias-interactive-bg-hover)}}.pac-settings-row>input:focus-visible,.pac-settings-control input:focus-visible,.pac-settings-compact-field input:focus-visible,.pac-settings-compact-field select:focus-visible,.pac-settings-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.pac-settings-row>input[aria-invalid=true],.pac-settings-control input[aria-invalid=true],.pac-settings-compact-field input[aria-invalid=true],.pac-settings-select[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}.pac-settings-unit{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}.pac-settings-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:54px;padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1)}.pac-settings-toggle-row> :last-child{flex-shrink:0}.pac-settings-group-body>.pac-settings-row:last-child,.pac-settings-group-body>.pac-settings-toggle-row:last-child{border-bottom:0}
.pac-settings-select{display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;cursor:pointer}.pac-settings-select span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pac-settings-select svg{flex:none;color:inherit}.pac-settings-advanced{margin-top:12px;border-top:0.5px solid var(--dsw-alias-border-l1)}.pac-settings-advanced>summary{display:flex;align-items:center;gap:7px;min-height:38px;padding:6px 0;cursor:pointer;list-style:none;font-size:12px;color:var(--dsw-alias-label-secondary)}@media(hover:hover){.pac-settings-advanced>summary:hover{color:var(--dsw-alias-label-primary)}}.pac-settings-advanced>summary svg{flex:none;transition:transform .15s}.pac-settings-advanced[open]>summary svg{transform:rotate(90deg)}.pac-settings-advanced-block{min-width:0;margin:16px 0 8px}.pac-settings-subhead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:0 0 12px}.pac-settings-subhead>div{min-width:0}.pac-settings-subhead h3{font-size:13px;font-weight:500}.pac-settings-subhead p{margin-top:4px!important;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}.pac-settings-structured-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr)) 32px;align-items:end;gap:12px;padding:14px;margin-bottom:10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}.pac-settings-compact-field{display:grid;gap:5px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px}.pac-settings-structured-row>.pac-settings-icon{grid-column:3;grid-row:1;align-self:end}.pac-settings-compact-field:nth-child(odd){grid-column:1}.pac-settings-compact-field:nth-child(even){grid-column:2}.pac-settings-compact-field input,.pac-settings-compact-field select{width:100%;text-align:left}.pac-settings-preset-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:0 0 12px}.pac-settings-preset{display:grid;gap:4px;min-width:0;padding:10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}.pac-settings-preset:has(input:checked){border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1))}.pac-settings-preset-description{padding-left:28px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;overflow-wrap:anywhere}.pac-settings-preset.is-unavailable{color:var(--dsw-alias-state-error-primary)}.pac-settings-field-error{grid-column:1/-1;color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}.pac-settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pac-settings-status{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 0;overflow-wrap:anywhere}.pac-settings-status.error{color:var(--dsw-alias-state-error-primary)}.pac-settings-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:12px 0}.pac-settings-footer p{flex:1;min-width:180px}
.pac-wechat{min-width:0;padding-top:12px}.pac-wechat-action{font-size:12px}.pac-wechat p{margin:8px 0}.pac-wechat-id{overflow-wrap:anywhere}.pac-wechat-qr{display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px 0}.pac-wechat-qr img{max-width:100%;height:auto;background:white;border-radius:var(--dsw-radius-sm)}.pac-wechat-queue-row{padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-l1);overflow-wrap:anywhere}.pac-wechat-queue-row p{white-space:pre-wrap;max-height:180px;overflow:auto;margin:8px 0}
@container(max-width:600px){.pac-settings-row{grid-template-columns:minmax(0,1fr) minmax(115px,36%);gap:10px 16px}.pac-job-row{grid-template-columns:6px minmax(0,1fr) auto}.pac-job-state{grid-column:3;grid-row:1}.pac-job-time,.pac-job-error{grid-column:2/-1}.pac-settings-preset-list{grid-template-columns:minmax(0,1fr)}}
@container(max-width:380px){.pac-settings-group-heading{padding:13px}.pac-settings-group-body{padding:2px 13px 12px}.pac-settings-row{grid-template-columns:minmax(0,1fr)}.pac-settings-control{justify-content:flex-start}.pac-settings-control input{max-width:none}.pac-settings-structured-row{grid-template-columns:minmax(0,1fr) 32px;padding:10px}.pac-settings-compact-field:nth-child(n){grid-column:1/-1}.pac-settings-structured-row>.pac-settings-icon{grid-column:2;grid-row:auto;justify-self:end}}
@media(max-width:480px){.pac-settings{padding:16px 12px 24px}}@media(pointer:coarse){.pac-settings-control input,.pac-settings-compact-field input,.pac-settings-compact-field select,.pac-settings-select{min-height:40px;font-size:16px}.pac-settings-toggle-row{min-height:52px}}@media(prefers-reduced-motion:reduce){.pac-settings-group-chevron,.pac-settings-advanced>summary svg{transition:none}.pac-spin{animation:none}}
/* Floating cards and HUD treatments adapted from memory-starmap/web/index.html. */
.pac-memory-screen{--pac-ink:#e8f1ff;--pac-dim:#91a5c5;--pac-dim2:#7d91b1;--pac-line:rgba(120,170,255,.16);--pac-hair:rgba(120,170,255,.07);--pac-accent:#7fc8ff;--pac-edge:20px;--pac-hud:296px;position:fixed;z-index:1000;inset:var(--dsh-frame-top-clearance,0px) 0 0;min-width:0;min-height:0;overflow:hidden;isolation:isolate;pointer-events:auto;background:#04060d;color:var(--pac-ink);font:12px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif;opacity:1;transition:opacity .22s ease;color-scheme:dark}
.pac-memory-screen.is-closing{opacity:0;pointer-events:none}.pac-memory-screen.is-closing .pac-memory-video{opacity:0}
.pac-memory-screen *{box-sizing:border-box}.pac-memory-screen h1,.pac-memory-screen h2,.pac-memory-screen h3,.pac-memory-screen p,.pac-memory-screen dl{margin:0}.pac-memory-screen :focus-visible{outline:2px solid var(--pac-accent);outline-offset:2px}
.pac-memory-screen:before{content:'';position:absolute;z-index:1;inset:0;background:radial-gradient(ellipse at 50% 46%,transparent 26%,rgba(2,4,10,.3) 74%,rgba(1,2,6,.8) 100%);pointer-events:none}
.pac-memory-video{position:absolute;z-index:0;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;opacity:.88;filter:brightness(.92) saturate(.9) contrast(1.02) blur(.6px);transition:opacity .22s ease;pointer-events:none}
.pac-memory-header{position:absolute;z-index:5;top:20px;left:var(--pac-edge);right:var(--pac-edge);display:flex;align-items:flex-start;gap:12px;pointer-events:none}.pac-memory-brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1}.pac-memory-brand-title{font-size:17px;line-height:1.2;font-weight:500;letter-spacing:.13em;color:#e4eeff;text-shadow:0 0 22px rgba(120,180,255,.5)}.pac-memory-subtitle{margin-top:5px!important;font-size:10px;letter-spacing:.08em;color:var(--pac-dim)}
.pac-memory-title-mark{display:grid;place-items:center;flex:0 0 28px;width:28px;height:28px;border:1px solid rgba(127,200,255,.5);border-radius:7px;color:#bfe2ff;box-shadow:0 0 18px rgba(90,160,255,.28) inset,0 0 14px rgba(80,150,255,.18)}.pac-memory-header .pac-icon-button{pointer-events:auto;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.pac-memory-layout,.pac-memory-map{position:absolute;inset:0;min-width:0;min-height:0}.pac-memory-map{z-index:2;overflow:hidden}.pac-memory-graph{display:block;width:100%;height:100%;touch-action:none;cursor:grab}.pac-memory-graph-error{position:absolute;top:46%;left:calc(var(--pac-hud) + 40px);right:calc(var(--pac-hud) + 40px);padding:12px;background:rgba(8,12,22,.9);color:#ffb4b4;border:1px solid var(--pac-line);border-radius:7px;text-align:center}
.pac-memory-hud{--pac-ink:var(--dsw-alias-label-primary);--pac-dim:var(--dsw-alias-label-secondary);--pac-dim2:var(--dsw-alias-label-tertiary);--pac-line:var(--dsw-alias-border-l2);--pac-hair:var(--dsw-alias-border-l1);--pac-accent:var(--dsw-alias-brand-primary);color:var(--pac-ink);color-scheme:normal;position:absolute;z-index:4;top:94px;bottom:54px;width:var(--pac-hud);display:flex;min-height:0;flex-direction:column;gap:10px;pointer-events:none}.pac-memory-browser{left:var(--pac-edge)}.pac-memory-inspector{right:var(--pac-edge);gap:8px}
.pac-memory-card{position:relative;min-width:0;min-height:0;padding:11px 12px 12px;border:0.5px solid var(--pac-line);border-radius:var(--dsw-radius-md);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));backdrop-filter:blur(13px);-webkit-backdrop-filter:blur(13px);pointer-events:auto}.pac-memory-card:before{content:'';position:absolute;inset:4px;border:0.5px solid var(--pac-hair);border-radius:var(--dsw-radius-sm);pointer-events:none}.pac-memory-card:after{content:'';position:absolute;top:-1px;left:14px;width:34px;height:1px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),transparent);pointer-events:none}
.pac-memory-hud-heading{position:relative;display:flex;align-items:baseline;gap:7px;margin-bottom:9px!important;color:var(--pac-ink);font-size:11.5px;font-weight:500;letter-spacing:.08em}.pac-memory-micro{font-size:8.5px;color:var(--pac-dim2);font-style:normal;font-weight:400;letter-spacing:.15em;text-transform:uppercase}.pac-memory-counter{margin-left:auto;font-size:10px;font-weight:400;letter-spacing:.03em;color:var(--pac-dim);font-variant-numeric:tabular-nums}
.pac-memory-search-card{flex:0 1 auto;overflow:auto;overscroll-behavior:contain}.pac-memory-filter{display:grid;gap:8px}.pac-memory-field{display:grid;min-width:0;gap:4px;color:var(--pac-dim);font-size:10.5px}.pac-memory-field input,.pac-memory-field select,.pac-memory-edit-input{width:100%;min-width:0;height:30px;border:1px solid var(--pac-line);border-radius:7px;background:var(--dsw-alias-bg-layer-1);padding:5px 8px;color:var(--pac-ink);font:inherit;font-size:12px;color-scheme:normal}.pac-memory-field input[type=checkbox]{width:16px;height:16px;margin:0 6px 0 0;vertical-align:middle}.pac-memory-field select[multiple]{height:90px}.pac-memory-field option{background:var(--dsw-alias-bg-base);color:var(--pac-ink)}
.pac-memory-edit-textarea{width:100%;min-height:100px;resize:vertical;border:1px solid var(--pac-line);border-radius:7px;background:var(--dsw-alias-bg-layer-1);padding:8px;color:var(--pac-ink);font:inherit;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.pac-memory-advanced summary,.pac-memory-maintenance summary{color:var(--pac-dim);font-size:10.5px;cursor:pointer;padding:5px 0}.pac-memory-filter-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:5px}.pac-memory-filter-grid .pac-memory-field:nth-last-child(-n+2){grid-column:1/-1}
.pac-memory-toolbar,.pac-memory-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex-shrink:0}.pac-memory-toolbar button,.pac-memory-actions button{height:auto;min-height:30px;padding:5px 10px;white-space:normal;overflow-wrap:anywhere}.pac-memory-drawer-tabs button{pointer-events:auto}.pac-memory-screen button:disabled{opacity:.45;cursor:default}
.pac-memory-actions .pac-memory-danger{--dsh-button-outline-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary)}
.pac-memory-status{padding-top:7px;color:#9fe6c8;font-size:11px;overflow-wrap:anywhere}.pac-memory-status.error{color:#ffafbd}.pac-memory-maintenance .pac-memory-actions{padding:5px 0 0}.pac-memory-index{padding-top:8px;margin-top:7px!important;border-top:1px solid var(--pac-hair);color:var(--pac-dim);font-size:10px;line-height:1.6;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.pac-memory-results-card{display:flex;flex-direction:column;flex:1;min-height:100px;overflow:hidden}.pac-memory-results{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding-right:3px}.pac-memory-records{list-style:none;margin:0;padding:0}.pac-memory-records li+li{border-top:1px solid var(--pac-hair)}.pac-memory-record{display:grid;width:100%;gap:4px;border:0;border-radius:7px;background:transparent;padding:7px 5px;color:var(--pac-ink);font:inherit;text-align:left;cursor:pointer;--pac-node:#ffb86b}.pac-memory-record[data-kind=memory]{--pac-node:#7fc8ff}.pac-memory-record[data-kind=entity]{--pac-node:#9fe6c8}.pac-memory-record[data-kind=task]{--pac-node:#ff8fc7}.pac-memory-record[data-kind=relation]{--pac-node:#a6a1ef}.pac-memory-record:hover:not(:disabled),.pac-memory-record[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover)}
.pac-memory-record-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:11.5px;line-height:1.55;overflow-wrap:anywhere}.pac-memory-record-title:before{content:'';display:inline-block;width:5px;height:5px;margin:0 7px 1px 0;border-radius:50%;background:var(--pac-node);box-shadow:0 0 7px var(--pac-node)}.pac-memory-record-meta{color:var(--pac-dim);font-size:9.5px;overflow-wrap:anywhere}.pac-memory-load-more{width:100%;min-height:34px;border:0;border-top:1px solid var(--pac-hair);background:transparent;color:var(--pac-ink);font:inherit;font-size:11px;cursor:pointer}
.pac-memory-clear-selection{margin-left:auto;letter-spacing:normal;flex-shrink:0;pointer-events:auto}.pac-memory-clear-selection+.pac-memory-drawer-close{margin-left:0}.pac-memory-relation-endpoint{display:grid;gap:5px;margin-top:12px}.pac-memory-relation-endpoint>span{color:var(--pac-dim)}.pac-memory-relation-endpoint button{white-space:normal;overflow-wrap:anywhere}
.pac-memory-map-footer{position:absolute;z-index:3;bottom:15px;left:calc(var(--pac-hud) + 40px);right:calc(var(--pac-hud) + 40px);display:grid;gap:5px;justify-items:center;text-align:center;pointer-events:none;color:var(--pac-dim);font-size:9.5px;line-height:1.5}.pac-memory-legend{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 14px;color:#b1c5e3;font-size:10px}.pac-memory-legend span:before{content:'';display:inline-block;width:5px;height:5px;margin:0 6px 1px 0;border-radius:50%;background:#ffb86b;box-shadow:0 0 6px currentColor}.pac-memory-legend [data-kind=memory]:before{background:#7fc8ff}.pac-memory-legend [data-kind=entity]:before{background:#9fe6c8}.pac-memory-legend [data-kind=task]:before{background:#ff8fc7}
.pac-memory-composition{flex:0 0 auto}.pac-memory-mixbar{display:flex;height:5px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.05);margin:2px 0 9px}.pac-memory-mixbar span{height:100%;background:var(--pac-node)}.pac-memory-stat{display:flex;align-items:center;gap:8px;width:100%;padding:4px 5px;border:0;border-radius:7px;background:transparent;color:var(--pac-ink);font:inherit;font-size:11px;text-align:left;cursor:pointer}.pac-memory-stat:hover,.pac-memory-stat[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}.pac-memory-stat:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--pac-node);box-shadow:0 0 8px var(--pac-node)}.pac-memory-stat b{margin-left:auto;color:var(--pac-dim);font-size:10.5px;font-weight:400;font-variant-numeric:tabular-nums}
.pac-memory-detail-card{display:flex;flex:1;flex-direction:column;overflow:hidden}.pac-memory-detail{min-width:0;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding-right:3px}.pac-memory-detail h3{color:var(--pac-ink);font-size:13px;font-weight:500;overflow-wrap:anywhere}.pac-memory-detail-content{margin-top:8px!important;color:var(--pac-ink);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.pac-memory-detail-section{margin-top:14px;padding-top:9px;border-top:1px solid var(--pac-hair)}.pac-memory-detail-section h3{color:var(--pac-ink);font-size:11.5px}.pac-memory-source{padding:8px 0;border-bottom:1px solid var(--pac-hair);color:var(--pac-dim);font-size:11px;overflow-wrap:anywhere}.pac-memory-detail pre{max-width:100%;color:var(--pac-dim);white-space:pre-wrap;overflow-wrap:anywhere;font:10.5px/1.6 monospace}
.pac-memory-detail .pac-memory-actions{padding-top:8px}.pac-memory-edit{display:grid;gap:9px;margin-top:10px}.pac-memory-inspector-title{padding:0 0 8px;line-height:1.5}.pac-memory-inspector-meta{padding-bottom:9px;color:var(--pac-dim);font-size:10px}.pac-memory-empty{padding:16px 4px;color:var(--pac-dim);font-size:11.5px}
.pac-memory-attributes{display:grid;gap:6px}.pac-memory-attribute{display:grid;grid-template-columns:minmax(60px,.7fr) minmax(0,1.3fr) 28px;gap:5px;align-items:center}.pac-memory-attribute-remove{width:28px;height:28px;padding:0!important;color:var(--dsw-alias-state-error-primary)}.pac-memory-attribute .pac-memory-edit-input{padding:4px 6px}.pac-memory-drawer-tabs,.pac-memory-drawer-close{display:none}
@media(min-width:901px) and (max-width:1150px){.pac-memory-screen{--pac-hud:268px;--pac-edge:16px}}
@media(max-width:900px){.pac-memory-screen{--pac-edge:14px;--pac-hud:296px}.pac-memory-header{top:16px}.pac-memory-brand-title{font-size:16px}.pac-memory-hud{display:none;top:108px;bottom:62px;width:min(340px,calc(100% - 28px));gap:8px}.pac-memory-hud.is-open{display:flex}.pac-memory-hud .pac-memory-card{background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2))}.pac-memory-drawer-tabs{position:absolute;z-index:5;top:68px;left:14px;right:14px;display:flex;gap:8px;pointer-events:none}.pac-memory-drawer-tabs button{pointer-events:auto;min-height:32px;padding:5px 12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2))}.pac-memory-drawer-tabs button[aria-expanded=true]{color:var(--dsw-alias-brand-primary);--dsh-button-outline-color:var(--dsw-alias-brand-primary)}.pac-memory-drawer-close{display:inline-flex;margin-left:auto;letter-spacing:0}.pac-memory-map-footer{left:14px;right:14px;bottom:12px;font-size:9px}.pac-memory-map-hint{max-width:540px}.pac-memory-graph-error{left:14px;right:14px;top:auto;bottom:92px}}
@media(max-width:480px){.pac-memory-subtitle{font-size:9px;letter-spacing:.04em}.pac-memory-composition{display:none}.pac-memory-field input,.pac-memory-field select,.pac-memory-edit-input{height:36px;font-size:16px}.pac-memory-toolbar button,.pac-memory-actions button{min-height:36px}.pac-memory-filter-grid{grid-template-columns:minmax(0,1fr)}.pac-memory-filter-grid .pac-memory-field{grid-column:1}.pac-memory-search-card{max-height:58%}.pac-memory-results-card{min-height:120px}.pac-memory-record{padding-top:9px;padding-bottom:9px}.pac-memory-map-hint{display:none}.pac-memory-brand{gap:8px}}
@media(max-height:640px) and (min-width:901px){.pac-memory-hud{top:82px;bottom:30px;gap:6px}.pac-memory-composition .pac-memory-stat{padding-top:1px;padding-bottom:1px}.pac-memory-map-hint{display:none}.pac-memory-search-card{max-height:60%}}

.pac-memory-link{display:block;width:100%;min-height:32px;margin:4px 0;padding:7px 9px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--pac-ink);font:inherit;font-size:12px;line-height:18px;text-align:left;white-space:normal;overflow-wrap:anywhere;cursor:pointer}
.pac-sidebar summary,.pac-memory-hud summary{display:flex;align-items:center;gap:7px;list-style:none;min-height:30px;font-weight:400;cursor:pointer}.pac-sidebar summary::-webkit-details-marker,.pac-memory-hud summary::-webkit-details-marker{display:none}.pac-sidebar summary::marker,.pac-memory-hud summary::marker{content:''}.pac-sidebar summary>.pac-glyph,.pac-memory-hud summary>.pac-glyph{width:14px;height:14px;flex:0 0 14px;transition:transform .15s}.pac-sidebar details[open]>summary>.pac-glyph,.pac-memory-hud details[open]>summary>.pac-glyph{transform:rotate(90deg)}
.pac-extraction-heading{padding:10px 18px}.pac-extraction-run time{color:var(--dsw-alias-label-secondary);font-size:11px}.pac-evaluation{margin:16px 14px 0;padding:12px;border-top:0.5px solid var(--dsw-alias-border-l1)}.pac-memory-record{padding:9px 7px}.pac-memory-record-title{font-size:12px}.pac-memory-record-meta{font-size:11px;line-height:17px}.pac-memory-records li+li{border-top-width:0.5px}.pac-memory-stat{min-height:30px;font-size:12px}.pac-memory-hud-heading{align-items:center;flex-wrap:wrap;letter-spacing:.03em}
@media(hover:hover){.pac-group-toggle:hover,.pac-task-button:hover,.pac-memory-link:hover{background:var(--dsw-alias-interactive-bg-hover)}.pac-memory-link:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-active)}}
.pac-group-toggle:active,.pac-task-button:active{background:var(--dsw-alias-interactive-bg-active)}.pac-group-toggle:focus-visible,.pac-task-button:focus-visible{outline-offset:-2px}
@media(prefers-reduced-motion:reduce){.pac-sidebar summary>.pac-glyph,.pac-memory-hud summary>.pac-glyph{transition:none}}
html[data-platform='darwin'] .pac-sidebar,html[data-platform='darwin'] .pac-memory-screen{top:0}
html[data-platform='darwin']:not([data-fullscreen]) .pac-memory-header{left:max(var(--pac-edge),88px)}
html[data-platform='darwin']:not([data-fullscreen]) .pac-sidebar-header{padding-left:max(16px,calc(88px - 100vw + 100%))}
@media(prefers-reduced-motion:reduce){.pac-memory-video{display:none}.pac-memory-screen{transition:none}}

`;

    function responseError(payload, response) {
      return payload?.error?.message || payload?.error || `Request failed (${response.status})`;
    }

    function createStore(ctx) {
      let state = {
        data: null, loading: true, refreshing: false, error: null,
        sidebarOpen: false, sidebarPanel: 'tasks', memoryOpen: false, extraction: null, extractionError: null, activeExpanded: true, completedExpanded: false,
        selectedTaskId: null, detail: null, detailLoading: false, detailError: null
      };
      const listeners = new Set();
      let controller = null;
      let detailController = null;
      let active = false;
      let extractionController = null;
      let extractionTimer = null;
      let viewers = 0;
      const publish = patch => {
        state = { ...state, ...patch };
        if (active) listeners.forEach(listener => listener());
      };
      const readJson = async response => {
        let payload;
        try { payload = await response.json(); } catch (_) { throw new Error('Invalid response'); }
        if (!response.ok) throw new Error(responseError(payload, response));
        return payload;
      };
      const request = async () => {
        controller?.abort();
        const current = new AbortController();
        controller = current;
        const timeout = window.setTimeout(() => current.abort(), 20000);
        try {
          const response = await fetch('/api/personal-agent/dashboard', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: current.signal });
          const data = await readJson(response);
          if (active && controller === current && !current.signal.aborted) publish({ data, loading: false, refreshing: false, error: null });
        } catch (error) {
          if (active && controller === current) publish({ loading: false, refreshing: false, error: String(error?.message || error) });
        } finally { window.clearTimeout(timeout); }
      };
      const stopExtraction = () => {
        window.clearTimeout(extractionTimer);
        extractionTimer = null;
        extractionController?.abort();
        extractionController = null;
      };
      const pollExtraction = async () => {
        stopExtraction();
        if (!active || !viewers || document.hidden) return;
        const current = new AbortController();
        extractionController = current;
        const timeout = window.setTimeout(() => current.abort(), 20000);
        try {
          const response = await fetch('/api/personal-agent/memory/extraction', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: current.signal });
          const extraction = await readJson(response);
          if (active && extractionController === current && !current.signal.aborted) publish({ extraction, extractionError: null });
        } catch (error) {
          if (active && extractionController === current) publish({ extractionError: String(error?.message || error) });
        } finally {
          window.clearTimeout(timeout);
          if (active && extractionController === current) {
            extractionController = null;
            extractionTimer = window.setTimeout(pollExtraction, 3000);
          }
        }
      };
      const setSidebarOpen = (open, panel = 'tasks') => {
        if (state.sidebarOpen === open && state.sidebarPanel === panel && !state.memoryOpen) return;
        publish({ sidebarOpen: open, sidebarPanel: panel, memoryOpen: false, selectedTaskId: open ? state.selectedTaskId : null, detail: open ? state.detail : null, detailError: null });
        if (open) {
          ctx.layout?.openRightbar?.(true, false);
          request();
          pollExtraction();
        } else ctx.layout?.closeRightbar?.();
      };
      const setMemoryOpen = open => {
        if (state.memoryOpen === open && !state.sidebarOpen) return;
        publish({ memoryOpen: open, sidebarOpen: false });
        if (open) ctx.layout?.openRightbar?.(true, true);
        else ctx.layout?.closeRightbar?.();
      };
      const selectTask = async id => {
        if (!id) return;
        detailController?.abort();
        detailController = new AbortController();
        publish({ selectedTaskId: id, detail: null, detailLoading: true, detailError: null });
        const timeout = window.setTimeout(() => detailController.abort(), 20000);
        try {
          const response = await fetch(`/api/personal-agent/task?id=${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: detailController.signal });
          publish({ detail: await readJson(response), detailLoading: false, detailError: null });
        } catch (error) {
          if (active) publish({ detailLoading: false, detailError: error?.name === 'AbortError' ? 'Request timed out or was cancelled' : String(error?.message || error) });
        } finally { window.clearTimeout(timeout); }
      };
      const assistantSession = async sessionId => {
        const response = await fetch(`/api/personal-agent/session?id=${encodeURIComponent(sessionId)}`, {
          credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }
        });
        return (await readJson(response)).assistant === true;
      };
      return {
        start() {
          active = true;
          request();
          document.addEventListener('visibilitychange', pollExtraction);
          return () => { active = false; stopExtraction(); document.removeEventListener('visibilitychange', pollExtraction); controller?.abort(); detailController?.abort(); listeners.clear(); if (state.sidebarOpen || state.memoryOpen) ctx.layout?.closeRightbar?.(); };
        },
        watchExtraction() {
          viewers += 1;
          if (viewers === 1) pollExtraction();
          return () => { viewers -= 1; if (!viewers) stopExtraction(); };
        },
        refreshExtraction: () => {publish({extractionRefresh:(state.extractionRefresh||0)+1});return pollExtraction()},
        openExtraction() { setSidebarOpen(true, 'extraction'); },
        refresh() { if (!state.refreshing) { publish({ refreshing: true, error: null }); request(); } },
        assistantSession,
        openSidebar() { setSidebarOpen(true); },
        closeSidebar() { setSidebarOpen(false); },
        toggleSidebar() { setSidebarOpen(!(state.sidebarOpen && state.sidebarPanel === 'tasks')); },
        openMemory() { setMemoryOpen(true); },
        closeMemory() { setMemoryOpen(false); },
        toggleMemory() { setMemoryOpen(!state.memoryOpen); },
        toggleGroup(group) { publish({ [`${group}Expanded`]: !state[`${group}Expanded`] }); },
        selectTask,
        closeTask() { detailController?.abort(); publish({ selectedTaskId: null, detail: null, detailLoading: false, detailError: null }); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        getSnapshot() { return state; }
      };
    }

    function remoteValue(result, fallback) {
      if (result?.ok === true) return result.value;
      const error = result?.error;
      throw new Error(error?.message || error?.code || fallback);
    }

    async function responseJson(response) {
      let payload;
      try { payload = await response.json(); } catch (_) { throw new Error('Invalid response'); }
      if (!response.ok) throw new Error(responseError(payload, response));
      return payload;
    }

    const settingUnits = Object.freeze({
      hotHistoryDays:['hotHistoryDays','day',1,1,36500],candidateReviewDays:['candidateReviewDays','day',1,1,36500],archiveCapacityBytes:['archiveCapacityBytes','gib',1073741824,1/1024,1024],
      importIntervalMs: ['syncInterval', 'minute', 60_000, 1, 1440],
      historyRetentionDays: ['retentionDays', 'day', 1, 1, 3650],
      historyBatchSize: ['batchSize', 'records', 1, 1, 1000],
      historyBatchMs: ['batchTime', 'milliseconds', 1, 1, 10_000],
      historyReadBytes: ['readBuffer', 'kib', 1024, 1, 262144],
      maxImportFileBytes: ['importLimit', 'mib', 1_048_576, 1, 1024],
      maxHistoryRecordBytes: ['recordLimit', 'mib', 1_048_576, 1, 1024],
      memoryExtractionIntervalMs: ['memoryExtractionIntervalMs', 'minute', 60_000, 1/60, 10080],
      memoryExtractionBatchSize: ['memoryExtractionBatchSize', 'records', 1, 1, 200],
      memoryExtractionRetryLimit: ['memoryExtractionRetryLimit', 'times', 1, 1, 20],
      memoryExtractionBudgetMs: ['memoryExtractionBudgetMs', 'minute', 60_000, 1/60_000, 60],
      cleanupIntervalMs: ['cleanupIntervalMs', 'hour', 3_600_000, 1/60, 8760],
      analysisBudgetMs: ['analysisBudgetMs', 'second', 1000, .001, 3600],
      analysisInputChars: ['analysisInputChars', 'characters', 1, 1000, 1000000],
      analysisOutputChars: ['analysisOutputChars', 'characters', 1, 1000, 100000],
      routeCandidateLimit:['routeCandidateLimit','records',1,1,200],
      workerBudgetMs: ['workerBudget', 'minute', 60_000, 1/60_000, 1440],
      routeResumeThreshold: ['routeThreshold', '', 1, 0, 1],
      routeAmbiguityGap: ['routeAmbiguityGap', '', 1, 0, 1],
      leaseTtlMs: ['leaseTtlMs', 'second', 1000, 1, 3600],
      workerHeartbeatMs: ['workerHeartbeatMs', 'second', 1000, .1, 1800],
      inboxRetryIntervalMs: ['retryInterval', 'second', 1000, 5, 3600],
      inboxBatchSize: ['inboxBatchSize', 'records', 1, 1, 1000],
      inboxRetryLimit: ['inboxRetryLimit', '', 1, 1, 20],
      inboxRetryBudgetMs: ['inboxRetryBudgetMs', 'milliseconds', 1, 1, 60000],
      backupIntervalMs: ['backupInterval', 'hour', 3_600_000, 1, 8760],
      backupRetention: ['backupRetention', 'records', 1, 2, 1000],
      wechatRequestTimeoutMs: ['wechatRequestTimeout', 'second', 1000, 1, 120],
      wechatPollTimeoutMs: ['wechatPollTimeout', 'second', 1000, 1, 120],
      wechatBackoffMaxMs: ['wechatBackoff', 'second', 1000, 1, 3600],
      wechatMessageChars: ['wechatMessageChars', 'characters', 1, 100, 4000],
      wechatQueueCapacity: ['wechatQueueCapacity', 'records', 1, 10, 100000],
      wechatRetentionDays: ['wechatRetention', 'day', 1, 1, 3650],
      wechatInteractionTtlMs: ['wechatInteractionTimeout', 'minute', 60000, 1/60, 60],
      wechatContextTtlMs: ['wechatContextTimeout', 'hour', 3600000, 1/60, 24],
      wechatSendBudget: ['wechatSendBudget', 'records', 1, 1, 10],
      wechatSendRetryLimit: ['wechatSendRetryLimit', 'records', 1, 0, 10],
    });

    /** Keep structured drafts separate from the persisted settings document. */
    function settingsToDraft(settings) {
      const draft = { ...settings };
      for (const [key, [, , divisor]] of Object.entries(settingUnits)) draft[key] = settings[key] / divisor;
      draft.backgroundModelPolicy = settings.backgroundModelPolicy ?? '';
      draft.workerModelPolicies = { ...settings.workerModelPolicies };
      draft.workerCapabilities = { ...settings.workerCapabilities };
      draft.modelPolicies = Object.entries(settings.modelPolicies).map(([name, policy], index) => ({ ...policy, name, _key: `policy-${index}` }));
      draft.dshWorkerPresets = [...settings.dshWorkerPresets];
      return draft;
    }

    function settingsFromDraft(draft) {
      const settings = { ...draft };
      for (const [key, [, , multiplier]] of Object.entries(settingUnits)) settings[key] = ['routeResumeThreshold','routeAmbiguityGap'].includes(key) ? Number(draft[key]) : Math.round(Number(draft[key]) * multiplier);
      const policyNames = new Map(draft.modelPolicies.map(policy => [policy.name, policy.name.trim()]));
      settings.backgroundModelPolicy = policyNames.get(draft.backgroundModelPolicy) || null;
      settings.workerModelPolicies = Object.fromEntries(Object.entries(draft.workerModelPolicies).map(([key,name]) => [key, policyNames.get(name) || name]));
      settings.modelPolicies = Object.fromEntries(draft.modelPolicies.map(({ _key, name, ...policy }) => [name.trim(), {
        ...policy,
        effort: policy.effort || undefined,
        ...(policy.provider ? { provider: policy.provider.trim() } : {}),
        model: policy.model.trim(),
      }]));
      settings.dshWorkerPresets = [...draft.dshWorkerPresets];
      delete settings.codexWorkerEnabled;
      return settings;
    }

    function settingsErrors(draft, t, presets = [], validatePresetAvailability = true) {
      const errors = {};
      if (!draft.mainSessionTitle?.trim() || new TextEncoder().encode(draft.mainSessionTitle.trim()).length > 48) errors.mainSessionTitle = t('mainSessionTitleError');
      for (const [key, [label, unit, multiplier, min, max]] of Object.entries(settingUnits)) {
        const value = draft[key];
        if (value === '' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max || (multiplier === 1 && !['routeResumeThreshold','routeAmbiguityGap'].includes(key) && !Number.isSafeInteger(Number(value)))) {
          const bound = number => Number.isInteger(number) ? String(number) : String(Number(number.toPrecision(3)));
          const range = t('settingsRange').replace('{min}', bound(min)).replace('{max}', bound(max));
          errors[key] = `${t(label)}: ${range}${unit ? ` ${t(unit)}` : ''}`;
        }
      }
      if (Number(draft.workerHeartbeatMs) * 2 >= Number(draft.leaseTtlMs)) errors.workerHeartbeatMs = t('settingsHeartbeatError');
      const defaultPreset = { dsh_standard:'standard', dsh_cordis:'cordis' }[draft.defaultWorkerPriority];
      if (!['dsh_standard','dsh_cordis','codex'].includes(draft.defaultWorkerPriority) || defaultPreset && !draft.dshWorkerPresets.includes(defaultPreset) || draft.defaultWorkerPriority==='codex' && !draft.codexWorkerEnabled) errors.defaultWorkerPriority = t('settingsPresetError');
      for (const preset of validatePresetAvailability ? draft.dshWorkerPresets : []) if (!presets.some(item => item.id === preset && !item.broken)) errors.dshWorkerPresets = t('settingsPresetReferenceError');
      const names = draft.modelPolicies.map(policy => policy.name.trim());
      for (const policy of draft.modelPolicies) {
        if (!policy.name.trim() || names.filter(name => name === policy.name.trim()).length > 1) errors[`policy-${policy._key}-name`] = t('settingsPolicyNameError');
        if (!policy.model?.trim()) errors[`policy-${policy._key}-model`] = t('settingsRequired');
        if (policy.worker === 'dsh_subagent' && !policy.provider?.trim()) errors[`policy-${policy._key}-provider`] = t('settingsRequired');
      }
      const policyFor = name => draft.modelPolicies.find(policy => policy.name === name);
      if (draft.backgroundModelPolicy && policyFor(draft.backgroundModelPolicy)?.worker !== 'dsh_subagent') errors.backgroundModelPolicy = t('settingsPolicyReferenceError');
      for (const [priority,name] of Object.entries(draft.workerModelPolicies)) if (name && policyFor(name)?.worker !== (priority==='codex'?'codex':'dsh_subagent')) errors.workerModelPolicies=t('settingsPolicyReferenceError');
      return errors;
    }

    function presetLabel(id, t, preset) {
      const key = { standard: 'preset_standard', cordis: 'preset_cordis', ptc: 'preset_ptc', minimal: 'preset_minimal' }[id];
      return key ? t(key) : preset?.name || id;
    }

    function presetDescription(id, t, preset) {
      const key = { standard: 'presetDescription_standard', cordis: 'presetDescription_cordis', ptc: 'presetDescription_ptc', minimal: 'presetDescription_minimal' }[id];
      return key ? t(key) : preset?.description || t('presetDescriptionCustom');
    }

    function SettingsSelect({ id, label, describedBy, value, options, disabled, invalid, onChange }) {
      const [open, setOpen] = React.useState(false);
      const selected = options.find(option => option.id === value);
      return h(Menu, { open, onClose: () => setOpen(false), portal: true, align: 'end', selectedId: value,
        items: options, onSelect: next => { setOpen(false); onChange(next); },
        anchor: h('button', { id, type: 'button', className: 'pac-settings-select', disabled, 'aria-label': label, 'aria-describedby': describedBy,
          'aria-invalid': invalid || undefined, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(!open) },
          h('span', null, selected?.label ?? value), h(IconChevronDownOutlineRegular, { size: 16 })) });
    }

    function SettingsIconAction({ label, icon, disabled, onClick, spinning = false }) {
      return h(Tooltip, { label, portal: true, side: 'top' },
        h(Button, { type: 'button', size: 'sm', className: 'pac-settings-icon', 'aria-label': label, disabled, onClick },
          h(icon, { size: 16, className: spinning ? 'pac-spin' : undefined })));
    }

    async function requestSettings(method, body, signal) {
      const response = await fetch('/api/personal-agent/settings', {
        method, credentials: 'same-origin', cache: 'no-store', signal,
        headers: method === 'PUT' ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return responseJson(response);
    }

    async function requestCodexToggle(enabled) {
      const response = await fetch('/api/personal-agent/settings/codex', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      return responseJson(response);
    }

    /** Own autosave across settings navigation; serialize writes and keep unfinished edits visible. */
    function createSettingsController(t) {
      let state = { status: null, draft: null, defaults: null, loading: false, saving: false, refreshingJobs: false,
        error: '', formErrors: {}, saveState: 'idle', codexBusy: null, codexError: '', codexMessage: '', expanded: {} };
      let committed = null, active = null, loadingWork = null, timer = null, disposed = false, closing = false;
      const listeners = new Set();
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const publish = patch => { if (!disposed) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); } };
      const linked = [
        ['dshWorkerPresets', 'defaultWorkerPriority', 'workerModelPolicies', 'modelPolicies', 'backgroundModelPolicy'],
        ['leaseTtlMs', 'workerHeartbeatMs'],
      ];
      const changes = () => {
        if (!committed) return { patch: {}, sent: {}, errors: {} };
        const groups = [...linked, ...Object.keys(state.draft).filter(key => key !== 'codexWorkerEnabled' && !linked.some(group => group.includes(key))).map(key => [key])];
        const patch = {}, sent = {}, errors = {};
        for (const keys of groups) {
          if (keys.every(key => same(state.draft[key], committed[key]))) continue;
          const candidate = { ...committed, ...Object.fromEntries(keys.map(key => [key, state.draft[key]])) };
          const invalid = settingsErrors(candidate, t, state.status?.presets || [], keys.includes('dshWorkerPresets'));
          if (Object.keys(invalid).length) { Object.assign(errors, invalid); continue; }
          const converted = settingsFromDraft(candidate);
          for (const key of keys) {
            if (same(state.draft[key], committed[key])) continue;
            patch[key] = converted[key];
            sent[key] = state.draft[key];
          }
        }
        return { patch, sent, errors };
      };
      const flush = () => {
        clearTimeout(timer); timer = null;
        if (disposed || state.codexBusy) return Promise.resolve();
        if (active) return active;
        const { patch, sent, errors } = changes();
        publish({ formErrors: errors });
        if (!Object.keys(patch).length) {
          publish({ saveState: Object.keys(errors).length ? 'invalid' : state.saveState === 'idle' ? 'idle' : 'saved' });
          return Promise.resolve();
        }
        publish({ saving: true, saveState: 'saving', error: '' });
        active = Promise.resolve().then(async () => {
          try {
            const response = await requestSettings('PUT', patch);
            committed = { ...committed, ...sent };
            publish({ status: response, defaults: settingsToDraft(response.defaults), saveState: 'saved' });
          } catch (failure) {
            publish({ error: String(failure?.message || failure || t('settingsSaveError')), saveState: 'error' });
          } finally {
            active = null;
            publish({ saving: false });
            if (!disposed && !state.error) {
              const next = changes();
              publish({ formErrors: next.errors, saveState: Object.keys(next.errors).length ? 'invalid' : 'saved' });
              if (Object.keys(next.patch).length) void flush();
            }
          }
        });
        return active;
      };
      const edit = (transform, immediate = false) => {
        if (disposed || closing || !state.draft || state.codexBusy) return;
        const draft = typeof transform === 'function' ? transform(state.draft) : { ...state.draft, ...transform };
        publish({ draft, error: '', saveState: 'pending' });
        clearTimeout(timer);
        if (immediate) void flush();
        else timer = setTimeout(() => { timer = null; void flush(); }, 450);
      };
      const load = () => {
        if (disposed || state.draft) return Promise.resolve();
        if (loadingWork) return loadingWork;
        publish({ loading: true, error: '' });
        loadingWork = requestSettings('GET').then(response => {
          committed = settingsToDraft(response.settings);
          publish({ status: response, draft: committed, defaults: settingsToDraft(response.defaults) });
        }).catch(failure => publish({ error: String(failure?.message || failure || t('settingsLoadError')) }))
          .finally(() => { loadingWork = null; publish({ loading: false }); });
        return loadingWork;
      };
      const refreshJobs = async () => {
        if (disposed || state.refreshingJobs || active || state.codexBusy) return;
        publish({ refreshingJobs: true });
        try { publish({ status: await requestSettings('GET') }); }
        catch (failure) { publish({ error: String(failure?.message || failure || t('settingsLoadError')) }); }
        finally { publish({ refreshingJobs: false }); }
      };
      const toggleCodex = enabled => {
        if (disposed || closing || active || state.codexBusy) return Promise.resolve();
        publish({ codexBusy: enabled ? 'enabling' : 'disabling', codexError: '', codexMessage: '' });
        active = Promise.resolve().then(async () => {
        try {
          const response = await requestCodexToggle(enabled);
          committed = { ...committed, codexWorkerEnabled: response.settings.codexWorkerEnabled, defaultWorkerPriority:response.settings.defaultWorkerPriority };
          publish({ status: response, draft: { ...state.draft, codexWorkerEnabled: response.settings.codexWorkerEnabled, defaultWorkerPriority:response.settings.defaultWorkerPriority },
            codexMessage: t(enabled ? 'codexEnabledResult' : 'codexDisabledResult') });
        } catch (failure) { publish({ codexError: String(failure?.message || failure || t('settingsSaveError')) }); }
        finally { active = null; publish({ codexBusy: null }); if (!disposed && !state.error) void flush(); }
        });
        return active;
      };
      return {
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        load, edit, flush, refreshJobs, toggleCodex,
        toggleSection(key, open) { publish({ expanded: { ...state.expanded, [key]: open } }); },
        restore() { edit(current => ({ ...state.defaults, codexWorkerEnabled: current.codexWorkerEnabled }), true); },
        async dispose() {
          closing = true;
          clearTimeout(timer);
          await loadingWork;
          await active;
          do { await flush(); } while (active && !state.error);
          disposed = true; clearTimeout(timer); listeners.clear();
        },
      };
    }

    async function requestMemory(method = 'GET', params = {}, body = undefined, signal = undefined) {
      const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== '').map(([key, value]) => [key, String(value)]));
      const isItem = method === 'GET' && ['memoryId','entityId','evidenceId','taskId','sessionTaskId','historyMessageId','edgeId'].some(key => params[key]);
      const response = await fetch(`/api/personal-agent/memory${isItem ? '/item' : ''}${method === 'GET' && query.size ? `?${query}` : ''}`, {
        method, credentials: 'same-origin', cache: 'no-store', signal,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return responseJson(response);
    }

    async function requestMemoryInitialization(method = 'GET', signal) {
      const response = await fetch('/api/personal-agent/memory/initialization', {
        method, credentials: 'same-origin', cache: 'no-store', signal,
        headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify({ confirmed: true }) } : {})
      });
      return responseJson(response);
    }

    function WechatControls({ t, openMain }) {
      const [view, setView] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const operation = React.useRef(null);
      const request = async (body, signal) => responseJson(await fetch('/api/personal-agent/wechat', {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      }));
      React.useEffect(() => {
        const controller = new AbortController();
        let timer;
        const refresh = async () => {
          if (!document.hidden && !operation.current) {
            try { const value = await request(null, controller.signal); if (!controller.signal.aborted) { setView(value); setError(''); } }
            catch (failure) { if (!controller.signal.aborted) setError(String(failure.message)); }
          }
          if (!controller.signal.aborted) timer = setTimeout(refresh, 4000);
        };
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); operation.current?.abort(); };
      }, []);
      const act = async (action, values = {}) => {
        if (operation.current) return;
        const controller = new AbortController();
        operation.current = controller;
        setBusy(true); setError('');
        try { const value = await request({ action, ...values }, controller.signal); if (!controller.signal.aborted) setView(value); }
        catch (failure) { if (!controller.signal.aborted) setError(String(failure.message)); }
        finally { if (operation.current === controller) operation.current = null; if (!controller.signal.aborted) setBusy(false); }
      };
      const button = (label, action, values = {}, confirm = '') => h(Button, { size: 'sm', variant: 'outline', className: 'pac-wechat-action', type: 'button', disabled: busy,
        onClick: () => { if (!confirm || window.confirm(confirm)) void act(action, values); } }, t(label));
      const states = view?.outboxCounts?.map(row => `${t(`wechatQueue_${row.state}`)} ${row.count}`).join(' · ');
      return h('div', { className: 'pac-wechat' },
        h('p', { className: 'pac-settings-description' }, t('wechatHint')),
        h('div', { className: 'pac-settings-row' }, h('span', null, t('wechatConnection')),
          h('span', { role: 'status' }, view ? t(`wechatStatus_${view.status}`) : t('settingsLoading'))),
        view && !view.enabled ? h('p', { className: 'pac-settings-description' }, t('wechatDisabledHint')) : null,
        view?.restoreHold ? button('wechatResumeRestored', 'resume-restored', { confirmed: true }, t('wechatResumeConfirm')) : null,
        view?.error ? h('p', { className: 'pac-settings-status error', role: 'status' }, view.error) : null,
        h('p', { className: 'pac-settings-description' }, t('wechatLoginHint')),
        h('div', { className: 'pac-settings-actions' }, button('wechatLogin', 'login'),
          ['waiting', 'scanned'].includes(view?.login?.status) ? button('wechatCancelLogin', 'cancel-login') : null,
          view?.accountId ? button('wechatUnlink', 'unlink', { confirmed: true }, t('wechatUnlinkConfirm')) : null,
          button('refresh', 'refresh')),
        view?.login?.image ? h('div', { className: 'pac-wechat-qr' }, h('img', { src: view.login.image, alt: t('wechatQrAlt'), width: 240, height: 240 }),
          h('span', null, t(view.login.status === 'scanned' ? 'wechatScanned' : 'wechatScanToLogin'))) : null,
        h('p', { className: 'pac-settings-description', role: 'status' }, `${t('wechatOwner')}: ${view ? t(`wechatIdentity_${view.identityStatus}`) : t('settingsLoading')}`),
        view?.ownerId ? h('details', { className: 'pac-settings-advanced' }, h('summary', null, t('wechatIdentityDetails')),
          h('p', { className: 'pac-wechat-id' }, view.ownerId)) : null,
        h('p', { className: 'pac-settings-description' }, t('wechatSharedMain')),
        h(Button, { size: 'sm', variant: 'outline', className: 'pac-wechat-action', type: 'button', onClick: openMain }, t('wechatOpenMain')),
        states ? h('p', { className: 'pac-settings-description' }, states) : null,
        h('details', { className: 'pac-settings-advanced' }, h('summary', null, t('wechatQueue')),
          !(view?.outbox?.length || view?.inbox?.length) ? h('p', null, t('wechatQueueEmpty')) : null,
          ...(view?.inbox ?? []).map(row => h('div', { className: 'pac-wechat-queue-row', key: row.id },
            h('span', null, `${t(`wechatQueue_${row.state}`)} · ${row.generation === view?.generation ? '' : t('wechatPreviousBinding')} ${row.error || row.id}`),
            h('p', null, row.text),
            row.generation === view?.generation && ['failed', 'dispatching'].includes(row.state) ? button('wechatRetryInput', 'retry-input', { id: row.id }) : null)),
          ...(view?.outbox ?? []).map(row => h('div', { className: 'pac-wechat-queue-row', key: row.id },
            h('span', null, `${t(`wechatQueue_${row.state}`)} · ${row.generation === view?.generation ? '' : t('wechatPreviousBinding')}`), h('p', null, row.text), row.error ? h('p', { className: 'pac-settings-status error' }, row.error) : null,
            h('div', { className: 'pac-settings-actions' },
              row.generation === view?.generation && ['failed', 'waiting', 'unknown'].includes(row.state) ? button('wechatRetrySend', 'retry-send', { id: row.id, confirmed: true }, row.state === 'unknown' ? t('wechatUnknownRetryConfirm') : '') : null,
              row.generation === view?.generation && row.state !== 'sending' ? button('wechatDiscard', 'discard-send', { id: row.id }, t('wechatDiscardConfirm')) : null)))),
        error ? h('p', { className: 'pac-settings-status error', role: 'alert' }, error) : null);
    }

    /** Keep an accepted reset and its polling alive when the settings page closes. */
    function createMainSessionResetController(host, t) {
      let state = { view: null, loading: false, error: '' };
      let pending = null, timer = null, disposed = false, paused = false;
      const lifetime = new AbortController(), listeners = new Set();
      const publish = patch => { if (!disposed) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); } };
      const request = async body => responseJson(await fetch('/api/personal-agent/session/reset', {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      }));
      const apply = async view => {
        if (disposed) return;
        publish({ view, error: '' });
        if (view.running) { paused = true; host.suspend(); }
        else if (paused) { paused = false; await host.resume(); }
      };
      const run = operation => {
        if (pending || disposed) return pending;
        clearTimeout(timer); timer = null;
        publish({ loading: true, error: '' });
        pending = Promise.resolve().then(operation).catch(error => { publish({ error: String(error?.message || error) }); }).finally(() => {
          pending = null;
          publish({ loading: false });
          if (!disposed && state.view?.running) timer = setTimeout(load, 1000);
        });
        return pending;
      };
      const load = () => run(async () => { await apply(await request()); });
      return {
        load,
        start() {
          if (pending || state.view?.running || !state.view?.sessionId || state.error || !window.confirm(t('mainSessionClearConfirm'))) return;
          const expectedSessionId = state.view.sessionId;
          return run(async () => {
            paused = true; host.suspend();
            try { await apply(await request({ confirmed: true, expectedSessionId })); }
            catch (error) {
              // A lost response can follow a committed reset; read its durable status before enabling the conversation.
              await apply(await request());
              if (state.view?.oldSessionId !== expectedSessionId || state.view?.state !== 'succeeded' && !state.view?.running) throw error;
            }
          });
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        getSnapshot() { return state; },
        dispose() { disposed = true; clearTimeout(timer); lifetime.abort(); listeners.clear(); }
      };
    }

    function MainSessionControls({ t, reset, settings, title, invalid, disabled }) {
      const { view, loading, error } = React.useSyncExternalStore(reset.subscribe, reset.getSnapshot);
      React.useEffect(() => { void reset.load(); }, [reset]);
      const busy = loading || view?.running;
      const id = React.useId();
      return h('div', null,
        h('div', { className: 'pac-settings-row' },
          h('label', { className: 'pac-settings-label', htmlFor: id }, t('mainSessionTitle')),
          h('input', { id, value: title, disabled: disabled || busy, 'aria-invalid': !!invalid, 'aria-describedby': `${id}-hint`, onChange: event => settings.edit({ mainSessionTitle: event.currentTarget.value }) })),
        h('p', { id: `${id}-hint`, className: 'pac-settings-description' }, t('mainSessionTitleHint')),
        invalid ? h('p', { className: 'pac-settings-field-error', role: 'alert' }, invalid) : null,
        h('p', { className: 'pac-settings-description' }, t('mainSessionClearHint')),
        h('div', { className: 'pac-settings-actions' },
          h(Button, { size: 'sm', variant: 'outline', type: 'button', disabled: disabled || busy || !!invalid || !view?.sessionId || !!error, onClick: async () => { await settings.flush(); if (settings.getSnapshot().saveState === 'error') return; return reset.start(); } }, t(view?.running ? 'mainSessionClearing' : 'mainSessionClear')),
          error ? h(Button, { size: 'sm', variant: 'outline', type: 'button', disabled: loading, onClick: reset.load }, t('settingsRetry')) : null),
        view?.running ? h('p', { className: 'pac-settings-status', role: 'status' }, t({ draining: 'mainSessionClearDraining', syncing: 'mainSessionClearSyncing', creating: 'mainSessionClearCreating' }[view.phase] || 'mainSessionClearing')) : null,
        view?.state === 'succeeded' && !view.running ? h('p', { className: 'pac-settings-status', role: 'status' }, t('mainSessionCleared')) : null,
        error || view?.lastError || view?.channelError ? h('p', { className: 'pac-settings-status error', role: 'alert' }, error || view.lastError || view.channelError) : null);
    }

    function SettingsSection({ t, ctx, close, settings, reset }) {
      const { status, draft, defaults, loading, saving, refreshingJobs, codexBusy, codexError, codexMessage, error, formErrors, saveState, expanded } = React.useSyncExternalStore(settings.subscribe, settings.getSnapshot);
      const rowSequence = React.useRef(0);
      const idPrefix = React.useId();
      React.useEffect(() => { void settings.load(); return () => { void settings.flush(); }; }, [settings]);
      const update = (key, value) => settings.edit({ [key]: value }, typeof value === 'boolean' || ['defaultLanguage','defaultWorkerPriority','backgroundModelPolicy'].includes(key));
      const updatePolicy = (policyKey, patch) => settings.edit(current => ({ ...current, modelPolicies: current.modelPolicies.map(policy => policy._key === policyKey ? { ...policy, ...patch } : policy) }), 'effort' in patch);
      const nextRowKey = prefix => `${prefix}-${idPrefix}-${rowSequence.current++}`;
      const changePolicyWorker = (policyKey, worker) => settings.edit(current => {
        const policy = current.modelPolicies.find(item => item._key === policyKey);
        return { ...current,
          modelPolicies: current.modelPolicies.map(item => item._key === policyKey ? { ...item, worker, provider: worker === 'codex' ? '' : item.provider } : item),
          workerModelPolicies: Object.fromEntries(Object.entries(current.workerModelPolicies).map(([key,name]) => [key,name===policy.name?'':name])),
          backgroundModelPolicy: worker === 'codex' && current.backgroundModelPolicy === policy.name ? '' : current.backgroundModelPolicy,
        };
      }, true);
      const renamePolicy = (policyKey, name) => settings.edit(current => {
        const policy = current.modelPolicies.find(item => item._key === policyKey);
        return { ...current,
          modelPolicies: current.modelPolicies.map(item => item._key === policyKey ? { ...item, name } : item),
          workerModelPolicies: Object.fromEntries(Object.entries(current.workerModelPolicies).map(([key,value]) => [key,value===policy.name?name:value])),
          backgroundModelPolicy: current.backgroundModelPolicy === policy.name ? name : current.backgroundModelPolicy,
        };
      });
      const removePolicy = policyKey => settings.edit(current => {
        const policy = current.modelPolicies.find(item => item._key === policyKey);
        return { ...current,
          modelPolicies: current.modelPolicies.filter(item => item._key !== policyKey),
          workerModelPolicies: Object.fromEntries(Object.entries(current.workerModelPolicies).map(([key,value]) => [key,value===policy.name?'':value])),
          backgroundModelPolicy: current.backgroundModelPolicy === policy.name ? '' : current.backgroundModelPolicy,
        };
      }, true);
      const updatePresets = nextPresets => settings.edit(current => ({ ...current, dshWorkerPresets:nextPresets }), true);
      const groups = [
        { title: 'mainSessionGroup', fields: [], advanced: [] },
        { title: 'historyGroup', toggles: [['historyStartupSyncEnabled', 'historyStartupEnabled'], ['historyPeriodicSyncEnabled', 'historyPeriodicEnabled']], fields: ['importIntervalMs', 'historyRetentionDays'], advanced: ['historyBatchSize', 'historyBatchMs', 'historyReadBytes', 'maxImportFileBytes', 'maxHistoryRecordBytes'] },
        { title: 'inboxGroup', enabled: 'inboxRetryEnabled', enabledLabel: 'inboxEnabled', fields: ['inboxRetryIntervalMs'], advanced: ['inboxBatchSize','inboxRetryLimit','inboxRetryBudgetMs'] },
        { title: 'backupGroup', enabled: 'backupEnabled', enabledLabel: 'backupEnabled', fields: ['backupIntervalMs'], advanced: ['backupRetention'] },
        { title: 'memoryGroup', enabled: 'memoryExtractionEnabled', enabledLabel: 'memoryExtractionEnabled', fields: ['memoryExtractionIntervalMs'], advanced: ['memoryExtractionBatchSize','memoryExtractionRetryLimit','memoryExtractionBudgetMs'] },
        { title: 'cleanupGroup', enabled: 'cleanupEnabled', enabledLabel: 'cleanupEnabled', fields: ['cleanupIntervalMs', 'hotHistoryDays', 'candidateReviewDays', 'archiveCapacityBytes'], advanced: [] },
        { title: 'analysisGroup', toggles: [['semanticRoutingEnabled','semanticRoutingEnabled']], fields: [], advanced: ['analysisBudgetMs','analysisInputChars','analysisOutputChars','backgroundModelPolicy'] },
        { title: 'wechatGroup', toggles: [['wechatEnabled','wechatEnabled'], ['wechatSyncRepliesEnabled','wechatSyncRepliesEnabled'], ['wechatMirrorUserEnabled','wechatMirrorUserEnabled'], ['wechatRemoteApprovalEnabled','wechatRemoteApprovalEnabled']], fields: [], advanced: ['wechatRequestTimeoutMs','wechatPollTimeoutMs','wechatBackoffMaxMs','wechatMessageChars','wechatQueueCapacity','wechatRetentionDays','wechatInteractionTtlMs','wechatContextTtlMs','wechatSendBudget','wechatSendRetryLimit'] },
        { title: 'workerGroup', toggles: [['dshWorkerEnabled', 'dshWorkerEnabled']], fields: [], advancedToggles: [['workerHeartbeatEnabled','workerHeartbeatEnabled']], advanced: ['workerBudgetMs', 'routeResumeThreshold','routeAmbiguityGap','routeCandidateLimit','leaseTtlMs','workerHeartbeatMs'] }
      ];
      if (loading || !status && !error) return h('div', { className: 'pac-settings pac-settings-loading', role: 'status', 'aria-label': t('settingsLoading') }, h(IconRefreshOutlineRegular, { size: 20, className: 'pac-spin' }));
      if (!draft) return h('div', { className: 'pac-settings' },
        h('p', { className: 'pac-settings-status error', role: 'alert' }, `${t('settingsLoadError')}: ${error}`),
        h(Button, { size: 'sm', variant: 'outline', className: 'pac-inline-button', type: 'button', onClick: settings.load }, t('settingsRetry')));
      const presetRecords = status?.presets || [];
      const selectedAvailablePresets = draft.dshWorkerPresets.filter(id => presetRecords.some(preset => preset.id === id && !preset.broken));
      const presets = [...new Set([...presetRecords.filter(preset => !preset.broken).map(preset => preset.id), ...draft.dshWorkerPresets])];
      const presetOptions = presets.map(id => {
        const record = presetRecords.find(preset => preset.id === id);
        return { id, label: presetLabel(id, t, record), description: !record || record.broken ? t('presetUnavailable') : presetDescription(id, t, record), unavailable: !record || !!record.broken };
      });
      const policyOptionsFor = (worker, current = '') => [
        { id: '', label: t('settingsNoPolicy') },
        ...draft.modelPolicies.filter(policy => policy.worker === worker || policy.name === current)
          .map(policy => ({ id: policy.name, label: policy.name || t('settingsUnnamedPolicy'), disabled: policy.worker !== worker })),
      ];
      const workerOptions = [{ id: 'dsh_subagent', label: t('workerDsh') }, { id: 'codex', label: t('workerCodex') }];
      const effortKeys = { none: 'effort_none', minimal: 'effort_minimal', low: 'effort_low', medium: 'effort_medium', high: 'effort_high', xhigh: 'effort_xhigh', max: 'effort_max', ultra: 'effort_ultra' };
      const busy = codexBusy !== null;
      const describedSettings = new Set(["historyRetentionDays", "hotHistoryDays", "candidateReviewDays", "archiveCapacityBytes", "semanticRoutingEnabled", "analysisBudgetMs", "analysisInputChars", "analysisOutputChars", "backgroundModelPolicy", "memoryExtractionBatchSize", "memoryExtractionRetryLimit", "memoryExtractionBudgetMs", "workerBudgetMs", "routeResumeThreshold", "routeAmbiguityGap", "leaseTtlMs", "workerHeartbeatMs", "workerHeartbeatEnabled", "wechatMirrorUserEnabled", "wechatRemoteApprovalEnabled", "wechatContextTtlMs", "wechatSendBudget", "wechatBackoffMaxMs", "wechatInteractionTtlMs", "wechatDisabled"]);
      const renderLabel = (key, label, id) => h('div', { className: 'pac-settings-label' }, h(id ? 'label' : 'span', id ? { htmlFor: id } : null, t(label)), describedSettings.has(key) ? h('p', { id: `${idPrefix}-${key}-hint`, className: 'pac-settings-hint' }, t(`${key}Hint`)) : null);
      const renderField = key => {
        const [label, unit, multiplier, min, max] = settingUnits[key];
        const id = `${idPrefix}-${key}`;
        const value = draft[key];
        return h('div', { className: `pac-settings-row${formErrors[key] ? ' is-invalid' : ''}`, key },
          renderLabel(key, label, id),
          h('div', { className: 'pac-settings-control' },
            h('input', { id, type: 'number', min, max, step: multiplier !== 1 || ['routeResumeThreshold','routeAmbiguityGap'].includes(key) ? 'any' : 1, value: Number.isFinite(value) ? value : '', disabled: busy, 'aria-invalid': !!formErrors[key], 'aria-describedby': [describedSettings.has(key) ? `${idPrefix}-${key}-hint` : '', formErrors[key] ? `${idPrefix}-${key}-error` : ''].filter(Boolean).join(' ') || undefined, onChange: event => update(key, event.currentTarget.value === '' ? '' : event.currentTarget.valueAsNumber) }),
            unit ? h('span', { className: 'pac-settings-unit' }, t(unit)) : null),
          formErrors[key] ? h('p', { id: `${idPrefix}-${key}-error`, className: 'pac-settings-field-error', role: 'alert' }, formErrors[key]) : null);
      };
      const renderStructured = key => {
        if (key === 'modelPolicies') return h('section', { className: 'pac-settings-advanced-block', key },
          h('div', { className: 'pac-settings-subhead' }, h('div', null, h('h3', null, t('modelPolicies')), h('p', null, t('modelPoliciesHint'))),
            h(SettingsIconAction, { label: t('settingsAddPolicy'), icon: IconPlusOutlineRegular, disabled: busy, onClick: () => update('modelPolicies', [...draft.modelPolicies, { name: '', worker: 'dsh_subagent', provider: '', model: '', effort: '', _key: nextRowKey('policy') }]) })),
          draft.modelPolicies.map(policy => h('div', { className: 'pac-settings-structured-row', key: policy._key },
            h('label', { className: 'pac-settings-compact-field' }, h('span', null, t('settingsPolicyName')), h('input', { value: policy.name, disabled: busy, 'aria-invalid': !!formErrors[`policy-${policy._key}-name`], onChange: event => renamePolicy(policy._key, event.currentTarget.value) })),
            h('label', { className: 'pac-settings-compact-field' }, h('span', null, t('settingsWorkerType')), h(SettingsSelect, { label: t('settingsWorkerType'), value: policy.worker, options: workerOptions, disabled: busy, onChange: worker => changePolicyWorker(policy._key, worker) })),
            policy.worker === 'dsh_subagent' ? h('label', { className: 'pac-settings-compact-field' }, h('span', null, t('settingsProvider')), h('input', { value: policy.provider || '', disabled: busy, 'aria-invalid': !!formErrors[`policy-${policy._key}-provider`], onChange: event => updatePolicy(policy._key, { provider: event.currentTarget.value }) })) : null,
            h('label', { className: 'pac-settings-compact-field' }, h('span', null, t('settingsModel')), h('input', { value: policy.model, disabled: busy, 'aria-invalid': !!formErrors[`policy-${policy._key}-model`], onChange: event => updatePolicy(policy._key, { model: event.currentTarget.value }) })),
            h('label', { className: 'pac-settings-compact-field' }, h('span', null, t('settingsEffort')), h('select', { value: policy.effort || '', disabled: busy, onChange: event => updatePolicy(policy._key, { effort: event.currentTarget.value || undefined }) }, h('option', { value: '' }, t('settingsDefaultEffort')), ...Array.from(new Set(['none','minimal','low','medium','high','xhigh','max','ultra', ...(policy.effort ? [policy.effort] : [])]), value => h('option', { value, key: value }, effortKeys[value] ? t(effortKeys[value]) : value)))),
            h(SettingsIconAction, { label: t('settingsRemovePolicy'), icon: IconTrashOutlineRegular, disabled: busy, onClick: () => removePolicy(policy._key) }),
            ...['name','provider','model'].map(field => formErrors[`policy-${policy._key}-${field}`] ? h('p', { className: 'pac-settings-field-error', role: 'alert', key: field }, formErrors[`policy-${policy._key}-${field}`]) : null))),
          formErrors.backgroundModelPolicy ? h('p', { className: 'pac-settings-field-error', role: 'alert' }, formErrors.backgroundModelPolicy) : null);
        if (key === 'dshWorkerPresets') return h('section', { className: 'pac-settings-advanced-block', key },
          h('div', { className: 'pac-settings-subhead' }, h('div', null, h('h3', null, t('dshPresets')), h('p', null, t('dshPresetsHint')))),
          h('div', { className: 'pac-settings-preset-list', role: 'group', 'aria-label': t('dshPresets') }, presetOptions.map(option => {
            const checked = draft.dshWorkerPresets.includes(option.id);
            return h('div', { className: `pac-settings-preset${option.unavailable ? ' is-unavailable' : ''}`, key: option.id },
              h(Checkbox, { checked, disabled: busy || option.unavailable && !checked || checked && !option.unavailable && selectedAvailablePresets.length === 1, label: presetLabel(option.id, t, presetRecords.find(item => item.id === option.id)), onChange: selected => updatePresets(selected ? [...draft.dshWorkerPresets, option.id] : draft.dshWorkerPresets.filter(id => id !== option.id)) }),
              h('span', { className: 'pac-settings-preset-description' }, option.description));
          })),
          h('div', { className:'pac-settings-row' }, h('div',null,h('label',{className:'pac-settings-label',htmlFor:`${idPrefix}-defaultWorkerPriority`},t('defaultWorkerPriority')),h('p',{className:'pac-settings-description',id:`${idPrefix}-workerPriorityHint`},t('defaultWorkerPriorityHint'))),
            h(SettingsSelect,{id:`${idPrefix}-defaultWorkerPriority`,label:t('defaultWorkerPriority'),describedBy:`${idPrefix}-workerPriorityHint`,value:draft.defaultWorkerPriority,
              options:[{id:'dsh_standard',label:t('workerPriorityStandard')},{id:'dsh_cordis',label:t('workerPriorityCordis')},...(draft.codexWorkerEnabled?[{id:'codex',label:'Codex'}]:[])],disabled:busy,invalid:!!formErrors.defaultWorkerPriority,onChange:value=>update('defaultWorkerPriority',value)})),
          formErrors.dshWorkerPresets ? h('p', { className: 'pac-settings-field-error', role: 'alert' }, formErrors.dshWorkerPresets) : null,
          formErrors.defaultWorkerPriority ? h('p', { className: 'pac-settings-field-error', role: 'alert' }, formErrors.defaultWorkerPriority) : null);
        return null;
      };
      const jobs = (status?.jobs || []).filter(job => !['memory-initialization', 'main-session-reset'].includes(job.name));
      const jobLabel = { history:'jobHistory', 'worker-heartbeat':'jobHeartbeat', inbox:'jobInbox', 'memory-extraction':'jobMemory', cleanup:'jobCleanup', backup:'jobBackup' };
      const progress = status?.progress ?? {};
      return h('div', { className: 'pac-settings', onBlurCapture: () => { void settings.flush(); } },
        h('header', { className: 'pac-settings-header' }, h('div', null, h('h2', { className: 'pac-settings-title' }, t('settingsTitle')), h('p', { className: 'pac-settings-description' }, t('settingsEffect'))),
          h(SettingsIconAction, { label: t('jobsRefresh'), icon: IconRefreshOutlineRegular, disabled: busy || saving || refreshingJobs, spinning: refreshingJobs, onClick: settings.refreshJobs })),
        h('div', { className: 'pac-settings-feedback', 'data-state': saveState, role: saveState === 'error' ? 'alert' : 'status' }, h('span', null, t({ idle: 'settingsAutoApply', pending: 'settingsPending', saving: 'settingsSaving', saved: 'settingsSaved', invalid: 'settingsValidationError', error: 'settingsSaveError' }[saveState])), error ? h('span', null, error) : null, saveState === 'error' ? h(Button, { size: 'sm', variant: 'outline', onClick: settings.flush, type: 'button' }, t('settingsRetry')) : null),
        h('div', { className: 'pac-settings-scroll' },
        h('details', { className: 'pac-job-overview' }, h('summary', null, h('span', { className: 'pac-settings-group-copy' }, h('span', null, t('jobs')), h('span', { className: 'pac-settings-group-description' }, t('jobsHint'))), h('span', { className: 'pac-job-count' }, String(jobs.length)), h(IconChevronDownOutlineRegular, { size: 16 })),
          h('div', { className: 'pac-job-table' }, jobs.map(job => h('div', { className: `pac-job-row${job.lastError ? ' has-error' : ''}`, key: job.name },
            h('span', { className: `pac-job-indicator${job.running ? ' is-running' : job.enabled ? ' is-enabled' : ''}`, 'aria-hidden': 'true' }),
            h('span', { className: 'pac-job-name' }, t(jobLabel[job.name] || job.name)),
            h('span', { className: 'pac-job-state' }, t(job.running ? 'jobRunning' : job.enabled ? 'jobScheduled' : 'jobDisabled')),
            h('span', { className: 'pac-job-time' }, `${t('lastSuccess')}: ${formatDate(job.lastSuccessfulAt, undefined, t('neverRun'))}`),
            h('span', { className: 'pac-job-time' }, `${t('nextRun')}: ${formatDate(job.nextRunAt, undefined, t('neverRun'))}`),
            job.lastError ? h('span', { className: 'pac-job-error', role: 'status' }, job.lastError) : null))),
          h('div', { className: 'pac-settings-progress' },
            h('span', null, `${t('historyGroup')}: ${progress.history?.dsh?.imported ?? 0} ${t('records')}`),
            h('span', null, `${t('memoryGroup')}: ${progress.memory?.counts?.reduce((sum, item) => sum + item.count, 0) ?? 0} ${t('records')}`),
            h('span', null, `${t('inboxGroup')}: ${progress.inbox?.counts?.reduce((sum, item) => sum + item.count, 0) ?? 0} ${t('records')}`))),
        groups.map(group => h('details', { className: 'pac-settings-group', key: group.title, open: expanded[group.title] ?? false, onToggle: event => settings.toggleSection(group.title, event.currentTarget.open) },
          h('summary', { className: 'pac-settings-group-heading' }, h('span', { className: 'pac-settings-group-copy' }, h('span', { className: 'pac-settings-group-title' }, t(group.title)), h('span', { className: 'pac-settings-group-description' }, t(`${group.title}Hint`))), h(IconChevronRightOutlineRegular, { size: 16, className: 'pac-settings-group-chevron' })),
          h('div', { className: 'pac-settings-group-body' },
          group.title === 'mainSessionGroup' ? h(MainSessionControls, { t, reset, settings, title: draft.mainSessionTitle, invalid: formErrors.mainSessionTitle, disabled: busy || saving }) : null,
          group.title === 'workerGroup' ? h(React.Fragment, null,
            status?.workerMigration?.warnings?.length ? h('p',{className:'pac-settings-status error',role:'status'},t('workerMigrationWarning').replace('{items}',status.workerMigration.warnings.join(', '))) : null,
            draft.codexWorkerEnabled && status?.workers?.codex ? h('p',{className:'pac-settings-description'},t('workerReadiness'),': ',[!status.workers.codex.connectionEnabled&&t('workerConnectionOff'),!status.workers.codex.newEnabled&&t('workerNewOff'),!status.workers.codex.resumeEnabled&&t('workerResumeOff')].filter(Boolean).join(' · ')||t(status.workers.codex.connecting?'workerConnecting':status.workers.codex.connectionError?'workerConnectionFailed':status.workers.codex.connected?'workerReady':'workerDisconnected')) : null,
            draft.codexWorkerEnabled && status?.workers?.codex?.connectionError ? h('p', {className:'pac-settings-status error',role:'alert'},status.workers.codex.connectionError) : null,
            draft.codexWorkerEnabled && status?.workers?.codex && (!status.workers.codex.connected || status.workers.codex.connectionError) ? h('div', {className:'pac-settings-actions'}, h(Button, {size:'sm',variant:'outline',type:'button',disabled:busy || saving || status.workers.codex.connecting,onClick:()=>settings.toggleCodex(true)},t('workerReconnect'))) : null,
            h('div', { className: 'pac-settings-toggle-row' }, h('span', { className: 'pac-settings-label' }, t('codexWorkerEnabled'), h('span', { className: 'pac-settings-hint' }, t('codexWorkerHint'))), h(Switch, { checked: draft.codexWorkerEnabled, disabled: busy || saving, label: t('codexWorkerEnabled'), onChange: settings.toggleCodex })),
            codexBusy ? h('p', { className: 'pac-settings-status', role: 'status' }, t(codexBusy === 'enabling' ? 'codexEnabling' : 'codexDisabling')) : null,
            codexMessage ? h('p', { className: 'pac-settings-status', role: 'status' }, codexMessage) : null,
            codexError ? h('p', { className: 'pac-settings-status error', role: 'alert' }, `${t('settingsSaveError')}: ${codexError}`) : null) : null,
          group.enabled ? h('div', { className: 'pac-settings-toggle-row' }, h('span', { className: 'pac-settings-label' }, t(group.enabledLabel)), h(Switch, { checked: draft[group.enabled], disabled: busy, label: t(group.enabledLabel), onChange: value => update(group.enabled, value) })) : null,
          (group.toggles ?? []).map(([key, label]) => h('div', { className: 'pac-settings-toggle-row', key }, renderLabel(key, label), h(Switch, { checked: draft[key], disabled: busy, label: t(label), onChange: value => update(key, value) }))),
          group.fields.map(renderField),
          group.title === 'analysisGroup' ? h('div', { className: 'pac-settings-row' },
            h('div', null,
              h('label', { className: 'pac-settings-label', htmlFor: `${idPrefix}-defaultLanguage` }, t('defaultLanguage')),
              h('p', { id: `${idPrefix}-defaultLanguageHint`, className: 'pac-settings-description' }, t('defaultLanguageHint'))),
            h(SettingsSelect, { id: `${idPrefix}-defaultLanguage`, label: t('defaultLanguage'), describedBy: `${idPrefix}-defaultLanguageHint`, value: draft.defaultLanguage,
              options: [{ id: 'zh-CN', label: t('languageSimplifiedChinese') }, { id: 'en', label: t('languageEnglish') }],
              disabled: busy, onChange: value => update('defaultLanguage', value) })) : null,
          group.title === 'wechatGroup' ? h(WechatControls, { t, openMain: () => { close(); ctx.layout.selectPanel(PANEL); } }) : null,
          group.title === 'workerGroup' ? h(React.Fragment, null,
            renderStructured('dshWorkerPresets'),
            h('details', { className: 'pac-settings-advanced' }, h('summary', null, h(IconChevronRightOutlineRegular, { size: 14 }), t('settingsAdvanced')),
              (group.advancedToggles ?? []).map(([key, label]) => h('div', { className: 'pac-settings-toggle-row', key }, renderLabel(key, label), h(Switch, { checked: draft[key], disabled: busy, label: t(label), onChange: value => update(key, value) }))),
              group.advanced.map(renderField), ...['dsh_standard','dsh_cordis','codex'].map(priority=>h('div',{className:'pac-settings-row',key:priority},h('label',{className:'pac-settings-label'},t({dsh_standard:'workerPriorityStandard',dsh_cordis:'workerPriorityCordis',codex:'codexWorkerEnabled'}[priority]),' · ',t('modelPolicies')),h(SettingsSelect,{label:t('modelPolicies'),value:draft.workerModelPolicies[priority]??'',options:policyOptionsFor(priority==='codex'?'codex':'dsh_subagent',draft.workerModelPolicies[priority]),disabled:busy,onChange:value=>update('workerModelPolicies',{...draft.workerModelPolicies,[priority]:value})}))), renderStructured('modelPolicies'))) : null,
          group.title === 'analysisGroup' ? h('details', { className: 'pac-settings-advanced' }, h('summary', null, h(IconChevronRightOutlineRegular, { size: 14 }), t('settingsAdvanced')),
            h('div', { className: 'pac-settings-row' }, renderLabel('backgroundModelPolicy', 'backgroundModelPolicy', `${idPrefix}-backgroundModelPolicy`),
              h(SettingsSelect, { id: `${idPrefix}-backgroundModelPolicy`, label: t('backgroundModelPolicy'), value: draft.backgroundModelPolicy, options: policyOptionsFor('dsh_subagent', draft.backgroundModelPolicy), disabled: busy, invalid: !!formErrors.backgroundModelPolicy, onChange: value => update('backgroundModelPolicy', value) })),
            group.advanced.filter(key => key !== 'backgroundModelPolicy').map(renderField)) : null,
          group.title !== 'workerGroup' && group.title !== 'analysisGroup' && group.advanced.length ? h('details', { className: 'pac-settings-advanced' }, h('summary', null, h(IconChevronRightOutlineRegular, { size: 14 }), t('settingsAdvanced')), group.advanced.map(renderField)) : null))),
        h('div', { className: 'pac-settings-footer' },
          h('p', { className: 'pac-settings-description' }, t('settingsRestoreHint')),
          h(Button, { size: 'sm', variant: 'outline', type: 'button', disabled: busy || saving || !defaults || JSON.stringify({ ...draft, codexWorkerEnabled: defaults.codexWorkerEnabled }) === JSON.stringify(defaults), onClick: () => { if (window.confirm(t('settingsRestoreConfirm'))) settings.restore(); } }, t('settingsRestore')))));
    }

    function memoryGraphData(records) {
      const nodes = new Map();
      const edges = [];
      const edgeKeys=new Set();
      const supported = new Set(['memory', 'entity', 'session-task', 'task']);
      const addNode = (type, id, label, record) => {
        if (!supported.has(type) || typeof id !== 'string' || !id) return null;
        const key = type + ':' + id;
        const current = nodes.get(key);
        if (current) {
          if (record) {current.record = record;current.contextOnly=false;}
          return key;
        }
        nodes.set(key, { key, type, id, contextOnly:!record, label: String(label || id), record: record || { id, type } });
        return key;
      };
      for (const record of records) {
        if (record.type !== 'relation') addNode(record.type, record.id, record.title || record.content || record.name || record.objective, record);
      }
      for (const record of records) {
        if (record.type !== 'relation') continue;
        const from = addNode(record.fromKind, record.fromId, record.from, null);
        const to = addNode(record.toKind, record.toId, record.to, null);
        if (from && to && !edgeKeys.has(from+'>'+to+'>'+record.relation)){edgeKeys.add(from+'>'+to+'>'+record.relation);edges.push({ from, to, label: record.relation, record: { ...record, derived: record.fromKind === 'session-task', fromLabel: nodes.get(from).label, toLabel: nodes.get(to).label } })}
      }
      return { nodes: [...nodes.values()], edges };
    }

    function MemoryGraph({ records, selected, onSelect, t }) {
      const canvasRef = React.useRef(null);
      const rendererRef = React.useRef(null);
      const selectionRef = React.useRef({ selected, onSelect });
      const [error, setError] = React.useState('');
      selectionRef.current = { selected, onSelect };
      React.useEffect(() => {
        setError('');
        try {
          const renderer = createStarMapRenderer(canvasRef.current, {
            graph: memoryGraphData(records),
            onSelect: record => selectionRef.current.onSelect(record),
            labels: { memory: t('memoryRecord'), 'session-task': t('sessionTask'), entity: t('memoryEntity'), task: t('memoryTask') },
            reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
          });
          rendererRef.current = renderer;
          renderer.select(selectionRef.current.selected);
        } catch (failure) { setError(String(failure?.message || failure)); }
        return () => { rendererRef.current?.dispose(); rendererRef.current = null; };
      }, [records, t]);
      React.useEffect(() => { rendererRef.current?.select(selected); }, [selected]);
      return h(React.Fragment, null,
        h('canvas', { ref: canvasRef, className: 'pac-memory-graph', 'aria-hidden': 'true' }),
        error ? h('p', { className: 'pac-memory-graph-error', role: 'alert' }, t('memoryGraphError') + ': ' + error) : null);
    }

    function localDateTime(value) {
      const date = new Date(value);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
    }
    function MemoryBrowser({ t, escapeSelectionRef }) {
      const defaults = { type: 'all', query: '', state: '', sourceSystem: '', from: '', to: '', rawSearch: false };
      const types = [['all','memoryAll'],['session-task','sessionTask'],['memory','memoryRecord'],['entity','memoryEntity'],['relation','memoryRelation'],['task','memoryTask']];
      const states = ['candidate','user-stated','confirmed','superseded','retracted','source','recorded','open','active','waiting','completed','cancelled','merged'];
      const [filters, setFilters] = React.useState(defaults);
      const [drawer, setDrawer] = React.useState(null);
      const drawerTabsRef = React.useRef(null);
      const detailPanelRef = React.useRef(null);
      const mapRef = React.useRef(null);
      React.useEffect(() => {
        if (drawer === 'detail' && window.matchMedia('(max-width: 900px)').matches) detailPanelRef.current?.focus();
      }, [drawer]);
      const [records, setRecords] = React.useState([]);
      const [graphRecords,setGraphRecords]=React.useState([]);
      const listVersion=React.useRef(null);
      const [queryRange,setQueryRange]=React.useState(null);
      const [supplementary,setSupplementary]=React.useState([]);
      const [coverage,setCoverage]=React.useState(null);
      const [hasMore, setHasMore] = React.useState(false);
      const [offset, setOffset] = React.useState(0);
      const [index, setIndex] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [detailLoading, setDetailLoading] = React.useState(false);
      const [content, setContent] = React.useState('');
      const [memoryKind, setMemoryKind] = React.useState('fact');
      const [predicate, setPredicate] = React.useState('');
      const [objectJSON, setObjectJSON] = React.useState('null');
      const [scopeJSON, setScopeJSON] = React.useState('{}');
      const [validFrom, setValidFrom] = React.useState('');
      const [validTo, setValidTo] = React.useState('');
      const [relationLabel, setRelationLabel] = React.useState('');
      const [entityName, setEntityName] = React.useState('');
      const [entityType, setEntityType] = React.useState('other');
      const [entityTags, setEntityTags] = React.useState('');
      const [entityAliases, setEntityAliases] = React.useState('');
      const [attributes, setAttributes] = React.useState([]);
      const [experienceNote, setExperienceNote] = React.useState('');
      const [experienceTags, setExperienceTags] = React.useState('');
      const [experienceEntityIds, setExperienceEntityIds] = React.useState([]);
      const [taskState, setTaskState] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [mutationBusy, setBusy] = React.useState(false);
      const [initialization, setInitialization] = React.useState(null);
      const [initializationError, setInitializationError] = React.useState('');
      const initializationRequest = React.useRef(null);
      const initializationPoll = React.useRef(null);
      const initializationRunning = React.useRef(false);
      const busy = mutationBusy || initialization?.running === true;
      const [error, setError] = React.useState('');
      const [message, setMessage] = React.useState('');
      const listRequest = React.useRef(null);
      const detailRequest = React.useRef(null);
      const mutationRequest = React.useRef(null);
      React.useEffect(() => () => {
        listRequest.current?.abort();
        detailRequest.current?.abort();
        mutationRequest.current?.abort();
      }, []);

      const dateValue = value => value ? new Date(value).toLocaleString() : '';
      const titleOf = value => value?.title || value?.content || value?.name || value?.objective || value?.title || `${value?.type || ''} ${value?.id || ''}`;
      const load = async (query, { append = false } = {}) => {
        listRequest.current?.abort();
        const controller = new AbortController();
        listRequest.current = controller;
        setLoading(true); setError('');
        try {
          const nextOffset = append ? offset : 0;
          const result = await requestMemory('GET', { ...query, version:append?listVersion.current:undefined, source: query.sourceSystem, sourceSystem: undefined, from: query.from ? new Date(query.from).toISOString() : '', to: query.to ? new Date(query.to).toISOString() : '', limit: 100, offset: nextOffset }, undefined, controller.signal);
          if (controller.signal.aborted) return;
          listVersion.current=result.version;setQueryRange(result.range);
          setRecords(current => append ? [...new Map([...current, ...(result.records || [])].map(record=>[record.type+':'+record.id,record])).values()] : (result.records || []));
          setGraphRecords(current=>append?[...new Map([...current,...(result.graphRecords||[])].map(item=>[item.type+':'+item.id,item])).values()]:(result.graphRecords||[]));
          setSupplementary(current=>append?[...new Map([...current,...result.supplementary].map(record=>[record.id,record])).values()]:result.supplementary);setCoverage(result.coverage);
          setOffset(result.nextOffset); setHasMore(result.hasMore === true); setIndex(result.index || null);
        } catch (failure) { if (!controller.signal.aborted) setError(String(failure?.message || failure || t('memoryOperationError'))); }
        finally { if (!controller.signal.aborted) setLoading(false); }
      };
      React.useEffect(() => { void load(defaults); }, []);

      const clearMemoryView = () => {
        listRequest.current?.abort(); detailRequest.current?.abort();
        setError(''); setMessage('');
        setRecords([]); setGraphRecords([]);setSupplementary([]);setCoverage(null); setIndex(null); setSelected(null); setDetail(null); setHasMore(false); setOffset(0); setLoading(false); setDetailLoading(false);
      };
      React.useEffect(() => {
        let active = true;
        let timer;
        const poll = async () => {
          window.clearTimeout(timer);
          initializationRequest.current?.abort();
          if (!active || document.hidden) return;
          const controller = new AbortController();
          initializationRequest.current = controller;
          try {
            const value = await requestMemoryInitialization('GET', controller.signal);
            if (!active || controller.signal.aborted) return;
            setInitialization(value); setInitializationError('');
            if (value.running && !initializationRunning.current) clearMemoryView();
            if (!value.running && initializationRunning.current) { setFilters(defaults); await load(defaults); }
            initializationRunning.current = value.running;
          } catch (failure) {
            if (active && !controller.signal.aborted) setInitializationError(String(failure?.message || failure));
          } finally {
            if (active && !controller.signal.aborted) timer = window.setTimeout(poll, 1500);
          }
        };
        initializationPoll.current = poll;
        document.addEventListener('visibilitychange', poll);
        void poll();
        return () => { active = false; window.clearTimeout(timer); initializationRequest.current?.abort(); initializationPoll.current = null; document.removeEventListener('visibilitychange', poll); };
      }, []);

      const initializeMemory = async () => {
        if (busy || mutationRequest.current || !initialization || initializationError || !window.confirm(t('memoryInitializeConfirm'))) return;
        initializationRequest.current?.abort();
        const controller = new AbortController();
        mutationRequest.current = controller;
        setBusy(true); setError(''); setMessage('');
        try {
          const value = await requestMemoryInitialization('POST', controller.signal);
          if (controller.signal.aborted) return;
          clearMemoryView(); setInitialization(value); initializationRunning.current = value.running;
        } catch (failure) {
          if (!controller.signal.aborted) setError(String(failure?.message || failure));
        } finally {
          mutationRequest.current = null;
          if (!controller.signal.aborted) { setBusy(false); void initializationPoll.current?.(); }
        }
      };

      const clearSelection = () => {
        if (mutationRequest.current) return true;
        detailRequest.current?.abort(); detailRequest.current = null;
        setSelected(null); setDetail(null); setDetailLoading(false); setDrawer(null); setError('');
        mapRef.current?.focus();
        return true;
      };
      if (escapeSelectionRef) escapeSelectionRef.current = selected ? clearSelection : null;
      const choose = async (record, refresh = false) => {
        if (!record) { clearSelection(); return; }
        if (mutationRequest.current && !refresh) return;
        detailRequest.current?.abort();
        const controller = new AbortController();
        detailRequest.current = controller;
        setSelected(record); setDetail(null); setDetailLoading(true); setError(''); setDrawer('detail');
        if (record.type === 'relation' && record.derived) {
          setDetail({ ...record, from: { kind: record.fromKind, id: record.fromId, object: { title: record.fromLabel } }, to: { kind: record.toKind, id: record.toId, object: { title: record.toLabel } } });
          setDetailLoading(false); return;
        }
        const key = { 'raw-hit':'historyMessageId', 'session-task':'sessionTaskId', memory: 'memoryId', entity: 'entityId', experience: 'evidenceId', task: 'taskId', relation: 'edgeId' }[record.type];
        if (!key) {setDetailLoading(false);return;}
        try {
          const value = await requestMemory('GET', { [key]: record.id }, undefined, controller.signal);
          if (controller.signal.aborted) return;
          setDetail(value || record);
          const source = value?.task || value;
          setContent(source?.content || ''); setEntityName(source?.name || '');
          setMemoryKind(source?.kind || 'fact'); setPredicate(source?.predicate || '');
          setObjectJSON(JSON.stringify(source?.object ?? null, null, 2)); setScopeJSON(JSON.stringify(source?.scope ?? {}, null, 2));
          setValidFrom(source?.validFrom ? localDateTime(source.validFrom) : '');
          setValidTo(source?.validTo ? localDateTime(source.validTo) : '');
          setRelationLabel(value?.relation || '');
          setEntityTags(Array.isArray(source?.tags) ? source.tags.join(', ') : '');
          setEntityAliases(Array.isArray(source?.aliases) ? source.aliases.map(item => item.alias).join(', ') : '');
          setEntityType(source?.entityType || 'other');
          setAttributes(Object.entries(source?.attributes || {}).map(([name, item]) => ({ name, value: typeof item === 'string' ? item : JSON.stringify(item) })));
          setTaskState(source?.state || source?.task_state || '');
          setExperienceNote(source?.note || '');
          setExperienceTags(Array.isArray(source?.tags) ? source.tags.join(', ') : '');
          setExperienceEntityIds(Array.isArray(source?.associatedEntityIds) ? source.associatedEntityIds : []);
        } catch (failure) { if (!controller.signal.aborted) { setError(String(failure?.message || failure || t('memoryOperationError'))); } }
        finally { if (!controller.signal.aborted) setDetailLoading(false); }
      };
      const update = (key, value) => setFilters(current => ({ ...current, [key]: value }));
      const mutate = async (body, clear = false) => {
        if (mutationRequest.current) return null;
        const controller = new AbortController();
        mutationRequest.current = controller;
        setBusy(true); setError(''); setMessage('');
        try {
          const value = await requestMemory('POST', {}, body, controller.signal);
          if (controller.signal.aborted) return null;
          await load(filters);
          if (controller.signal.aborted) return null;
          if (clear) { setSelected(null); setDetail(null); }
          else if (selected) await choose(selected, true);
          setMessage(t(body.action === 'run-extraction' ? 'memoryExtractionStarted' : 'memoryOperationDone')); return value;
        } catch (failure) { if (!controller.signal.aborted) setError(String(failure?.message || failure || t('memoryOperationError'))); return null; }
        finally { mutationRequest.current = null; if (!controller.signal.aborted) setBusy(false); }
      };
      const object = detail?.task || detail;
      const kind = selected?.type;
      const input = (label, value, onChange, type = 'text') => h('label', { className: 'pac-memory-field' }, t(label), h('input', { className: 'pac-memory-edit-input', type, step: type === 'datetime-local' ? '0.001' : undefined, value, disabled: busy, onChange: event => onChange(event.currentTarget.value) }));
      const button = (label, action, primary = false) => h(Button, { size: 'sm', variant: primary ? 'primary' : 'outline', type: 'button', className: label === 'memoryDelete' ? 'pac-memory-danger' : undefined, disabled: busy, onClick: action }, t(label));
      const saveEntity = () => {
        const values = Object.fromEntries(attributes.filter(row => row.name.trim()).map(row => {
          let value = row.value;
          try { value = JSON.parse(row.value); } catch (_) {}
          return [row.name.trim(), value];
        }));
        void mutate({ action: 'edit-entity', entityId: object.id, name: entityName, type: entityType, attributes: values,
          tags: entityTags.split(',').map(value => value.trim()).filter(Boolean), aliases: entityAliases.split(',').map(value => value.trim()).filter(Boolean) });
      };
      const saveExperience = () => void mutate({ action: 'edit-experience', evidenceId: object.id, note: experienceNote,
        tags: experienceTags.split(',').map(value => value.trim()).filter(Boolean), entityIds: experienceEntityIds });
      const saveMemory = () => {
        let memoryObject;
        let scope;
        try { memoryObject = JSON.parse(objectJSON); scope = JSON.parse(scopeJSON); }
        catch (failure) { setError(String(failure?.message || failure)); return; }
        void mutate({ action: 'edit-record', memoryId: object.id, kind: memoryKind, content, predicate: predicate || null,
          object: memoryObject, scope, validFrom: validFrom ? new Date(validFrom).toISOString() : null,
          validTo: validTo ? new Date(validTo).toISOString() : null });
      };
      const saveRelation = () => void mutate({ action: 'edit-relation', edgeId: object.id, relation: relationLabel });
      const remove = () => {
        if (kind === 'memory' && window.confirm(t('memoryDeleteConfirm'))) void mutate({ action: 'delete-memory', memoryId: object.id }, true);
        if (kind === 'entity' && window.confirm(t('memoryDeleteEntityConfirm'))) void mutate({ action: 'delete-entity', entityId: object.id }, true);
        if (kind === 'experience' && window.confirm(t('memoryDeleteExperienceConfirm'))) void mutate({ action: 'delete-experience', evidenceId: object.id }, true);
        if (kind === 'relation' && window.confirm(t('memoryDeleteRelationConfirm'))) void mutate({ action: 'delete-relation', edgeId: object.id }, true);
        if (kind === 'session-task' && window.confirm(t('memoryDeleteExperienceConfirm'))) void mutate({action:'delete-session-task',sessionTaskId:object.id},true);
        if (kind === 'task' && window.confirm(t('memoryTaskDeleteConfirm'))) void mutate({ action: 'delete-task', taskId: object.id }, true);
      };
      const sources = object?.sources || [];
      const querySubmit = event => { event.preventDefault(); setMessage(''); void load(filters); };

      const stats = [
        ['session-task', 'sessionTask', index?.sessionTasks || 0, '#ffb86b'],
        ['memory', 'memoryRecord', index?.memories || 0, '#7fc8ff'],
        ['entity', 'memoryEntity', index?.entities || 0, '#9fe6c8'],
        ['relation', 'memoryRelation', index?.relations || 0, '#a6a1ef'],
        ['task', 'memoryTask', index?.tasks || 0, '#ff8fc7']
      ];
      const total = stats.reduce((sum, item) => sum + item[2], 0);
      const heading = (label, micro, children) => h('h2', { className: 'pac-memory-hud-heading' }, t(label), h('em', { className: 'pac-memory-micro' }, t(micro)), children);
      const closeDrawer = () => h(Button, { size: 'sm', variant: 'outline', type: 'button', className: 'pac-memory-drawer-close', onClick: () => { drawerTabsRef.current?.querySelector('[data-panel=' + drawer + ']')?.focus(); setDrawer(null); } }, t('memoryHidePanel'));
      return h(React.Fragment, null,
        h('section', { ref: mapRef, tabIndex: -1, className: 'pac-memory-map', 'aria-label': t('memoryRelations') },
          h(MemoryGraph, { records:graphRecords, selected, t, onSelect: record => void choose(record) })),
        h('nav', { ref: drawerTabsRef, className: 'pac-memory-drawer-tabs', 'aria-label': t('memoryPanels') },
          [['search', 'memorySearch'], ['detail', 'memoryDetails']].map(([value, label]) => h(Button, { size: 'sm', variant: 'outline', type: 'button', key: value, 'data-panel': value, 'aria-controls': 'pac-memory-' + value, 'aria-expanded': drawer === value, onClick: () => setDrawer(current => current === value ? null : value) }, t(label)))),
        h('aside', { id: 'pac-memory-search', className: 'pac-memory-hud pac-memory-browser' + (drawer === 'search' ? ' is-open' : ''), 'aria-label': t('memorySearchLabel') },
          h('section', { className: 'pac-memory-card pac-memory-search-card' },
            heading('memorySearch', 'memorySearchMicro', closeDrawer()),
            h('form', { className: 'pac-memory-filter', onSubmit: querySubmit },
              input('memorySearchLabel', filters.query, value => update('query', value)),
              h('label', { className: 'pac-memory-field' }, t('memoryType'), h('select', { value: filters.type, disabled: busy, onChange: event => update('type', event.currentTarget.value) }, types.map(([value, label]) => h('option', { value, key: value }, t(label))))),
              h('details', { className: 'pac-memory-advanced' }, h('summary', null, h(Glyph, { name: 'chevron' }), t('memoryAdvancedFilters')),
                h('label', {className:'pac-memory-field'},h('span',null,h('input',{type:'checkbox',checked:filters.rawSearch,disabled:busy,onChange:event=>{const next={...filters,rawSearch:event.currentTarget.checked};setFilters(next);void load(next)}}),t('rawSearch')),h('small',null,t('rawSearchHint'))),
                h('div', { className: 'pac-memory-filter-grid' },
                  h('label', { className: 'pac-memory-field' }, t('memoryState'), h('select', { value: filters.state, disabled: busy, onChange: event => update('state', event.currentTarget.value) }, h('option', { value: '' }, t('memoryAnyState')), states.map(value => h('option', { value, key: value }, value)))),
                  h('label', { className: 'pac-memory-field' }, t('memorySource'), h('select', { value: filters.sourceSystem, disabled: busy, onChange: event => update('sourceSystem', event.currentTarget.value) }, h('option', { value: '' }, t('memoryAnySource')), ['dsh','codex','personal-agent','operator'].map(value => h('option', { value, key: value }, value)))),
                  input('memoryFrom', filters.from, value => update('from', value), 'datetime-local'),
                  input('memoryTo', filters.to, value => update('to', value), 'datetime-local'))),
              filters.rawSearch?h(Button,{size:'sm',variant:'outline',type:'button',className:'pac-memory-record-meta',onClick:()=>{const next={...filters,rawSearch:false};setFilters(next);void load(next)}},t('rawSearch')+' ×'):null,
              h('div', { className: 'pac-memory-toolbar' },
                h(Button, { size: 'sm', variant: 'primary', type: 'submit', disabled: loading || busy }, t('memorySearch')),
                h(Button, { size: 'sm', variant: 'outline', type: 'button', disabled: loading || busy, onClick: () => { setFilters(defaults); void load(defaults); } }, t('memoryReset')))),
            error ? h('p', { className: 'pac-memory-status error', role: 'alert' }, t('memoryOperationError') + ': ' + error, selected?h(Button,{size:'sm',variant:'outline',type:'button',onClick:()=>choose(selected,true)},t('retrySource')):null) : null,
            message ? h('p', { className: 'pac-memory-status', role: 'status' }, message) : null,
            busy ? h('p', { className: 'pac-memory-status', role: 'status' }, t('memoryBusy')) : null),
          h('section', { className: 'pac-memory-card pac-memory-results-card' },
            queryRange?.from?h('p',{className:'pac-memory-record-meta'},t('memoryFrom')+': '+dateValue(queryRange.from)+(queryRange.to?' · '+t('memoryTo')+': '+dateValue(queryRange.to):'')):null,
            heading('memoryResults', 'memoryResultsMicro', h('span', { className: 'pac-memory-counter' }, records.length + (hasMore ? '+' : ''))),
            h('div', { className: 'pac-memory-results', 'aria-busy': loading },
              loading && !records.length ? h('p', { className: 'pac-memory-empty', role: 'status' }, t('settingsLoading')) : records.length ? h('ul', { className: 'pac-memory-records' }, records.map(record => h('li', { key: record.type + ':' + record.id }, h('button', {
                className: 'pac-memory-record', type: 'button', 'data-kind': record.type, disabled: busy, 'aria-current': kind === record.type && selected?.id === record.id, onClick: () => void choose(record)
              }, h('span', { className: 'pac-memory-record-title' }, titleOf(record)), h('span', { className: 'pac-memory-record-meta' }, (record.matchCount?t('rawMatches')+': '+record.matchCount+' · ':'')+t(types.find(([value]) => value === record.type)?.[1] || 'memoryRecord') + ' · ' + (record.state || '') + ' · ' + dateValue(record.recordedAt || record.updatedAt))),record.matches?.[0]?.evidenceId?h(Button,{size:'sm',variant:'outline',type:'button',onClick:()=>choose({id:record.matches[0].evidenceId,type:'experience'})},t('rawMatches')):null))) : h('div', { className: 'pac-memory-empty' }, t('memoryNoResults'), !filters.rawSearch?h(Button,{size:'sm',variant:'outline',type:'button',onClick:()=>{const next={...filters,rawSearch:true};setFilters(next);void load(next)}},t('rawSearch')):null),
              supplementary.length?h('details',null,h('summary',null,h(Glyph,{name:'chevron'}),t('rawSupplementary')),supplementary.map(record=>h('button',{className:'pac-memory-link',type:'button',key:record.id,onClick:()=>choose(record)},record.content))):null,
              hasMore ? h('button', { className: 'pac-memory-load-more', type: 'button', disabled: loading || busy, onClick: () => void load(filters, { append: true }) }, t('memoryLoadMore')) : null)),
          h('details', { className: 'pac-memory-card pac-memory-maintenance' }, h('summary', null, h(Glyph, { name: 'chevron' }), t('memoryMaintenance')), h('div', { className: 'pac-memory-actions' },
            button('memoryRebuild', () => void mutate({ action: 'rebuild-index' })),
            
            
            h(Button, { size: 'sm', variant: 'outline', type: 'button', className: 'pac-memory-danger', disabled: busy || !initialization || !!initializationError, onClick: () => void initializeMemory() }, t(initialization?.running ? 'memoryInitializing' : 'memoryInitialize'))),
            initialization?.running ? h('p', { className: 'pac-memory-status', role: 'status' }, t(({ draining: 'memoryInitializeDraining', clearing: 'memoryInitializeClearing', importing: 'memoryInitializeImporting', reconnecting: 'memoryInitializeReconnecting', indexing: 'memoryInitializeIndexing' })[initialization.phase] || 'memoryInitializing')) : null,
            initialization?.state === 'succeeded' ? h('p', { className: 'pac-memory-status', role: 'status' }, t('memoryInitialized')) : null,
            initialization?.state === 'failed' ? h('p', { className: 'pac-memory-status error', role: 'alert' }, t(initialization.cleared ? 'memoryInitializeFailedAfterClear' : 'memoryInitializeFailed') + ': ' + initialization.lastError) : null,
            initializationError ? h('p', { className: 'pac-memory-status error', role: 'alert' }, t('memoryInitializeStatusError') + ': ' + initializationError) : null)),
        h('div', { className: 'pac-memory-map-footer' },
          h('div', { className: 'pac-memory-legend' }, types.filter(([type]) => ['session-task','memory','entity','task'].includes(type)).map(([type, label]) => h('span', { key: type, 'data-kind': type }, t(label)))),
          h('p',null,t('graphLoaded')+': '+memoryGraphData(graphRecords).nodes.length+' · '+t('memoryRelation')+': '+memoryGraphData(graphRecords).edges.length),
          h('p', null, t('memoryGraphControls')), h('p', { className: 'pac-memory-map-hint' }, t('memoryGraphHint')+' · '+t('graphContext'))),
        h('aside', { ref: detailPanelRef, tabIndex: -1, id: 'pac-memory-detail', className: 'pac-memory-hud pac-memory-inspector' + (drawer === 'detail' ? ' is-open' : ''), 'aria-label': t('memoryDetails') },
          h('section', { className: 'pac-memory-card pac-memory-composition' },
            heading('memoryComposition', 'memoryCompositionMicro'),
            h('div', { className: 'pac-memory-mixbar', 'aria-hidden': 'true' }, stats.map(([type, label, count, color]) => h('span', { key: type, style: { '--pac-node': color, width: (total ? count / total * 100 : 0) + '%' } }))),
            stats.map(([type, label, count, color]) => h('button', { type: 'button', key: type, className: 'pac-memory-stat', disabled: busy || loading, style: { '--pac-node': color }, 'aria-pressed': filters.type === type, onClick: () => { const next = { ...filters, type }; setFilters(next); void load(next); } }, t(label), h('b', null, count.toLocaleString()))),
            h('p', { className: 'pac-memory-index' }, index ? t('needsReview')+': '+index.needsReview+' · '+t('memorySessions')+': '+index.sessions+' · '+t('historyCoverage')+': '+(coverage?.sessionsPending??0)+' · '+t('memoryIndex') + ': ' + t('memoryExperience') + ' ' + index.indexedExperiences + '/' + index.experiences + ' · ' + t('memoryRecord') + ' ' + index.indexedMemories + '/' + index.memories : t('settingsLoading'))),
          h('section', { className: 'pac-memory-card pac-memory-detail-card', 'aria-busy': detailLoading },
            heading('memoryDetails', 'memoryDetailMicro', h(React.Fragment, null, selected ? h(Button, { size: 'sm', variant: 'outline', type: 'button', className: 'pac-memory-clear-selection', disabled: busy, onClick: clearSelection, title: t('memoryClearSelectionHint') }, t('memoryClearSelection')) : null, closeDrawer())),
          !detail || detail.id!==selected?.id && detail.task?.taskId!==selected?.id ? h('p', { className: 'pac-memory-empty', role: detailLoading ? 'status' : undefined }, t(detailLoading ? 'settingsLoading' : 'memoryDetails')) : h('article', { className: 'pac-memory-detail' },
            h('h3', { className: 'pac-memory-inspector-title' }, kind === 'experience' ? t('memoryExperience') : kind === 'relation' ? t('memoryRelation') + ' · ' + object.relation : titleOf(object)),
            kind === 'relation' ? null : h('p', { className: 'pac-memory-inspector-meta' }, `${t('status')}: ${object.state || object.task_state || object.memory_state || selected?.state || ''} · ${dateValue(object.recordedAt || object.updatedAt || object.source?.occurredAt)}`),
            kind === 'session-task' ? h(React.Fragment,null,h('p',{className:'pac-memory-detail-content'},object.content),h('h3',null,t('memoryProcess')),h('p',{className:'pac-memory-detail-content'},object.summary),h('p',{className:'pac-memory-record-meta'},t('session')+': '+object.sessionId),h('h3',null,t('memoryEntity')),(object.entities||[]).map(entity=>h('button',{className:'pac-memory-link',type:'button',key:entity.id,onClick:()=>choose({id:entity.id,type:'entity'})},entity.name)),h('h3',null,t('memoryRecord')),(object.memories||[]).map(memory=>h('button',{className:'pac-memory-link',type:'button',key:memory.id,onClick:()=>choose({id:memory.id,type:'memory'})},memory.content)),h('details',null,h('summary',null,h(Glyph,{name:'chevron'}),t('historyMessages')),(object.messages||[]).map(item=>h('button',{type:'button',className:'pac-memory-record',key:item.id,onClick:()=>choose({id:item.evidenceId,type:'experience'})},item.role+' · '+dateValue(item.occurredAt))),object.hasMore?h(Button,{size:'sm',variant:'outline',type:'button',disabled:detailLoading,onClick:async()=>{detailRequest.current?.abort();const controller=new AbortController();detailRequest.current=controller;setDetailLoading(true);try{const next=await requestMemory('GET',{sessionTaskId:object.id,version:object.version,offset:(object.messages||[]).length},undefined,controller.signal);if(!controller.signal.aborted)setDetail(current=>({...next,messages:[...current.messages,...next.messages],offset:0}))}catch(failure){if(!controller.signal.aborted)setError(String(failure.message))}finally{if(!controller.signal.aborted)setDetailLoading(false)}}},t('memoryLoadMore')):null)) : null,
            kind === 'memory' ? h(React.Fragment,null,h('p',{className:'pac-memory-detail-content'},object.content),h('details', { className: 'pac-memory-edit' },h('summary',null,h(Glyph,{name:'chevron'}),t('memoryManagement')),
              h('label', { className: 'pac-memory-field' }, t('memoryContent'), h('textarea', { className: 'pac-memory-edit-textarea', disabled: busy, value: content, onChange: event => setContent(event.currentTarget.value) })),
              h('label', { className: 'pac-memory-field' }, t('memoryKind'), h('select', { className: 'pac-memory-edit-input', disabled: busy, value: memoryKind, onChange: event => setMemoryKind(event.currentTarget.value) }, ['fact','reflection','decision','summary'].map(value => h('option', { value, key: value }, value)))),
              input('memoryPredicate', predicate, setPredicate), input('memoryObject', objectJSON, setObjectJSON), input('memoryScope', scopeJSON, setScopeJSON),
              input('memoryValidFrom', validFrom, setValidFrom, 'datetime-local'), input('memoryValidTo', validTo, setValidTo, 'datetime-local'),
              h('div', { className: 'pac-memory-actions' }, button('memorySave', saveMemory, true)))) : null,
            kind === 'entity' ? h('details', { className: 'pac-memory-edit' },h('summary',null,h(Glyph,{name:'chevron'}),t('memoryManagement')),
              input('memoryEntityName', entityName, setEntityName),
              h('label', { className: 'pac-memory-field' }, t('memoryEntityType'), h('select', { className: 'pac-memory-edit-input', disabled: busy, value: entityType, onChange: event => setEntityType(event.currentTarget.value) }, ['user','project','repository','person','tool','task','session','artifact','other'].map(value => h('option', { value, key: value }, value)))),
              input('memoryEntityTags', entityTags, setEntityTags), input('memoryEntityAliases', entityAliases, setEntityAliases),
              h('div', { className: 'pac-memory-field' }, t('memoryEntityAttributes'), h('div', { className: 'pac-memory-attributes' },
                attributes.map((row, index) => h('div', { className: 'pac-memory-attribute', key: index },
                  h('input', { className: 'pac-memory-edit-input', 'aria-label': t('memoryAttributeKey'), disabled: busy, value: row.name, onChange: event => setAttributes(current => current.map((item, itemIndex) => index === itemIndex ? { ...item, name: event.currentTarget.value } : item)) }),
                  h('input', { className: 'pac-memory-edit-input', 'aria-label': t('memoryAttributeValue'), disabled: busy, value: row.value, onChange: event => setAttributes(current => current.map((item, itemIndex) => index === itemIndex ? { ...item, value: event.currentTarget.value } : item)) }),
                  h(Button, { size: 'sm', variant: 'ghost', className: 'pac-memory-attribute-remove', type: 'button', disabled: busy, 'aria-label': t('memoryDelete'), title: t('memoryDelete'), onClick: () => setAttributes(current => current.filter((_, itemIndex) => index !== itemIndex)) }, h(IconTrashOutlineRegular, { size: 16 })))),
                h(Button, { size: 'sm', variant: 'outline', type: 'button', disabled: busy, onClick: () => setAttributes(current => [...current, { name: '', value: '' }]) }, h(IconPlusOutlineRegular, { size: 16 }), t('memoryAddAttribute')))),
              h('div', { className: 'pac-memory-actions' }, button('memorySave', saveEntity, true))) : null,
            kind === 'task' ? h('div', { className: 'pac-memory-edit' },
              h('label', { className: 'pac-memory-field' }, t('status'), h('select', { className: 'pac-memory-edit-input', disabled: busy, value: taskState, onChange: event => setTaskState(event.currentTarget.value) }, ['open','active','waiting','completed','cancelled','merged'].map(value => h('option', { value, key: value }, value)))),
              h('div', { className: 'pac-memory-actions' }, h(Button, { size: 'sm', variant: 'primary', type: 'button', disabled: busy || taskState === (object.state || object.task_state), onClick: () => void mutate({ action: 'transition-task', taskId: object.id || object.taskId, state: taskState, expectedState: object.state || object.task_state }) }, t('memorySave'))),
              h('pre', null, JSON.stringify({ steps: detail.steps || [], workers: detail.workers || [] }, null, 2))) : null,
            kind === 'raw-hit'?h('p',{className:'pac-memory-detail-content'},object.content):null,
            kind === 'experience' ? h(React.Fragment, null,
              h('p', { className: 'pac-memory-detail-content' }, object.content),
              h('p', { className: 'pac-memory-record-meta' }, `${object.source?.citation?.label || ''} · ${dateValue(object.source?.occurredAt)}`),
              h('div', { className: 'pac-memory-edit' },
                h('label', { className: 'pac-memory-field' }, t('memoryExperienceNote'), h('textarea', { className: 'pac-memory-edit-textarea', disabled: busy, value: experienceNote, onChange: event => setExperienceNote(event.currentTarget.value) })),
                input('memoryEntityTags', experienceTags, setExperienceTags),
                h('label', { className: 'pac-memory-field' }, t('memoryAssociatedEntities'), h('select', { className: 'pac-memory-edit-input', disabled: busy, multiple: true, value: experienceEntityIds, onChange: event => setExperienceEntityIds([...event.currentTarget.selectedOptions].map(option => option.value)) },
                  [...new Map([...(records.filter(record => record.type === 'entity')), ...(object.entities || [])].map(entity => [entity.id, entity])).values()].map(entity => h('option', { value: entity.id, key: entity.id }, entity.name)))),
                h('div', { className: 'pac-memory-actions' }, button('memorySave', saveExperience, true)))) : null,
            object.sessionTasks?.length?h('section',null,h('h3',null,t('sessionTask')),object.sessionTasks.map(task=>h('button',{className:'pac-memory-link',type:'button',key:task.id,onClick:()=>choose({type:'session-task',id:task.id})},task.title))):null,
            kind === 'experience' && object.surrounding?.length?h('details',null,h('summary',null,h(Glyph,{name:'chevron'}),t('historyMessages')),object.surrounding.map(item=>h('button',{className:'pac-memory-link',type:'button',key:item.id,onClick:()=>choose(item.evidenceId?{id:item.evidenceId,type:'experience'}:{id:item.id,type:'raw-hit'})},dateValue(item.occurredAt)))):null,
            kind === 'experience' && (object.memories?.length || object.entities?.length) ? h('div', { className: 'pac-memory-detail-section' }, h('h3', null, t('memoryRelations')), h('pre', null, JSON.stringify({ memories: object.memories || [], entities: (object.entities || []).map(entity => ({ id: entity.id, type: entity.type, name: entity.name })) }, null, 2))) : null,
            kind === 'relation' ? h('div', { className: 'pac-memory-detail-section' },
              h('p', { className: 'pac-memory-detail-content' }, t(object.derived ? 'memoryDerivedRelation' : 'memoryStoredRelation')),
              [object.from, object.to].map((endpoint, i) => h('div', { className: 'pac-memory-relation-endpoint', key: i === 0 ? 'from' : 'to' },
                h('span', null, t(i === 0 ? 'memoryRelationFrom' : 'memoryRelationTo')),
                h('button', { type: 'button', className: 'pac-memory-record', onClick: () => choose({ type: endpoint.kind, id: endpoint.id }) }, titleOf(endpoint.object?.task || endpoint.object) || endpoint.id))),
              object.source ? h('div', { className: 'pac-memory-source' }, h('p', null, object.source.citation?.label || object.evidenceId), h(Button, { size: 'sm', variant: 'outline', type: 'button', onClick: () => choose({ type: 'experience', id: object.evidenceId }) }, t('historyMessages'))) : null,
              !object.derived ? h('details', { className: 'pac-memory-edit' }, h('summary', null, h(Glyph, { name: 'chevron' }), t('memoryManagement')), input('memoryRelationLabel', relationLabel, setRelationLabel), h('div', { className: 'pac-memory-actions' }, button('memorySave', saveRelation, true))) : null) : null,
            kind === 'memory' || kind === 'entity' ? h('details', { className: 'pac-memory-detail-section' }, h('summary', null, h(Glyph, { name: 'chevron' }), t('memorySources')),
              sources.length ? sources.map((source, index) => h('div', { className: 'pac-memory-source', key: `${source.evidenceId}:${index}` }, h('div', null, `${source.citation?.label || source.evidenceId} · ${source.stance || ''} · ${source.authorRole || ''}`), source.quote ? h('p', null, source.quote) : null,h(Button,{size:'sm',variant:'outline',type:'button',onClick:()=>choose({id:source.evidenceId,type:'experience'})},t('historyMessages')))) : h('p', { className: 'pac-memory-empty' }, t('memoryNoResults'))) : null,
            kind === 'memory' || kind === 'entity' ? h('section', { className: 'pac-memory-detail-section' }, h('h3', null, t('memoryRelations')), (object.memories||[]).map(memory=>h('button',{className:'pac-memory-link',type:'button',key:memory.id,onClick:()=>choose({id:memory.id,type:'memory'})},memory.content)),(object.relations||[]).map(relation=>{const own=relation.from_kind===kind&&relation.from_id===object.id;const type=own?relation.to_kind:relation.from_kind,id=own?relation.to_id:relation.from_id;return h('button',{className:'pac-memory-link',type:'button',key:relation.edge_id,onClick:()=>choose({type,id})},relation.relation+' · '+t(types.find(([value])=>value===type)?.[1]||'memoryRecord'))})) : null,
            kind === 'memory' || kind === 'entity' || kind === 'experience' || kind === 'relation' && !object.derived || kind === 'task' || kind === 'session-task' ? h('div', { className: 'pac-memory-actions' },
              kind === 'memory' && object.state === 'candidate' ? button('memoryConfirm', () => void mutate({ action: 'confirm', memoryId: object.id })) : null,
              kind === 'entity' && object.state === 'candidate' ? button('memoryConfirm', () => void mutate({ action: 'confirm-entity', entityId: object.id })) : null,
              kind === 'memory' && !['retracted','superseded'].includes(object.state) ? button('memoryRetract', () => void mutate({ action: 'retract', memoryId: object.id })) : null,
              button('memoryDelete', remove)) : null))));
    }

    function MemoryOverlay({ t, store }) {
      const [closing, setClosing] = React.useState(false);
      const screenRef = React.useRef(null);
      const closeRef = React.useRef(null);
      const timerRef = React.useRef(null);
      const closingRef = React.useRef(false);
      const escapeSelectionRef = React.useRef(null);
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      const close = () => {
        if (closingRef.current || !state.memoryOpen) return;
        closingRef.current = true;
        setClosing(true);
        timerRef.current = window.setTimeout(store.closeMemory, 220);
      };
      React.useEffect(() => {
        if (!state.memoryOpen) return undefined;
        closingRef.current = false;
        setClosing(false);
        const previous = document.activeElement;
        const screen = screenRef.current;
        const previousOverflow = document.body?.style.overflow || '';
        if (document.body) document.body.style.overflow = 'hidden';
        closeRef.current?.focus();
        const onKeyDown = event => {
          if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) { event.preventDefault(); if (!escapeSelectionRef.current?.()) close(); return; }
          if (event.key !== 'Tab' || !screen) return;
          const controls = [...screen.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[href],[tabindex]:not([tabindex="-1"])')].filter(node => node.getClientRects().length);
          if (!controls.length) { event.preventDefault(); screen.focus(); return; }
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || !screen.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || !screen.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          window.clearTimeout(timerRef.current);
          const video = screen?.querySelector('video');
          if (video) { video.pause(); video.currentTime = 0; }
          if (document.body) document.body.style.overflow = previousOverflow;
          if (previous?.isConnected) previous.focus();
        };
      }, [state.memoryOpen]);
      if (!state.memoryOpen) return null;
      return h('div', {
        ref: screenRef, className: `pac-memory-screen${closing ? ' is-closing' : ''}`, role: 'dialog', 'aria-modal': 'true',
        'aria-labelledby': 'pac-memory-screen-title', tabIndex: -1
      },
        h('video', {
          className: 'pac-memory-video', src: '/api/personal-agent/assets/starmap_bg.mp4', autoPlay: !reducedMotion, muted: true, loop: true, playsInline: true,
          preload: 'metadata', tabIndex: -1, 'aria-hidden': 'true', onCanPlay: event => {
            if (reducedMotion) { event.currentTarget.pause(); return; }
            void event.currentTarget.play().catch(() => {});
          }
        }),
        h('header', { className: 'pac-memory-header' },
          h('div', { className: 'pac-memory-brand' }, h('span', { className: 'pac-memory-title-mark', 'aria-hidden': 'true' }, h(Glyph, { name: 'memory' })), h('div', null, h('h1', { className: 'pac-memory-brand-title', id: 'pac-memory-screen-title' }, t('memoryTitle')), h('p', { className: 'pac-memory-subtitle' }, t('memorySubtitle')))),
          h(Button, { size: 'sm', variant: 'outline', ref: closeRef, className: 'pac-icon-button', type: 'button', title: t('closeMemory'), 'aria-label': t('closeMemory'), onClick: close }, h(Glyph, { name: 'close' }))),
        h('div', { className: 'pac-memory-layout' }, h(MemoryBrowser, { t, escapeSelectionRef })));
    }

    function createAssistantSessionHost(ctx, t) {
      let state = { reference: null, loading: false, error: '' };
      let pending = null;
      let retainedSessionId = null;
      let disposed = false;
      let suspended = false;
      const listeners = new Set();
      const publish = patch => {
        state = { ...state, ...patch };
        listeners.forEach(listener => listener());
      };
      const ensure = () => {
        if (disposed || suspended) return Promise.resolve(null);
        if (pending) return pending;
        publish({ loading: true, error: '' });
        pending = (async () => {
          let response = await fetch('/api/personal-agent/session', {
            credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }
          });
          let canonical = await responseJson(response);
          if (!canonical?.sessionId) {
            response = await fetch('/api/personal-agent/session', {
              method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}'
            });
            canonical = await responseJson(response);
          }
          const sessionId = canonical?.sessionId && canonical.agentPreset === 'standard' ? canonical.sessionId : null;
          if (!sessionId) throw new Error(t('contextUnavailable'));
          if (disposed || suspended) return null;
          if (state.reference && retainedSessionId === sessionId) { publish({ loading: false, error: '' }); return state.reference; }
          state.reference?.release();
          publish({ reference: null });
          const reference = ctx.sessions.retain(sessionId, { source: 'personalAssistantMain' });
          try {
            await reference.ready;
            if (disposed || suspended) {
              reference.release();
              return null;
            }
            retainedSessionId = sessionId;
            publish({ reference, loading: false, error: '' });
            return reference;
          } catch (error) {
            reference.release();
            throw error;
          }
        })().catch(error => {
          if (!disposed && !suspended) publish({ loading: false, error: String(error?.message || error || t('contextUnavailable')) });
          return null;
        }).finally(() => { pending = null; });
        return pending;
      };
      return {
        ensure,
        suspend() {
          suspended = true;
          state.reference?.release();
          retainedSessionId = null;
          publish({ reference: null, loading: true, error: '' });
        },
        async resume() {
          await pending;
          if (disposed) return null;
          suspended = false;
          return ensure();
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        getSnapshot() { return state; },
        dispose() {
          disposed = true;
          state.reference?.release();
          retainedSessionId = null;
          state = { reference: null, loading: false, error: '' };
          listeners.clear();
        }
      };
    }

    function formatDate(value, locale, fallback = '') {
      if (!value || !Number.isFinite(new Date(value).getTime())) return fallback;
      try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
      catch (_) { return new Date(value).toISOString(); }
    }

    function taskTitle(task, t) {
      return task?.title || task?.objective || task?.name || t('untitledTask');
    }

    function AssistantMain({ host, t, SessionProvider, renderSlot }) {
      const state = React.useSyncExternalStore(host.subscribe, host.getSnapshot);
      React.useEffect(() => {
        void host.ensure();
        const refresh = () => { if (!document.hidden) void host.ensure(); };
        window.addEventListener('focus', refresh);
        return () => { window.removeEventListener('focus', refresh); };
      }, [host]);
      if (state.reference && !state.error) return h(SessionProvider, { session: state.reference },
        renderSlot('personal-agent-core.conversation', {}));
      return h('main', { className: 'pac-launch', 'aria-label': t('panel') },
        h('p', { className: state.error ? 'pac-launch-error' : undefined, role: state.error ? 'alert' : 'status' }, state.error ? `${t('sendError')}: ${state.error}` : t('sending')),
        state.error ? h(Button, { size: 'sm', variant: 'outline', className: 'pac-inline-button', type: 'button', onClick: host.ensure }, t('retry')) : null
      );
    }

    function AssistantConversation({ sessionId, store, t, renderFactorySlot }) {
      return h('main', { className: 'pac-assistant-page', 'aria-label': t('panel') },
        h('header', { className: 'pac-assistant-heading', 'data-window-drag': true },
          h('h1', null, t('panel')), h(TaskHeaderAction, { sessionId, store, t })),
        h('section', { className: 'pac-assistant-conversation' },
          renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })));
    }

    function installAssistantContextVisibility() {
      const hiddenRows = new Set();
      const root = document.documentElement;
      const sync = () => {
        if (!root.hasAttribute('data-pac-assistant-session')) {
          for (const row of hiddenRows) row.removeAttribute('data-pac-hidden-context');
          hiddenRows.clear();
          return;
        }
        const body = document.body;
        if (!body) return;
        for (const source of body.querySelectorAll('[data-context-source]')) {
          const producer = source.textContent?.trim();
          if (producer !== 'personal-assistant' && producer !== 'runtime-context') continue;
          let row = null;
          let current = source.parentElement;
          while (current && current !== body) {
            if (Array.from(current.classList).some(name => name.endsWith('_root')) || current.querySelector?.('[data-context-injection-body]')) {
              row = current;
              break;
            }
            current = current.parentElement;
          }
          if (row) {
            row.setAttribute('data-pac-hidden-context', 'true');
            hiddenRows.add(row);
          }
        }
      };
      const observer = typeof window.MutationObserver === 'function' ? new window.MutationObserver(sync) : null;
      sync();
      if (observer) {
        observer.observe(root, { attributes: true, attributeFilter: ['data-pac-assistant-session'] });
        if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      }
      return () => {
        observer?.disconnect();
        for (const row of hiddenRows) row.removeAttribute('data-pac-hidden-context');
        hiddenRows.clear();
      };
    }

    let assistantMarkerOwner = null;

    function AssistantSessionMarker({ sessionId, store }) {
      const token = React.useRef(Symbol('personal-assistant-session')).current;
      React.useEffect(() => {
        let cancelled = false;
        store.assistantSession(sessionId).then(assistant => {
          if (cancelled || !assistant) return;
          assistantMarkerOwner = token;
          document.documentElement.setAttribute('data-pac-assistant-session', '');
        }).catch(() => {});
        return () => {
          cancelled = true;
          if (assistantMarkerOwner === token) {
            assistantMarkerOwner = null;
            document.documentElement.removeAttribute('data-pac-assistant-session');
          }
        };
      }, [sessionId, store, token]);
      return null;
    }

    function TaskHeaderAction({ sessionId, store, t }) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const [assistant, setAssistant] = React.useState(false);
      React.useEffect(() => {
        let cancelled = false;
        store.assistantSession(sessionId).then(value => { if (!cancelled) setAssistant(value); }).catch(() => {});
        return () => { cancelled = true; };
      }, [sessionId, store]);
      React.useEffect(() => assistant ? store.watchExtraction() : undefined, [assistant, store]);
      if (!assistant) return null;
      const extraction = state.extraction;
      const extractionState = memoryExtractionState(extraction, state.extractionError);
      return h(React.Fragment, null,
        h('button', { className: 'pac-extraction-status', type: 'button', onClick: store.openExtraction,
          title: t('extractionRecords'), 'aria-label': `${t('jobMemory')} · ${t(extractionState)}`,
          'aria-expanded': state.sidebarOpen && state.sidebarPanel === 'extraction' },
          h('span', { className: `pac-extraction-dot ${extractionState}`, 'aria-hidden': true }),
          h('span', null, t('jobMemory')), h('span', { className: 'pac-extraction-state', role: 'status' }, t(extractionState))),
        h(Button, { size: 'sm', variant: 'toolbar',
          className: 'pac-icon-button pac-header-action', type: 'button',
          title: state.sidebarOpen && state.sidebarPanel === 'tasks' ? t('closeDashboard') : t('openDashboard'),
          'aria-label': state.sidebarOpen && state.sidebarPanel === 'tasks' ? t('closeDashboard') : t('openDashboard'),
          'aria-expanded': state.sidebarOpen && state.sidebarPanel === 'tasks', onClick: store.toggleSidebar
        }, h(Glyph, { name: 'checklist' })),
        h(Button, { size: 'sm', variant: 'toolbar',
          className: 'pac-icon-button pac-header-action', type: 'button',
          title: state.memoryOpen ? t('closeMemory') : t('openMemory'),
          'aria-label': state.memoryOpen ? t('closeMemory') : t('openMemory'),
          'aria-expanded': state.memoryOpen, onClick: store.toggleMemory
        }, h(Glyph, { name: 'memory' })));
    }

    function TaskGroup({ t, store, kind, tasks, expanded, locale }) {
      const active = kind === 'active';
      const title = active ? t('activeTasks') : t('completedTasks');
      const empty = active ? t('noActiveTasks') : t('noCompletedTasks');
      return h('section', { className: 'pac-task-group', 'data-kind': kind },
        h('button', { className: 'pac-group-toggle', type: 'button', 'aria-expanded': expanded, onClick: () => store.toggleGroup(kind) },
          h(Glyph, { name: 'chevron' }), h('span', null, title), h('span', { className: 'pac-group-count' }, tasks.length)),
        expanded ? (tasks.length
          ? h('ul', { className: 'pac-task-list' }, tasks.map(task => h('li', { key: task.id },
              h('button', { className: 'pac-task-button', type: 'button', onClick: () => store.selectTask(task.id) },
                h('span', { className: 'pac-task-title' }, taskTitle(task, t)),
                h('span', { className: 'pac-task-meta' }, formatDate(task.updatedAt || task.completedAt || task.createdAt, locale, task.state || ''))))))
          : h('p', { className: 'pac-empty' }, empty)) : null
      );
    }

    function DetailRow({ label, value }) {
      if (value === undefined || value === null || value === '') return null;
      return h('div', { className: 'pac-detail-row' }, h('dt', null, label), h('dd', null, String(value)));
    }

    function workerRows(detail) {
      return Array.isArray(detail?.workers) ? detail.workers : [];
    }

    function acceptanceRows(task) {
      return (Array.isArray(task?.acceptance) ? task.acceptance : []).map((criterion, index) => {
        const id = typeof criterion === 'string' ? String(index) : criterion.id;
        const result = task.verification?.results?.find(item => item.criterion_id === id);
        return { state: result?.state || 'pending', summary: typeof criterion === 'string' ? criterion : criterion.text };
      });
    }

    function TaskDetail({ state, store, t, locale }) {
      if (state.detailLoading) return h('div', null,
        h('div', { className: 'pac-detail-head' }, h(Button, { size: 'sm', variant: 'ghost', className: 'pac-icon-button', type: 'button', title: t('back'), 'aria-label': t('back'), onClick: store.closeTask }, h(Glyph, { name: 'back' })), h('h3', null, t('taskDetails'))),
        h('p', { className: 'pac-message' }, t('loading')));
      if (state.detailError) return h('div', null,
        h('div', { className: 'pac-detail-head' }, h(Button, { size: 'sm', variant: 'ghost', className: 'pac-icon-button', type: 'button', title: t('back'), 'aria-label': t('back'), onClick: store.closeTask }, h(Glyph, { name: 'back' })), h('h3', null, t('taskDetails'))),
        h('div', { className: 'pac-message error', role: 'alert' }, h('p', null, `${t('loadError')}: ${state.detailError}`), h(Button, { size: 'sm', variant: 'outline', className: 'pac-inline-button', type: 'button', onClick: () => store.selectTask(state.selectedTaskId) }, t('retry'))));
      const payload = state.detail || {};
      const task = payload.task || payload;
      const workers = workerRows(payload);
      const acceptance = acceptanceRows(task);
      return h('div', null,
        h('div', { className: 'pac-detail-head' }, h(Button, { size: 'sm', variant: 'ghost', className: 'pac-icon-button', type: 'button', title: t('back'), 'aria-label': t('back'), onClick: store.closeTask }, h(Glyph, { name: 'back' })), h('h3', null, t('taskDetails'))),
        h('h2', { className: 'pac-detail-title' }, taskTitle(task, t)),
        task.objective && task.objective !== task.title ? h('p', { className: 'pac-detail-copy' }, task.objective) : null,
        h('dl', { className: 'pac-detail-list' },
          h(DetailRow, { label: t('status'), value: task.state || task.status }),
          h(DetailRow, { label: t('createdAt'), value: formatDate(task.createdAt, locale) }),
          h(DetailRow, { label: t('updatedAt'), value: formatDate(task.updatedAt, locale) }),
          h(DetailRow, { label: t('completedAt'), value: formatDate(task.completedAt, locale) })),
        acceptance.length ? h('section', { className: 'pac-detail-section' }, h('h3', null, t('acceptance')),
          h('ul', { className: 'pac-worker-list' }, acceptance.map((item, index) => {
            const state = typeof item === 'object' ? item.state : null;
            const summary = typeof item === 'object' ? item.summary : item;
            return h('li', { className: 'pac-worker', key: index }, `${state === 'passed' ? t('passedAcceptance') : state === 'failed' ? t('failedAcceptance') : t('pendingAcceptance')}: ${summary || t('pendingAcceptance')}`);
          }))) : null,
        h('section', { className: 'pac-detail-section' }, h('h3', null, t('workers')),
          workers.length ? h('ul', { className: 'pac-worker-list' }, workers.map((worker, index) => {
            const key = worker.sessionId || worker.id || String(index);
            const label = worker.externalId || worker.sessionId || worker.id || `${t('session')} ${index + 1}`;
            return h('li', { className: 'pac-worker', key },
              h('div', { className: 'pac-worker-name' }, label),
              h('div', { className: 'pac-worker-meta' },
                worker.system ? h('span', null, `${t('system')}: ${worker.system}`) : null,
                worker.status ? h('span', null, `${t('status')}: ${worker.status}`) : null,
                worker.model ? h('span', null, `${t('model')}: ${worker.model}`) : null,
                worker.route ? h('span', null, `${t('route')}: ${worker.route}`) : null));
          })) : h('p', { className: 'pac-empty' }, t('noWorkers'))),
        null
      );
    }

    function useNativeRightbarWidth(open) {
      const ref = React.useRef(null);
      React.useLayoutEffect(() => {
        if (!open || !ref.current) return undefined;
        const element = ref.current;
        const frame = element.closest('[data-shell-overlay]')?.parentElement;
        if (!frame) return undefined;
        const sync = () => {
          const tracks = window.getComputedStyle(frame).gridTemplateColumns.match(/-?\d+(?:\.\d+)?px/g) || [];
          const width = Number.parseFloat(tracks[tracks.length - 1]);
          if (Number.isFinite(width) && width >= 300) element.style.width = `${width}px`;
          else element.style.removeProperty('width');
        };
        const mutation = typeof window.MutationObserver === 'function' ? new window.MutationObserver(sync) : null;
        const resize = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(sync) : null;
        mutation?.observe(frame, { attributes: true, attributeFilter: ['style'] });
        resize?.observe(frame);
        frame.addEventListener('transitionend', sync);
        const animationFrame = window.requestAnimationFrame(sync);
        sync();
        return () => {
          window.cancelAnimationFrame(animationFrame);
          mutation?.disconnect();
          resize?.disconnect();
          frame.removeEventListener('transitionend', sync);
        };
      }, [open]);
      return ref;
    }

    function Evaluation({ data, t, locale }) {
      if (!data) return null;
      const quality = data.quality;
      const format = value => Number.isFinite(value) ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value) : '—';
      return h('section', { className: 'pac-detail-section pac-evaluation', 'aria-label': t('evaluation') },
        h('h3', null, t('evaluation')),
        h('dl', { className: 'pac-detail-list' },
          h(DetailRow, { label: t('criterionRate'), value: quality.acceptancePassRate === null ? t('noSamples') : `${format(quality.acceptancePassRate * 100)}%` }),
          h(DetailRow, { label: t('passedAcceptance'), value: format(quality.passed) }),
          h(DetailRow, { label: t('pendingAcceptance'), value: format(quality.pending) }),
          h(DetailRow, { label: t('failedAcceptance'), value: format(quality.failed) }),
          h(DetailRow, { label: t('verifiedExecutions'), value: format(quality.verifiedExecutionCount) })),
        h('p', { className: 'pac-evaluation-note' }, t('evaluationScope')),
        (data.byWorker || []).map(worker => h('div', { className: 'pac-worker', key: worker.worker },
          h('span', null, worker.worker),
          h('p', { className: 'pac-evaluation-note' }, `${t('executionSamples')}: ${format(worker.count)} / ${format(worker.durationSamples)}`),
          h('p', { className: 'pac-evaluation-note' }, `${t('latency')}: ${format(worker.p50Ms === null ? null : worker.p50Ms / 1000)} / ${format(worker.p95Ms === null ? null : worker.p95Ms / 1000)}`))),
        h('details', null, h('summary', null, h(Glyph, { name: 'chevron' }), `${t('tokenReports')} (${data.usage.length})`),
          data.usage.slice(0, 20).map((item, index) => h('div', { className: 'pac-worker', key: index },
            h('p', { className: 'pac-worker-name' }, `${item.worker} · ${item.provider || ''} ${item.model || ''} · ${item.executionId}`),
            h('pre', null, JSON.stringify(item.usage, null, 2))))),
        h('p', { className: 'pac-evaluation-note' }, t('costUnavailable')));
    }

    function memoryExtractionState(data, error) {
      if (error) return 'extractionUnavailable';
      if (!data) return 'extractionLoading';
      if (data.running || data.runs?.some(run => run.state === 'running')) return 'extractionRunning';
      if (data.errors?.length || data.counts?.some(row=>row.state==='error'&&row.count>0)) return 'extractionAttention';
      if (!data.enabled) return 'extractionDisabled';
      if (data.counts?.some(row => row.state === 'pending' && row.count > 0)) return 'extractionQueued';
      return 'extractionIdle';
    }

    function ExtractionRecords({ ctx, state, store, t, locale }) {
      const data=state.extraction,currentState=memoryExtractionState(data,state.extractionError);
      const [rows,setRows]=React.useState(data?.runs||[]),[cursor,setCursor]=React.useState(data?.nextCursor??null),[expanded,setExpanded]=React.useState(false),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
      const request=React.useRef(null),initialized=React.useRef(false),action=React.useRef(null);
      React.useEffect(()=>()=>{request.current?.abort();action.current?.abort()},[]);
      React.useEffect(()=>{if(!data)return;if(!initialized.current){setRows(data.runs||[]);setCursor(data.nextCursor);initialized.current=true}},[data]);
      React.useEffect(()=>{if(!state.extractionRefresh)return;request.current?.abort();initialized.current=false;setRows([]);setCursor(null);setBusy(false)},[state.extractionRefresh]);
      const more=async()=>{
        if(!cursor||request.current)return;const controller=new AbortController();request.current=controller;setBusy(true);setError('');
        try{const response=await fetch('/api/personal-agent/memory/extraction?cursor='+encodeURIComponent(cursor),{credentials:'same-origin',cache:'no-store',signal:controller.signal});const next=await responseJson(response);if(controller.signal.aborted)return;setRows(current=>[...new Map([...current,...next.runs].map(row=>[row.id,row])).values()]);setCursor(next.nextCursor)}catch(failure){if(!controller.signal.aborted)setError(String(failure.message))}finally{if(request.current===controller)request.current=null;if(!controller.signal.aborted)setBusy(false)}
      };
      const operate=async name=>{if(action.current)return;const controller=new AbortController();action.current=controller;setBusy(true);setError('');try{await requestMemory('POST',{}, {action:name},controller.signal);if(!controller.signal.aborted)store.refreshExtraction()}catch(failure){if(!controller.signal.aborted)setError(String(failure.message))}finally{action.current=null;if(!controller.signal.aborted)setBusy(false)}};
      const openLog=run=>{try{ctx.uiWorkspace.openSession({parentSessionId:run.parentSessionId,childSessionId:run.sessionId,mode:'continuable'});store.closeSidebar()}catch(failure){setError(String(failure.message))}};
      const count=name=>data?.counts?.find(row=>row.state===name)?.count??0;
      return h(React.Fragment,null,
        h('section',{className:'pac-extraction-summary'},h('p',{className:'pac-extraction-current',role:'status'},t(currentState)),h('p',{className:'pac-evaluation-note'},`${t('extractionPending')}: ${count('pending')} · ${t('extractionFailed')}: ${count('error')}`),
          h('p',{className:'pac-evaluation-note'},t('historyCoverage')+': '+(data?.coverage?.sessionsPending??0)),
          h('div',{className:'pac-memory-actions'},h(Button,{size:'sm',variant:'outline',type:'button',disabled:busy||data?.running,onClick:()=>operate('retry-extraction')},t('memoryRetry')),h(Button,{size:'sm',variant:'primary',type:'button',disabled:busy||data?.running,onClick:()=>operate('run-extraction')},t('memoryRun'))),
          data?.nextRunAt?h('p',{className:'pac-evaluation-note'},t('nextRun')+': '+formatDate(data.nextRunAt,locale,'')):null),
        error||state.extractionError?h('p',{role:'alert',className:'pac-message error'},error||state.extractionError):null,
        data?.errors?.length?h('details',{className:'pac-extraction-queue-errors'},h('summary',null,h(Glyph,{name:'chevron'}),t('extractionQueueErrors')),data.errors.map((row,index)=>h('p',{key:index,className:'pac-extraction-error'},row.last_error))):null,
        h('details',{open:expanded,onToggle:event=>setExpanded(event.currentTarget.open)},h('summary',{className:'pac-extraction-heading'},h(Glyph,{name:'chevron'}),t('extractionRecent')+(data?.total===undefined?'':' · '+data.total)),
          h('div',{style:{maxHeight:'60vh',overflow:'auto'},onScroll:event=>{const element=event.currentTarget;if(expanded&&element.scrollHeight-element.scrollTop-element.clientHeight<100)void more()}},
            rows.length?h('ol',{className:'pac-extraction-runs'},rows.map(run=>h('li',{key:run.id,className:'pac-extraction-run'},h('div',{className:'pac-extraction-run-head'},h('span',null,t(`extractionRun_${run.state}`)),run.logAvailable?h(Button,{size:'sm',variant:'outline',type:'button',className:'pac-inline-button',onClick:()=>openLog(run)},t('extractionLog')):null),h('time',null,formatDate(run.startedAt,locale,'')),h('p',null,t('extractionInput')+': '+run.inputCount+(run.model?.model?' · '+run.model.model:'')),h('p',{className:'pac-extraction-error'},run.error)))):h('p',null,t('noFailures')),
            cursor?h(Button,{size:'sm',variant:'outline',type:'button',className:'pac-inline-button',disabled:busy,onClick:more},t('memoryLoadMore')):null)));
    }

    function TaskSidebar({ ctx, t, store }) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const sidebarRef = useNativeRightbarWidth(state.sidebarOpen);
      React.useEffect(() => state.sidebarOpen ? store.watchExtraction() : undefined, [state.sidebarOpen, store]);
      if (!state.sidebarOpen) return null;
      const locale = ctx.locale.getSnapshot().active || 'zh-CN';
      const extractionPanel = state.sidebarPanel === 'extraction';
      const activeTasks = Array.isArray(state.data?.tasks?.active) ? state.data.tasks.active : [];
      const completedTasks = Array.isArray(state.data?.tasks?.completed) ? state.data.tasks.completed : [];
      const connected = state.data?.codex?.connected === true;
      const capabilities = state.data?.workers || {};
      const capabilityRows = [[t('dshWorker'), capabilities.dsh], [t('codexWorker'), capabilities.codex]];
      return h('aside', { ref: sidebarRef, className: 'pac-sidebar', 'data-dsh-surface': 'details', 'aria-label': t(extractionPanel ? 'extractionRecords' : 'dashboard') },
        h('header', { className: 'pac-sidebar-header' },
          h('h2', null, t(extractionPanel ? 'extractionRecords' : 'dashboard')),
          !extractionPanel && h('span', { className: `pac-codex-dot${connected ? ' connected' : ''}`, title: connected ? t('connected') : t('disconnected'), role: 'img', 'aria-label': connected ? t('connected') : t('disconnected') }),
          h(Button, { size: 'sm', variant: 'ghost', className: 'pac-icon-button', type: 'button', disabled: state.refreshing, title: t('refresh'), 'aria-label': t('refresh'), onClick: extractionPanel ? store.refreshExtraction : store.refresh }, h(Glyph, { name: 'refresh', className: state.refreshing ? 'pac-spin' : '' })),
          h(Button, { size: 'sm', variant: 'ghost', className: 'pac-icon-button', type: 'button', title: t(extractionPanel ? 'extractionClose' : 'closeDashboard'), 'aria-label': t(extractionPanel ? 'extractionClose' : 'closeDashboard'), onClick: store.closeSidebar }, h(Glyph, { name: 'close' }))
        ),
        h('div', { className: 'pac-sidebar-body' }, extractionPanel ? h(ExtractionRecords, { ctx, state, store, t, locale }) : h(React.Fragment, null, h('section', { className: 'pac-capabilities' }, h('h3', null, t('workerCapabilities')),
          h('div', { className: 'pac-capability-list' }, capabilityRows.map(([label, capability]) => { const available = capability?.enabled && capability?.available !== false; return h('span', { className: 'pac-capability' + (available ? ' is-available' : ''), key: label }, `${label}: ${available ? t('available') : t('unavailable')}`); }))),
          state.selectedTaskId
          ? h(TaskDetail, { state, store, t, locale })
          : state.loading && !state.data ? h('p', { className: 'pac-message' }, t('loading'))
          : state.error && !state.data ? h('div', { className: 'pac-message error', role: 'alert' }, h('p', null, `${t('loadError')}: ${state.error}`), h(Button, { size: 'sm', variant: 'outline', className: 'pac-inline-button', type: 'button', onClick: store.refresh }, t('retry')))
          : h(React.Fragment, null,
              h(TaskGroup, { t, store, kind: 'active', tasks: activeTasks, expanded: state.activeExpanded, locale }),
              h(TaskGroup, { t, store, kind: 'completed', tasks: completedTasks, expanded: state.completedExpanded, locale }),
              h(Evaluation, { data: state.data?.evaluation, t, locale }),
              state.error ? h('p', { className: 'pac-message error', role: 'status' }, `${t('loadError')}: ${state.error}`) : null)))
      );
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sessions', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, 'zh-CN': zh, en }));
        const t = ctx.locale.bind(NS);
        const store = createStore(ctx);
        const host = createAssistantSessionHost(ctx, t);
        const settings = createSettingsController(t);
        const reset = createMainSessionResetController(host, t);
        ctx.effect(() => () => settings.dispose());
        ctx.effect(() => () => reset.dispose());
        ctx.effect(() => store.start());
        ctx.effect(() => () => host.dispose());
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-personal-agent-core', 'styles');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        });
        ctx.effect(() => installAssistantContextVisibility());
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: PANEL, order: 40, label: () => t('settingsNav'), locale: NS,
          inject: () => ({ t, ctx, settings, reset })
        }, SettingsSection));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL, locale: NS,
          children: { 'personal-agent-core.conversation': { kind: 'single', scope: 'session' } },
          inject: () => ({ host, t })
        }, AssistantMain));
        ctx.slots.inject('personal-agent-core.conversation', () => ctx.slots.register({
          name: 'personal-agent-core.conversation', locale: NS, inject: () => ({ store, t })
        }, AssistantConversation));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: `${PANEL}.memory`, locale: NS }, () => h(MemoryOverlay, { t, store })));
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: `${PANEL}.session-marker`, order: -100, inject: sessionId => ({ sessionId }) }, props => h(AssistantSessionMarker, { store, ...props })));
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: `${PANEL}.tasks`, order: 70, label: () => t('openDashboard'), locale: NS }, props => h(TaskHeaderAction, { store, t, ...props })));
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({ name: 'conversation.hero.options', id: `${PANEL}.tasks`, order: 70, locale: NS }, props => h(TaskHeaderAction, { store, t, ...props })));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: `${PANEL}.tasks`, locale: NS }, props => h(TaskSidebar, { ctx, t, store, ...props })));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 25, label: () => t('panel'), locale: NS }, props => h(Glyph, { name: 'panel', className: props?.className })));
      }
    };
  }
});
