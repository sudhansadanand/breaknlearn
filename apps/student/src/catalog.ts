/**
 * Built-in content (identical to the live app) and the optional server catalog (M05 → M06).
 * The server catalog is used only in paired mode; it replaces the built-in ×1–×10 tables only
 * when a complete, valid set (manifest + every lesson) was fetched. The last good set is cached.
 */
import { isArray, isObject, isUuid, readJson, writeJson, type KeyValueStore } from "./util";

export interface World {
  id: string;
  name: string;
  icon: string;
  plural: string;
  color: string;
}

export const AVATARS = ["🦊", "🐉", "🦄", "🚀", "🐼", "🦁", "🤖", "🦸", "🐯", "🧑‍🚀", "🦋", "🐧"];
export const AVATAR_IDS = ["fox", "dragon", "unicorn", "rocket", "panda", "lion", "robot", "superhero", "tiger", "astronaut", "butterfly", "penguin"];

export const SUBJECTS: { [grade: number]: string[][] } = {
  2: [["English", "📖"], ["Math", "🔢"], ["Tamil", "🔤"], ["Hindi", "🪷"], ["Science", "🔬"], ["Aadritha", "🪔"], ["Music", "🎵"]],
  6: [["English", "📖"], ["Math", "🔢"], ["Tamil", "🔤"], ["Hindi", "🪷"], ["Physics", "🪐"], ["Chemistry", "⚗️"], ["Biology", "🧬"], ["History & Civics", "🏛️"], ["Geography", "🌎"], ["Western Violin", "🎻"], ["Carnatic Violin", "🎼"], ["Aadritha", "🪔"]],
};

export const WORLDS: World[] = [
  { id: "puppy", name: "Puppy Park", icon: "🐶", plural: "puppies", color: "#6633a8" },
  { id: "candy", name: "Candy Land", icon: "🍬", plural: "candies", color: "#a64487" },
  { id: "unicorn", name: "Unicorn Sky", icon: "🦄", plural: "unicorns", color: "#5546b8" },
  { id: "school", name: "School Box", icon: "✏️", plural: "pencils", color: "#287ba1" },
  { id: "treat", name: "Treat Time", icon: "🍦", plural: "ice creams", color: "#986034" },
  { id: "farm", name: "Animal Farm", icon: "🐴", plural: "horses", color: "#4d8a60" },
];

/** UUIDv5 lesson ids from @bnl/contracts MULTIPLICATION_LESSON_IDS (parity-tested). */
export const LESSON_IDS: { [table: number]: string } = {
  1: "02402664-c8e7-5408-ab92-292f6e20a308",
  2: "6a7999d7-caba-5778-87b0-34529b85fdb4",
  3: "f95143b0-7b4c-5452-8a3f-71096a538dff",
  4: "6dcc8a5d-23c4-5a87-8871-17db135101c5",
  5: "e13f93ea-9d02-5a12-bf91-b4fc6554f5a9",
  6: "34ed2bc4-a121-5847-998d-d5d7c227252a",
  7: "2b0028d9-dd24-5020-84f7-c75af77b7b39",
  8: "e2e6e8a9-7da3-540b-a802-346b53f12270",
  9: "a43a1ef5-01d2-5b95-bb56-868c672e70a0",
  10: "c888722d-7b0f-5dc2-b371-41b47d542367",
};

export const stableKeyFor = function (table: number): string {
  return "grade2.math.multiplication.table-" + table;
};

/** One playable multiplication table. */
export interface TableLesson {
  table: number;
  lessonId: string;
  versionId: string | null;
  versionNo: number | null;
  stableKey: string;
  worlds: string[];
  secondsPerSlide: number;
  quizCount: number;
}

export interface StudentCatalog {
  source: "builtin" | "server";
  mathPlayable: boolean;
  tables: TableLesson[];
  revision: number | null;
}

export function builtinCatalog(): StudentCatalog {
  const tables: TableLesson[] = [];
  for (let t = 1; t <= 10; t++) {
    tables.push({ table: t, lessonId: LESSON_IDS[t], versionId: null, versionNo: null, stableKey: stableKeyFor(t), worlds: ["puppy", "candy", "unicorn", "school", "treat", "farm"], secondsPerSlide: 7, quizCount: 3 });
  }
  return { source: "builtin", mathPlayable: true, tables: tables, revision: null };
}

export function findWorld(id: string): World {
  for (let i = 0; i < WORLDS.length; i++) if (WORLDS[i].id === id) return WORLDS[i];
  return WORLDS[0];
}

export function isWorldId(id: unknown): boolean {
  for (let i = 0; i < WORLDS.length; i++) if (WORLDS[i].id === id) return true;
  return false;
}

export interface ManifestLessonRef {
  id: string;
  version_id: string;
  version_no: number;
  stable_key: string;
  template_key: string;
  sort_order: number;
}

/**
 * Extracts the Grade 2 Math picture_groups lessons from a PublishedManifest. Returns null when the
 * manifest is not usable (the caller then keeps the last good catalog).
 */
