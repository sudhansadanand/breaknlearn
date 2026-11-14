/**
 * Student TV app — a faithful port of the inline script in
 * legacy/live-snapshot-2026-11-14/index.html. Markup, strings, timings, keys and storage writes are
 * the same as the live app; differences are limited to:
 *  - content comes from `paired.catalog()` (identical built-in ×1–×10 unless paired mode is on);
 *  - persisting never drops profiles the live filter hides (F1);
 *  - paired-mode hooks and the "Family account" screens, shown only when the server enables them.
 */
import { AVATARS, SUBJECTS, findWorld, type StudentCatalog, type TableLesson, type World } from "./catalog";
import { loadProfiles, persistProfiles, type LessonEntry, type LoadedProfiles, type LocalProfile } from "./legacy";
import type { LessonContext, Paired } from "./paired";
import { without, type KeyValueStore } from "./util";

export interface AppDeps {
  root: HTMLElement;
  music: HTMLAudioElement;
  store: KeyValueStore;
  paired: Paired;
  doc: Document;
  win: Window;
}

export function startApp(deps: AppDeps): void {
  const app = deps.root,
    music = deps.music,
    paired = deps.paired,
    doc = deps.doc;
  const avatars = AVATARS;
  const subjects = SUBJECTS;
  const loaded: LoadedProfiles = loadProfiles(deps.store);
  const state = loaded.state;
  let screen = "profiles",
    editSlot = 0,
    draft: { name: string; grade: number; avatar: string } = { name: "", grade: 2, avatar: avatars[0] },
    subject = "",
    world: World = findWorld("puppy"),
    factor = 3,
    fact = 1,
    elapsed = 0,
    paused = false,
    ticker: number | null = null,
    controls = false,
    controlTimer: number | null = null,
    q = 0,
    quizNums: number[] = [],
    options: number[] = [],
    picked = -1,
    score = 0,
    lastTick = Date.now(),
    linkDraft: { profiles: { [k: string]: string }; historical: string | null } | null = null;

  function catalog(): StudentCatalog {
    return paired.catalog();
  }
  function lessonFor(f: number): TableLesson | null {
    const ts = catalog().tables;
    for (let i = 0; i < ts.length; i++) if (ts[i].table === f) return ts[i];
    return null;
  }
  function lesson(): TableLesson {
    return lessonFor(factor) || { table: factor, lessonId: "", versionId: null, versionNo: null, stableKey: "", worlds: ["puppy", "candy", "unicorn", "school", "treat", "farm"], secondsPerSlide: 7, quizCount: 3 };
  }
  function lessonWorlds(f: number): World[] {
    const l = lessonFor(f);
    const ids = l ? l.worlds : [];
    const out: World[] = [];
    for (let i = 0; i < ids.length; i++) out.push(findWorld(ids[i]));
    return out;
  }
  function sps(): number {
    return lesson().secondsPerSlide;
  }
  function ctx(): LessonContext | null {
    const p = active();
    return p ? { profile: p, lesson: lesson(), worldId: world.id } : null;
  }
  function hook(fn: (c: LessonContext) => void) {
    const c = ctx();
    if (!c) return;
    try {
      fn(c);
    } catch {
      /* paired-mode failures never affect playback */
    }
  }

  function persist() {
    persistProfiles(deps.store, loaded);
  }
  function active(): LocalProfile | null {
    for (let i = 0; i < state.profiles.length; i++) {
      const x = state.profiles[i];
      if (x && x.id === state.activeId) return x;
    }
    return null;
  }
  function keyFor(w: World, f: number) {
    return "times-" + f + ":" + w.id;
  }
  function progress(): { [k: string]: LessonEntry } | null {
    const p = active();
    if (!p) return null;
    if (!p.lessons) p.lessons = {};
    return p.lessons;
  }
  function entry(w: World, f: number): LessonEntry | null {
    const pr = progress();
    if (!pr) return null;
    const k = keyFor(w, f);
    if (pr[k]) return pr[k];
    if (f === 3 && pr[w.id]) return pr[w.id];
    return null;
  }
  function number(e: LessonEntry | null): number {
    const n = e ? parseInt(String(e.slideId || "three-1").replace(/^[^0-9]*/, ""), 10) : 1;
    return n >= 1 && n <= 10 ? n : 1;
  }
  function save(completed?: boolean) {
    const pr = progress();
    if (!pr) return;
    const position = Math.max(0, Math.min(sps(), elapsed));
    pr[keyFor(world, factor)] = { topicId: "multiplication-" + factor, table: factor, slideId: "step-" + fact, position: position, complete: completed === true, updatedAt: Date.now() };
    const p = active() as LocalProfile;
    p.lastWorld = world.id;
    p.lastTable = factor;
    persist();
    hook(function (c) {
      paired.progressSaved(c, fact, position, completed === true);
    });
  }
  function recent(f: number): { id: string; e: LessonEntry } | null {
    const pr = progress();
    if (!pr) return null;
    const p = active(),
      w = p && p.lastWorld && findWorldIn(f, findWorld(p.lastWorld).id),
      e = w && entry(w, f);
    if (w && e && !e.complete && p.lastTable === f) return { id: w.id, e: e };
    let best: { id: string; e: LessonEntry } | null = null;
    const ws = lessonWorlds(f);
    for (let i = 0; i < ws.length; i++) {
      const x = ws[i],
        v = entry(x, f);
      if (v && !v.complete && (!best || Number(v.updatedAt) > Number(best.e.updatedAt))) best = { id: x.id, e: v };
    }
    return best;
  }
  function findWorldIn(f: number, id: string): World | null {
    const ws = lessonWorlds(f);
    for (let i = 0; i < ws.length; i++) if (ws[i].id === id) return ws[i];
    return null;
  }
  function stop() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }
  function playMusic() {
    const p = active();
    if (p && p.musicEnabled !== false) {
      music.volume = 0.35;
      try {
        const a = music.play() as unknown as { catch?: (f: () => void) => void } | undefined;
        if (a && a.catch) a.catch(function () {});
      } catch {
        /* autoplay blocked: lesson continues silently (TV-004) */
      }
    }
  }
  function toggleMusic() {
    const p = active();
    if (!p) return;
    p.musicEnabled = p.musicEnabled === false;
    persist();
    if (p.musicEnabled) playMusic();
    else music.pause();
    render();
  }
  function esc(x: unknown) {
    return String(x).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as { [k: string]: string })[c];
    });
  }
  function btn(t: string, a: string, c?: string) {
    return '<button type="button" class="' + (c || "secondary") + '" data-act="' + a + '">' + t + "</button>";
  }
  function brand(mini: boolean) {
    return '<img class="' + (mini ? "mini-logo" : "brand") + '" src="/logo.webp" alt="BreakNLearn mascot logo">';
  }
  function header() {
    return '<header class="mast">' + brand(false) + '<span class="tagline">Little breaks. Big discoveries.</span></header>';
  }
  function back(label: string) {
    return '<div class="backrow">' + btn("← Back", "back") + '<span class="crumb">' + esc(label) + "</span></div>";
  }
  function tile(title: string, icon: string, action: string, subtitle: string, color: string, stub: boolean, extra?: string) {
    return '<button class="tile ' + (stub ? "stub " : "") + (extra || "") + '" style="--accent:' + color + '" data-act="' + action + '"><span><h3>' + esc(title) + '</h3><span class="sub">' + esc(subtitle || "") + '</span></span><span class="ico">' + icon + "</span></button>";
  }
  function profileSelect(i: number) {
    const p = state.profiles[i];
    if (!p) return;
    state.activeId = p.id;
    persist();
    try {
      paired.profileSelected(p);
    } catch {
      /* ignore */
    }
    screen = "subjects";
    render();
  }
  function editProfile(i: number) {
    editSlot = i;
    const p = state.profiles[i];
    draft = p ? { name: p.name, grade: p.grade, avatar: p.avatar } : { name: "", grade: i === 0 ? 2 : 6, avatar: avatars[i] };
    screen = "edit";
    render();
  }
  function saveProfile() {
    const field = doc.getElementById("childName") as HTMLInputElement | null;
    draft.name = field ? field.value.trim().slice(0, 30) : draft.name;
    if (!draft.name) {
      if (field) {
        field.setAttribute("aria-invalid", "true");
        field.focus();
      }
      return;
    }
    let p = state.profiles[editSlot];
    if (!p) {
      p = { id: "child-" + (editSlot + 1), lessons: {}, lastWorld: null, lastTable: 3, musicEnabled: true } as unknown as LocalProfile;
      state.profiles[editSlot] = p;
    }
    p.name = draft.name;
    p.grade = draft.grade;
    p.avatar = draft.avatar;
    state.activeId = p.id;
    persist();
    screen = "subjects";
    render();
  }
  function launch(wid: string, restart: boolean) {
    stop();
    world = findWorldIn(factor, wid) || lessonWorlds(factor)[0] || findWorld(wid);
    const e = restart ? null : entry(world, factor);
    const prior = entry(world, factor);
    fact = e && !e.complete ? number(e) : 1;
    elapsed = e && !e.complete ? Math.max(0, Math.min(sps() - 1, Number(e.position) || 0)) : 0;
    paused = false;
    screen = "lesson";
    hook(function (c) {
      paired.lessonStarted(c, restart, !!(prior && prior.complete));
    });
    save(false);
    render();
    playMusic();
    startTick();
    hook(function (c) {
      paired.slideEntered(c, fact);
    });
  }
  function startTick() {
    stop();
    lastTick = Date.now();
    ticker = setInterval(function () {
      if (screen !== "lesson" || paused) return;
      const now = Date.now(),
        d = Math.min(1.3, (now - lastTick) / 1000);
      lastTick = now;
      elapsed += d;
      hook(function (c) {
        paired.tick(c, fact, d * 1000);
      });
      if (elapsed >= sps()) {
        elapsed = 0;
        if (fact >= 10) {
          stop();
          save(true);
          beginQuiz();
          return;
        }
        fact++;
        save(false);
        render();
        hook(function (c) {
          paired.slideEntered(c, fact);
        });
      } else {
        const x = doc.getElementById("seconds");
        if (x) x.textContent = String(Math.max(1, Math.ceil(sps() - elapsed)));
      }
    }, 300) as unknown as number;
  }
  function reveal() {
    controls = true;
    const x = doc.getElementById("controls");
    if (x) x.classList.add("shown");
    if (controlTimer) clearTimeout(controlTimer);
    controlTimer = setTimeout(function () {
      const ae = doc.activeElement as (Element & { closest?: (s: string) => Element | null }) | null;
      if (screen === "lesson" && !paused && !(ae && ae.closest && ae.closest("#controls"))) {
        controls = false;
        const y = doc.getElementById("controls");
        if (y) y.classList.remove("shown");
      }
    }, 5200) as unknown as number;
  }
  function pause() {
    paused = !paused;
    save(false);
    if (!paused) {
      lastTick = Date.now();
      if (!ticker) startTick();
    }
    hook(function (c) {
      paired.pauseChanged(c, fact, paused);
    });
    render();
    reveal();
  }
  function shift(d: number) {
    const before = fact;
    fact = Math.max(1, Math.min(10, fact + d));
    elapsed = 0;
    save(false);
    render();
    reveal();
    if (fact !== before)
      hook(function (c) {
        paired.slideEntered(c, fact);
      });
  }
  function shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)),
        v = a[i];
      a[i] = a[j];
      a[j] = v;
    }
    return a;
  }
  function makeOptions() {
    const n = quizNums[q],
      correct = n * factor,
      o = [correct],
      ds = shuffle([-factor * 3, -factor * 2, -factor, factor, factor * 2, factor * 3, 1, -1]);
    for (let i = 0; i < ds.length && o.length < 4; i++) {
      const v = correct + ds[i];
      if (v > 0 && o.indexOf(v) < 0) o.push(v);
    }
    for (let z = 1; o.length < 4; z++) if (o.indexOf(correct + z) < 0) o.push(correct + z);
    options = shuffle(o);
  }
  function quizCount() {
    return lesson().quizCount;
  }
  function beginQuiz() {
    stop();
    hook(function (c) {
      paired.lessonLeft(c, fact);
    });
    screen = "quiz";
    quizNums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).slice(0, quizCount());
    q = 0;
    picked = -1;
    score = 0;
    makeOptions();
    render();
    hook(function (c) {
      paired.quizStarted(c);
    });
  }
  function groups(n: number) {
    let s = "";
    const em = world.icon;
    for (let i = 0; i < n; i++) s += '<span class="group' + (factor >= 7 ? " dense" : "") + '">' + new Array(factor + 1).join(em) + "</span>";
    return s;
  }
  function leave(view: string) {
    if (screen === "lesson") {
      save(false);
      hook(function (c) {
        paired.lessonLeft(c, fact);
      });
    }
    stop();
    if (screen === "pair" && view !== "pair") paired.cancelPairing();
    screen = view;
    controls = false;
    render();
  }
  const COUNT_WORDS = ["ones", "twos", "threes", "fours", "fives", "sixes", "sevens", "eights", "nines", "tens"];

  function familyScreens(): string {
    const pv = paired.pairing();
    let h = "";
    if (screen === "family") {
      h = header() + back("Family account") + '<div class="panel"><div class="eyebrow">FOR GROWN-UPS</div>';
      if (!paired.isPaired()) {
        h += "<h1>Connect this TV</h1><p>Learning works without connecting. Connecting lets a grown-up follow progress in the family account.</p>" + '<div class="actions">' + btn("Show pairing code", "pair-start", "primary") + btn("← All Explorers", "profiles") + "</div>";
      } else {
        const n = paired.pendingUploads();
        const imp = paired.lastImport();
        h += "<h1>This TV is connected ✓</h1><p>Progress is saved on this TV and sent to the family account when the internet is available.</p>";
        h += '<p class="notice">' + (n > 0 ? n + " update" + (n === 1 ? "" : "s") + " waiting to send" : "Everything is sent") + "</p>";
        if (imp) h += '<p class="notice">' + (imp.status === "done" ? "Saved progress from this TV was added to the family account." : imp.status === "pending" ? "Saved progress will be sent when online." : "Saved progress could not be added. It is still kept on this TV.") + "</p>";
        h += '<div class="actions">' + btn("Link explorers", "link", "primary") + btn("Disconnect this TV", "unpair") + btn("← All Explorers", "profiles") + "</div>";
      }
      h += "</div>";
    } else if (screen === "pair") {
      h = header() + back("Family account") + '<div class="panel center"><div class="eyebrow">CONNECT THIS TV</div>';
      if (pv.state === "loading" || pv.state === "idle") h += "<h1>Getting a code…</h1>";
      else if (pv.state === "code") h += '<h1>Your TV code</h1><div class="formula" id="pairing-code">' + esc(pv.code || "") + "</div><p>On a phone or computer, open the family account, choose “Pair a TV” and enter this code.</p><p class=\"hint\">The code works for 10 minutes.</p>";
      else if (pv.state === "expired") h += "<h1>This code has expired</h1><p>Get a new code to try again.</p>" + btn("Get a new code", "pair-start", "primary");
      else if (pv.state === "offline") h += "<h1>We can’t reach the family account</h1><p>Keep learning! You can connect later.</p>" + btn("Try again", "pair-start", "primary");
      else if (pv.state === "paired") h += "<h1>Connected ✓</h1>" + btn("Link explorers", "link", "primary");
      h += "</div>";
    } else if (screen === "link") {
      const servers = paired.serverProfiles();
      h = header() + back("Family account") + '<div class="panel"><div class="eyebrow">FOR GROWN-UPS</div><h1>Link explorers</h1>';
      if (!servers) {
        h += "<p>We couldn’t load explorers from the family account. Try again later.</p>" + btn("Try again", "link", "primary");
      } else {
        if (!linkDraft) linkDraft = { profiles: copy(paired.links().profiles), historical: paired.links().historical };
        h += "<p>Choose which explorers on this TV belong to the family account.</p>";
        for (let i = 0; i < state.profiles.length; i++) {
          const lp = state.profiles[i];
          if (!lp) continue;
          const match = serverForLocal(lp.id, i);
          h += '<div class="resume"><div><h3>' + lp.avatar + " " + esc(lp.name) + "</h3><p>" + (match ? "Family account: " + esc(match.display_name) : "No matching explorer in the family account yet") + "</p></div>" + (match ? btn(linkDraft.profiles[lp.id] === match.id ? "✓ Linked" : "Link", "link-toggle:" + i, "choice" + (linkDraft.profiles[lp.id] === match.id ? " selected" : "")) : "") + "</div>";
        }
        if (paired.historicalCount() > 0 && servers.length > 0) {
          h += "<h3>Older ×3 progress was found on this TV</h3><p>Who did it belong to?</p><div class=\"choices\">";
          for (let s = 0; s < servers.length; s++) h += btn(esc(servers[s].display_name), "hist:" + s, "choice" + (linkDraft.historical === servers[s].id ? " selected" : ""));
          h += btn("Keep on this TV only", "hist:none", "choice" + (linkDraft.historical === null ? " selected" : "")) + "</div>";
        }
        h += '<div class="actions">' + btn("✓ Save", "link-save", "primary") + btn("Not now", "family") + "</div>";
      }
      h += "</div>";
    }
    return h;
  }
  function copy(o: { [k: string]: string }) {
    const r: { [k: string]: string } = {};
    for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
    return r;
  }
  function serverForLocal(localId: string, index: number) {
    const servers = paired.serverProfiles() || [];
    const m = /^child-([12])$/.exec(localId);
    const slot = m ? Number(m[1]) : index + 1;
    for (let i = 0; i < servers.length; i++) if (servers[i].slot === slot) return servers[i];
    return null;
  }

  function render() {
    let h = "",
      i: number,
      t: string[] | World,
      e: LessonEntry | null;
    const p = active() as LocalProfile; // screens past "subjects" always have an active profile (as live)
    if (screen === "profiles") {
      h = header() + '<div class="eyebrow">WHO’S LEARNING TODAY?</div><h1>Choose your explorer!</h1><p>Two explorers. Two learning adventures.</p><div class="profiles">';
      for (i = 0; i < 2; i++) {
        const pr = state.profiles[i];
        h += pr ? '<button class="profile" data-act="profile:' + i + '"><span class="face">' + pr.avatar + "</span><strong>" + esc(pr.name) + '</strong><span class="detail">Grade ' + pr.grade + " · Start learning</span></button>" : '<button class="profile empty" data-act="edit:' + i + '"><span class="face">➕</span><strong>Add Explorer ' + (i + 1) + '</strong><span class="detail">Name · Grade · Avatar</span></button>';
      }
      h += '</div><div class="footer">Use your TV remote to choose a profile.</div>';
      if (paired.enabled()) h += '<div class="actions">' + btn(paired.isPaired() ? "📺 Family account ✓" : "📺 Family account", "family") + "</div>";
    } else if (screen === "edit") {
      h = header() + back("Explorer " + (editSlot + 1)) + '<div class="panel"><div class="eyebrow">YOUR LEARNING PROFILE</div><h1>Make it yours!</h1><div class="field"><label for="childName">Your name</label><input id="childName" maxlength="30" autocomplete="off" placeholder="Type your name" value="' + esc(draft.name) + '"></div><h3 style="margin-top:25px">Choose your grade</h3><div class="choices">' + btn("Grade 2", "grade:2", "choice" + (draft.grade === 2 ? " selected" : "")) + btn("Grade 6", "grade:6", "choice" + (draft.grade === 6 ? " selected" : "")) + '</div><h3>Choose an awesome avatar</h3><div class="avatars">';
      for (i = 0; i < avatars.length; i++) h += btn(avatars[i], "avatar:" + i, "choice" + (avatars[i] === draft.avatar ? " selected" : ""));
      h += '</div><div class="actions">' + btn("✓ Save Explorer", "save-profile", "primary") + btn("Cancel", "profiles") + "</div></div>";
    } else if (screen === "subjects") {
      if (!active()) {
        screen = "profiles";
        render();
        return;
      }
      h = header() + '<div class="backrow"><div class="eyebrow">' + p.avatar + " " + esc(p.name) + " · GRADE " + p.grade + "</div>" + btn("⇄ Switch Profile", "profiles") + '</div><h1>What shall we explore?</h1><p>Pick a subject and begin your next discovery.</p><div class="grid">';
      const list = subjects[p.grade];
      for (i = 0; i < list.length; i++) {
        t = list[i];
        const live = p.grade === 2 && t[0] === "Math" && catalog().mathPlayable;
        h += tile(t[0], t[1], "subject:" + encodeURIComponent(t[0]), live ? "Multiplication Tables available" : "Coming soon", ["#5334a3", "#27799c", "#8a4189", "#664399", "#357b65", "#8b6131"][i % 6], !live);
      }
      h += '</div><div class="actions">' + btn("✎ Edit My Profile", "edit-current") + "</div>";
    } else if (screen === "topics") {
      h = header() + back("Grade 2 · Math") + '<div class="eyebrow">MATH ADVENTURES</div><h1>Choose a topic</h1><div class="grid">' + tile("Multiplication Tables", "✖️", "multiplication", "Tables 1 to 10 · Visual lessons", "#5b38b1", false) + "</div>";
    } else if (screen === "tables") {
      h = header() + back("Math · Multiplication Tables") + '<div class="eyebrow">MULTIPLICATION TABLES</div><h1>Choose a table!</h1><p>Explore tables 1 through 10 with pictures, music and quizzes.</p><div class="grid">';
      const ts = catalog().tables;
      for (let n = 0; n < ts.length; n++) {
        i = ts[n].table;
        const ws = lessonWorlds(i);
        let done = 0;
        for (let j = 0; j < ws.length; j++) {
          e = entry(ws[j], i);
          if (e && e.complete) done++;
        }
        h += tile(i + " Times Table", "×" + i, "table:" + i, done === ws.length ? (ws.length === 6 ? "★ All six themes complete" : "★ All themes complete") : done + " of " + ws.length + " worlds complete", ["#5440a7", "#326b9e", "#7541a0", "#7b4c8b", "#417b87"][i % 5], false, "table-card");
      }
      h += "</div>";
    } else if (screen === "themes") {
      h = header() + back("Grade 2 · Math · " + factor + " Times Table") + '<div class="eyebrow">LEARNING WORLDS</div><h1>Pick a world for ×' + factor + "!</h1><p>Each picture shows groups of " + factor + ". Count them as the slides play.</p>";
      const r = recent(factor);
      if (r) {
        const wr = findWorld(r.id);
        h += '<div class="resume"><div><div class="eyebrow">PICK UP WHERE YOU LEFT OFF</div><h3>' + wr.icon + " " + wr.name + " · ×" + factor + "</h3><p>Slide " + number(r.e) + ' of 10</p><div class="progress"><div style="width:' + (number(r.e) - 1) * 10 + '%"></div></div></div>' + btn("▶ Continue Learning", "continue", "primary") + "</div>";
      }
      h += '<div class="grid">';
      const ws = lessonWorlds(factor);
      for (i = 0; i < ws.length; i++) {
        const w = ws[i];
        e = entry(w, factor);
        h += tile(w.name, w.icon, "world:" + w.id, e ? (e.complete ? "★ Completed · Replay" : "↻ Resume at " + factor + " × " + number(e)) : "10 visual slides", w.color, false);
      }
      h += "</div>";
    } else if (screen === "stub") {
      h = header() + back("Grade " + p.grade + " · " + subject) + '<div class="panel center"><div style="font-size:95px">🚀</div><div class="eyebrow">' + esc(subject.toUpperCase()) + "</div><h1>Coming soon!</h1><p>New adventures in " + esc(subject) + " are on their way.</p>" + btn("← All Subjects", "subjects", "primary") + "</div>";
    } else if (screen === "lesson") {
      h = '<div class="lesson-top">' + brand(true) + '<span class="crumb">' + esc(p.name) + " · ×" + factor + " · " + world.name + " · Slide " + fact + ' / 10</span></div><div class="progress"><div style="width:' + (fact - 1) * 10 + '%"></div></div><div class="presentation"><div class="objects" aria-label="' + fact + " groups of " + factor + " " + world.plural + '">' + groups(fact) + '</div><div><div class="eyebrow">COUNT WITH ME!</div><h1>Count in ' + COUNT_WORDS[factor - 1] + '!</h1><div class="formula">' + factor + " × " + fact + " = " + factor * fact + "</div><p>" + fact + " group" + (fact === 1 ? "" : "s") + " of " + factor + " " + world.plural + '</p><p class="hint">' + (paused ? "Paused" : 'Next picture in <strong id="seconds">' + Math.max(1, Math.ceil(sps() - elapsed)) + "</strong> seconds") + '</p></div></div><div id="controls" class="overlay' + (controls || paused ? " shown" : "") + '">' + btn(paused ? "▶ Resume" : "⏸ Pause", "pause", "primary") + btn("← Previous", "prev") + btn("Next →", "next") + btn("🏠 Themes", "themes") + btn("↺ Restart", "restart") + btn(p.musicEnabled === false ? "♪ Music Off" : "♫ Music On", "music") + btn("Quiz", "quiz") + "</div>";
    } else if (screen === "quiz") {
      const n = quizNums[q],
        qc = quizCount();
      h = '<div class="lesson-top">' + brand(true) + '<span class="crumb">' + esc(p.name) + " · ×" + factor + " Quiz " + (q + 1) + " / " + qc + '</span></div><div class="presentation"><div class="objects">' + groups(n) + '</div><div><div class="eyebrow">PICTURE QUIZ</div><h1>How many ' + world.plural + '?</h1><div class="quiz-answers">';
      for (i = 0; i < options.length; i++) h += "<button " + (picked >= 0 ? "disabled " : "") + 'data-act="answer:' + i + '" class="' + (picked >= 0 ? (options[i] === n * factor ? "correct" : i === picked ? "wrong" : "") : "") + '">' + options[i] + "</button>";
      h += "</div>";
      if (picked >= 0) h += "<p>" + (options[picked] === n * factor ? "⭐ Amazing!" : "🌟 Good try!") + " " + factor + " × " + n + " = " + factor * n + "</p>" + btn(q === qc - 1 ? "See your stars" : "Next Question →", "nextq", "primary");
      h += '</div></div><div class="actions">' + btn("← Themes", "themes") + "</div>";
    } else if (screen === "complete") {
      h = '<div class="center panel"><img src="/logo.webp" class="mascot" alt="BreakNLearn mascot"><div class="eyebrow">WONDERFUL DISCOVERY!</div><h1>You did it, ' + esc(p.name) + "! ✨</h1><p>Math · " + factor + " times table · " + score + " / " + quizCount() + ' quiz stars</p><div class="actions" style="justify-content:center">' + btn("Play Again", "restart", "primary") + btn("Another World", "themes") + btn("Other Tables", "tables") + "</div></div>";
    } else if (screen === "family" || screen === "pair" || screen === "link") {
      h = familyScreens();
    }
    app.innerHTML = h;
    const bs = app.querySelectorAll("[data-act]");
    for (i = 0; i < bs.length; i++)
      (bs[i] as HTMLElement).onclick = function (this: GlobalEventHandlers) {
        const x = (this as unknown as HTMLElement).getAttribute("data-act") || "";
        if (x !== "profiles" && x !== "back") playMusic();
        action(x);
      };
  }
  function action(x: string) {
    if (x === "profiles") leave("profiles");
    else if (x.indexOf("profile:") === 0) profileSelect(+x.split(":")[1]);
    else if (x.indexOf("edit:") === 0) editProfile(+x.split(":")[1]);
    else if (x === "edit-current") editProfile(state.profiles.indexOf(active() as unknown as LocalProfile));
    else if (x === "save-profile") saveProfile();
    else if (x.indexOf("grade:") === 0) {
      const inp = doc.getElementById("childName") as HTMLInputElement | null;
      if (inp) draft.name = inp.value;
      draft.grade = +x.split(":")[1];
      render();
    } else if (x.indexOf("avatar:") === 0) {
      const inpt = doc.getElementById("childName") as HTMLInputElement | null;
      if (inpt) draft.name = inpt.value;
      draft.avatar = avatars[+x.split(":")[1]];
      render();
    } else if (x.indexOf("subject:") === 0) {
      subject = decodeURIComponent(x.slice(8));
      screen = (active() as LocalProfile).grade === 2 && subject === "Math" && catalog().mathPlayable ? "topics" : "stub";
      render();
    } else if (x === "multiplication") {
      screen = "tables";
      render();
    } else if (x.indexOf("table:") === 0) {
      factor = +x.slice(6);
      if (factor < 1 || factor > 10) factor = 3;
      leave(lessonFor(factor) ? "themes" : "tables");
    } else if (x === "themes") leave("themes");
    else if (x === "tables") leave("tables");
    else if (x.indexOf("world:") === 0) launch(x.slice(6), false);
    else if (x === "continue") {
      const r = recent(factor);
      if (r) launch(r.id, false);
    } else if (x === "pause") pause();
    else if (x === "prev") shift(-1);
    else if (x === "next") shift(1);
    else if (x === "restart") launch(world.id, true);
    else if (x === "music") toggleMusic();
    else if (x === "quiz") beginQuiz(); else if (x.indexOf("answer:") === 0 && picked < 0) {
      picked = +x.split(":")[1];
      if (options[picked] === quizNums[q] * factor) score++;
      const val = options[picked],
        mult = quizNums[q];
      hook(function (c) {
        paired.answered(c, mult, val);
      });
      render();
    } else if (x === "nextq") {
      q++;
      if (q >= quizCount()) {
        screen = "complete";
        hook(function (c) {
          paired.quizCompleted(c);
        });
        render();
      } else {
        picked = -1;
        makeOptions();
        render();
      }
    } else if (x === "subjects") leave("subjects");
    else if (x === "family") {
      linkDraft = null;
      leave("family");
    } else if (x === "pair-start") {
      paired.startPairing();
      leave("pair");
    } else if (x === "link") {
      linkDraft = null;
      paired.loadServerProfiles(function () {
        if (screen === "link") render();
      });
      leave("link");
    } else if (x.indexOf("link-toggle:") === 0 && linkDraft) {
      const lp = state.profiles[+x.split(":")[1]];
      const m = lp ? serverForLocal(lp.id, +x.split(":")[1]) : null;
      if (lp && m) {
        if (linkDraft.profiles[lp.id] === m.id) linkDraft.profiles = without(linkDraft.profiles, lp.id);
        else linkDraft.profiles[lp.id] = m.id;
      }
      render();
    } else if (x.indexOf("hist:") === 0 && linkDraft) {
      const sv = paired.serverProfiles() || [];
      const v = x.slice(5);
      linkDraft.historical = v === "none" ? null : sv[+v] ? sv[+v].id : null;
      render();
    } else if (x === "link-save" && linkDraft) {
      paired.saveLinks(linkDraft);
      linkDraft = null;
      leave("family");
    } else if (x === "unpair") {
      paired.unpair();
      leave("family");
    } else if (x === "back") {
      if (screen === "edit") screen = "profiles";
      else if (screen === "stub" || screen === "topics") screen = "subjects";
      else if (screen === "tables") screen = "topics";
      else if (screen === "themes") screen = "tables";
      else if (screen === "quiz" || screen === "lesson" || screen === "complete") {
        if (screen === "lesson")
          hook(function (c) {
            paired.lessonLeft(c, fact);
          });
        stop();
        screen = "themes";
      } else if (screen === "pair" || screen === "link") {
        paired.cancelPairing();
        screen = "family";
      } else screen = "profiles";
      render();
    }
  }
  let familyShown = paired.enabled();
  paired.setListener(function () {
    if (paired.enabled() !== familyShown) {
      // The server flag arrives after the first render: add/remove the Family account entry once.
      familyShown = paired.enabled();
      if (screen === "profiles") render();
      return;
    }
    if (screen === "pair" || screen === "family" || (screen === "link" && !linkDraft)) {
      if (screen === "pair" && paired.pairing().state === "paired" && paired.isPaired()) {
        linkDraft = null;
        screen = "link";
      }
      render();
    }
  });
  doc.addEventListener("keydown", function (e: KeyboardEvent) {
    const k = e.key || "",
      code = e.keyCode || 0;
    if (k === "Escape" || k === "Backspace" || code === 461 || code === 10009) {
      if (doc.activeElement && doc.activeElement.tagName === "INPUT") return;
      if (screen === "lesson") save(false);
      action("back");
      e.preventDefault();
      return;
    }
    if (screen === "lesson" && (k === " " || k === "MediaPlayPause" || code === 179)) {
      e.preventDefault();
      pause();
      return;
    }
    if (screen === "lesson" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].indexOf(k) >= 0) reveal();
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].indexOf(k) < 0) return;
    const bs = app.querySelectorAll("button:not(:disabled)"),
      current = doc.activeElement as HTMLElement | null;
    if (!bs.length) return;
    const rect = current && current.getBoundingClientRect ? current.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 },
      cx = rect.left + rect.width / 2,
      cy = rect.top + rect.height / 2;
    let best: HTMLElement | null = null,
      dist = 1e10;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i] as HTMLElement;
      if (b === current) continue;
      const r = b.getBoundingClientRect(),
        dx = r.left + r.width / 2 - cx,
        dy = r.top + r.height / 2 - cy,
        ok = k === "ArrowRight" ? dx > 3 : k === "ArrowLeft" ? dx < -3 : k === "ArrowDown" ? dy > 3 : dy < -3;
      if (!ok) continue;
      const a = k === "ArrowLeft" || k === "ArrowRight" ? Math.abs(dx) : Math.abs(dy),
        c = k === "ArrowLeft" || k === "ArrowRight" ? Math.abs(dy) : Math.abs(dx),
        test = a + 2.8 * c;
      if (test < dist) {
        dist = test;
        best = b;
      }
    }
    if (!best) best = bs[0] as HTMLElement;
    e.preventDefault();
    best.focus();
    if (screen === "lesson") reveal();
  });
  doc.addEventListener("visibilitychange", function () {
    if (screen === "lesson") {
      save(false);
      if (doc.hidden) {
        hook(function (c) {
          paired.lessonLeft(c, fact);
        });
        paused = true;
        stop();
      } else render();
    }
    if (doc.hidden) {
      music.pause();
      try {
        paired.hidden();
      } catch {
        /* ignore */
      }
    }
  });
  deps.win.addEventListener("pagehide", function () {
    if (screen === "lesson") save(false);
    try {
      paired.hidden();
    } catch {
      /* ignore */
    }
  });
  try {
    render();
  } catch {
    app.innerHTML = '<div class="panel"><h1>Let’s try again!</h1><p>We had trouble opening your adventure.</p><button onclick="location.reload()">Retry</button></div>';
  }
}
