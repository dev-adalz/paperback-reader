/* Page-turn animations. The real DOM already shows the destination; these
 * functions lay snapshot "faces" (cloned pages) on top and animate them away
 * so the reader sees a leaf of paper turn over the spine. */

const el = (cls, parent) => { const d = document.createElement('div'); d.className = cls; parent?.appendChild(d); return d; };

function place(face, slot, pageW) {
  face.style.left = `${slot * pageW}px`;
  face.style.top = '0px';
  return face;
}

export function animateTurn({ layer, mode, dir, spread, pageW, oldFaces, newFaces, blank, manual = false }) {
  let total = 0;
  const anims = [];
  const nodes = [];
  const add = (n) => { layer.appendChild(n); nodes.push(n); return n; };
  const run = (node, frames, opts) => { const a = node.animate(frames, { fill: 'both', ...opts }); anims.push(a); total = Math.max(total, opts.duration); return a; };

  if (mode === 'curl') {
    const dur = spread ? 760 : 620;
    const easing = 'cubic-bezier(.33,.02,.22,1)';
    const leaf = el('leaf');
    leaf.style.width = `${pageW}px`;
    let front; let back; let leafSlot; let underSlot; let revealSlot; let from; let to;
    if (spread) {
      if (dir > 0) {
        add(place(oldFaces[0], 0, pageW));
        front = oldFaces[1]; back = newFaces[0]; leafSlot = 1; revealSlot = 1; underSlot = 0;
        leaf.style.transformOrigin = 'left center'; from = 0; to = -180;
      } else {
        add(place(oldFaces[1], 1, pageW));
        front = oldFaces[0]; back = newFaces[1]; leafSlot = 0; revealSlot = 0; underSlot = 1;
        leaf.style.transformOrigin = 'right center'; from = 0; to = 180;
      }
    } else {
      leafSlot = 0; revealSlot = 0; underSlot = 0;
      leaf.style.transformOrigin = 'left center';
      if (dir > 0) { front = oldFaces[0]; back = blank; from = 0; to = -180; } else {
        add(place(oldFaces[0], 0, pageW));
        front = newFaces[0]; back = blank; from = -180; to = 0;
      }
    }
    place(leaf, leafSlot, pageW);
    front.style.left = '0px'; back.style.left = '0px';
    front.classList.add('leaf-front'); back.classList.add('leaf-back');
    leaf.append(front, back);
    const frontLit = el('lit lit-front', front);
    const backLit = el('lit lit-back', back);
    if (leaf.style.transformOrigin.startsWith('right')) { frontLit.classList.add('mirror'); backLit.classList.add('mirror'); }

    // shadow cast onto the page being revealed, and onto the page being covered
    const cast = add(el(`cast ${revealSlot === 1 || (!spread) ? 'from-left' : 'from-right'}`));
    place(cast, revealSlot, pageW); cast.style.width = `${pageW}px`;
    const cast2 = spread ? add(el(`cast ${underSlot === 0 ? 'from-right' : 'from-left'}`)) : null;
    if (cast2) { place(cast2, underSlot, pageW); cast2.style.width = `${pageW}px`; }
    add(leaf);

    const forwardish = !(dir < 0 && !spread);
    const tilt = (to < 0 ? -1 : 1) * 0.8;
    run(leaf, [
      { transform: `rotateY(${from}deg)` },
      { transform: `rotateY(${(from + to) / 2}deg) rotateZ(${tilt}deg) scale(1.01)`, offset: 0.5 },
      { transform: `rotateY(${to}deg)` },
    ], { duration: dur, easing });
    run(frontLit, forwardish ? [{ opacity: 0 }, { opacity: 0.75, offset: 0.5 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0.75, offset: 0.5 }, { opacity: 0 }], { duration: dur, easing });
    run(backLit, forwardish ? [{ opacity: 1 }, { opacity: 0.6, offset: 0.5 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 0.6, offset: 0.5 }, { opacity: 1 }], { duration: dur, easing });
    run(cast, forwardish ? [{ opacity: 0.0 }, { opacity: 0.9, offset: 0.25 }, { opacity: 0.35, offset: 0.55 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 0.6, offset: 0.6 }, { opacity: 0.9, offset: 0.85 }, { opacity: 0 }], { duration: dur, easing });
    if (cast2) run(cast2, [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 0.85, offset: 0.8 }, { opacity: 0 }], { duration: dur, easing });
    if (!spread && dir > 0) run(leaf, [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: dur, easing: 'linear' });
    if (!spread && dir < 0) run(leaf, [{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 1 }], { duration: dur, easing: 'linear' });
  } else if (mode === 'slide') {
    const dur = 380;
    const group = (faces) => { const g = el('slide-group'); faces.forEach((f, i) => g.appendChild(place(f, i, pageW))); return g; };
    if (dir > 0) {
      const g = add(group(oldFaces));
      run(g, [{ transform: 'translateX(0)' }, { transform: `translateX(-${(spread ? 2 : 1) * pageW + 40}px)` }], { duration: dur, easing: 'cubic-bezier(.4,0,.2,1)' });
    } else {
      add(group(oldFaces));
      const g = add(group(newFaces));
      run(g, [{ transform: `translateX(-${(spread ? 2 : 1) * pageW + 40}px)` }, { transform: 'translateX(0)' }], { duration: dur, easing: 'cubic-bezier(.4,0,.2,1)' });
    }
  } else if (mode === 'eink') {
    // e-ink full refresh: black flash, white flash, then a faint ghost of the old page
    const flash = add(el('eink-flash'));
    flash.style.width = `${(spread ? 2 : 1) * pageW}px`;
    run(flash, [
      { background: 'var(--ink)', opacity: 1 }, { background: 'var(--ink)', opacity: 1, offset: 0.35 },
      { background: 'var(--paper)', opacity: 1, offset: 0.45 }, { background: 'var(--paper)', opacity: 1, offset: 0.7 },
      { background: 'var(--paper)', opacity: 0 },
    ], { duration: 300, easing: 'steps(6, end)' });
    const ghost = el('ghost');
    oldFaces.forEach((f, i) => ghost.appendChild(place(f, i, pageW)));
    add(ghost);
    run(ghost, [{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 0.07, offset: 0.35 }, { opacity: 0 }], { duration: 1100, easing: 'linear' });
  }

  const cleanup = () => nodes.forEach((n) => n.remove());
  if (manual) {
    // drag-controlled: caller scrubs progress, then plays forward or back
    anims.forEach((a) => a.pause());
    const done = () => Promise.all(anims.map((a) => a.finished.catch(() => {})));
    return {
      setProgress(p) { anims.forEach((a) => { a.currentTime = Math.max(0, Math.min(1, p)) * total; }); },
      play(rate = 1.6) { anims.forEach((a) => { a.playbackRate = rate; a.play(); }); return done(); },
      reverse(rate = 1.8) { anims.forEach((a) => { a.playbackRate = -rate; a.play(); }); return done(); },
      cleanup,
    };
  }
  const finished = Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(cleanup);
  return { finished, finish: () => anims.forEach((a) => { try { a.finish(); } catch { /* ignore */ } }) };
}