export function manifestLessons(m: unknown): { revision: number; playable: boolean; lessons: ManifestLessonRef[] } | null {
  if (!isObject(m) || typeof m.revision !== "number" || m.grade !== 2 || !isArray(m.subjects)) return null;
  let math: { [k: string]: unknown } | null = null;
  for (let i = 0; i < m.subjects.length; i++) {
    const s = m.subjects[i];
    if (isObject(s) && s.key === "math") math = s;
  }
  if (!math) return { revision: m.revision, playable: false, lessons: [] };
  if (!isArray(math.topics)) return null;
  const out: ManifestLessonRef[] = [];
  for (let t = 0; t < math.topics.length; t++) {
    const topic = math.topics[t];
    if (!isObject(topic) || !isArray(topic.lessons)) return null;
    for (let l = 0; l < topic.lessons.length; l++) {
      const x = topic.lessons[l];
      if (!isObject(x) || !isUuid(x.id) || !isUuid(x.version_id) || typeof x.version_no !== "number") return null;
      if (x.template_key !== "picture_groups_v1") continue; // only template this client can render
      out.push({ id: x.id, version_id: x.version_id, version_no: x.version_no, stable_key: String(x.stable_key), template_key: "picture_groups_v1", sort_order: typeof x.sort_order === "number" ? x.sort_order : 0 });
    }
  }
  out.sort(function (a, b) {
    return a.sort_order - b.sort_order;
  });
  return { revision: m.revision, playable: math.playable === true, lessons: out };
}

function intIn(x: unknown, lo: number, hi: number): boolean {
  return typeof x === "number" && x % 1 === 0 && x >= lo && x <= hi;
}

/** Validates one PublishedLesson against what this client can render; null if not renderable. */
export function lessonFromPublished(ref: ManifestLessonRef, lesson: unknown): TableLesson | null {
  if (!isObject(lesson) || lesson.id !== ref.id || lesson.version_id !== ref.version_id || !isObject(lesson.content)) return null;
  const c = lesson.content;
  if (c.template !== "picture_groups_v1" || c.grade !== 2 || c.subject_key !== "math" || !isObject(c.config)) return null;
  const cfg = c.config;
  if (!intIn(cfg.factor, 1, 10)) return null;
  // The TV UI shows exactly ten facts (1..10) as the live app does.
  if (cfg.count_from !== undefined && cfg.count_from !== 1) return null;
  if (cfg.count_to !== undefined && cfg.count_to !== 10) return null;
  if (!isArray(cfg.themes) || cfg.themes.length < 1) return null;
  const worlds: string[] = [];
  for (let i = 0; i < WORLDS.length; i++) {
    // Live world order, filtered to the enabled themes.
    for (let j = 0; j < cfg.themes.length; j++) if (cfg.themes[j] === WORLDS[i].id && worlds.indexOf(WORLDS[i].id) < 0) worlds.push(WORLDS[i].id);
  }
  for (let j = 0; j < cfg.themes.length; j++) if (!isWorldId(cfg.themes[j])) return null;
  const sps = cfg.seconds_per_slide === undefined ? 7 : cfg.seconds_per_slide;
  const qc = cfg.quiz_question_count === undefined ? 3 : cfg.quiz_question_count;
  if (!intIn(sps, 3, 30) || !intIn(qc, 1, 10)) return null;
  return {
    table: cfg.factor as number,
    lessonId: ref.id,
    versionId: ref.version_id,
    versionNo: ref.version_no,
    stableKey: typeof c.stable_key === "string" ? c.stable_key : ref.stable_key,
    worlds: worlds,
    secondsPerSlide: sps as number,
    quizCount: qc as number,
  };
}

export const CATALOG_CACHE_KEY = "breaknlearn.catalog.v1";

export interface CachedCatalog {
  version: 1;
  revision: number;
  etag: string | null;
  playable: boolean;
  lessons: { [lessonId: string]: { ref: ManifestLessonRef; lesson: unknown } };
  order: string[];
}

/** Rebuilds a StudentCatalog from a cached manifest + lessons; null if any lesson is unusable. */
export function catalogFromCache(cached: unknown): StudentCatalog | null {
  if (!isObject(cached) || cached.version !== 1 || !isArray(cached.order) || !isObject(cached.lessons)) return null;
  const tables: TableLesson[] = [];
  const seen: number[] = [];
  for (let i = 0; i < cached.order.length; i++) {
    const item = cached.lessons[String(cached.order[i])];
    if (!isObject(item) || !isObject(item.ref)) return null;
    const t = lessonFromPublished(item.ref as unknown as ManifestLessonRef, item.lesson);
    if (!t || seen.indexOf(t.table) >= 0) return null;
    seen.push(t.table);
    tables.push(t);
  }
  return { source: "server", mathPlayable: cached.playable === true && tables.length > 0, tables: tables, revision: typeof cached.revision === "number" ? cached.revision : null };
}

export function loadCachedCatalog(store: KeyValueStore): StudentCatalog | null {
  return catalogFromCache(readJson(store, CATALOG_CACHE_KEY, null));
}

export function saveCachedCatalog(store: KeyValueStore, c: CachedCatalog): boolean {
  return catalogFromCache(c) !== null && writeJson(store, CATALOG_CACHE_KEY, c);
}
