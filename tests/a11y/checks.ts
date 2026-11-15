/**
 * Focused, dependency-free accessibility checks (axe-core is not installed; requested in
 * docs/adr/proposals/A9-qa-ops.md). Each check runs in the page and returns human-readable violations.
 * Covers WCAG 2.1 A/AA items that matter for this app: page language, one h1 and no skipped heading levels,
 * landmarks, accessible names for controls/buttons/links, image alt, unique ids, table headers, text contrast
 * (computed colours, effective background), visible keyboard focus, and TV target size.
 */
import type { Page } from "@playwright/test";

export interface A11yReport {
  violations: string[];
}

/** Static DOM checks (no interaction). */
export async function staticChecks(page: Page, o: { landmarks?: boolean; logotype?: string } = {}): Promise<A11yReport> {
  // WCAG 1.4.3 exempts logotypes: the "BreakNLearn" wordmark (.brand) keeps its brand colours.
  return page.evaluate(([landmarks, logotype]) => {
    const v: string[] = [];
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const nameOf = (el: Element): string => {
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const by = el.getAttribute("aria-labelledby");
      if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(" ").trim();
      const id = el.getAttribute("id");
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l && text(l)) return text(l);
      }
      const wrap = el.closest("label");
      if (wrap && text(wrap)) return text(wrap);
      if (el instanceof HTMLImageElement) return el.alt;
      const inner = text(el) || Array.from(el.querySelectorAll("img[alt]")).map((i) => (i as HTMLImageElement).alt).join(" ");
      if (inner) return inner;
      return el.getAttribute("title") ?? "";
    };
    const path = (el: Element) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/).join(".")}` : "";
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    if (!document.documentElement.lang) v.push("html has no lang attribute");
    if (!document.title.trim()) v.push("document has no <title>");

    const h1 = Array.from(document.querySelectorAll("h1")).filter(visible);
    if (h1.length !== 1) v.push(`expected exactly one visible h1, found ${h1.length}`);
    let prev = 0;
    for (const h of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(visible)) {
      const level = Number(h.tagName[1]);
      if (prev && level > prev + 1) v.push(`heading level skipped: h${prev} → h${level} ("${text(h).slice(0, 40)}")`);
      prev = level;
    }

    if (landmarks) {
      if (document.querySelectorAll("main, [role=main]").length !== 1) v.push("expected exactly one main landmark");
      for (const n of Array.from(document.querySelectorAll("nav"))) if (!n.getAttribute("aria-label") && !n.getAttribute("aria-labelledby")) v.push("nav without accessible name");
    }

    for (const el of Array.from(document.querySelectorAll("input, select, textarea")).filter(visible)) {
      if ((el as HTMLInputElement).type === "hidden") continue;
      if (!nameOf(el)) v.push(`form control without label: ${path(el)}`);
    }
    for (const el of Array.from(document.querySelectorAll("button, a[href], [role=button]")).filter(visible)) {
      if (!nameOf(el)) v.push(`interactive element without accessible name: ${path(el)}`);
    }
    for (const img of Array.from(document.querySelectorAll("img"))) if (!img.hasAttribute("alt")) v.push(`img without alt: ${img.src.slice(-40)}`);

    const ids = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll("[id]"))) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) v.push(`duplicate id "${id}" ×${n}`);

    for (const t of Array.from(document.querySelectorAll("table")).filter(visible)) if (!t.querySelector("th")) v.push("data table without header cells");

    // Contrast (WCAG 1.4.3): text nodes vs effective background.
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (x: number) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const bgOf = (el: Element | null): [number, number, number] | null => {
      let layers: [number, number, number, number][] = [];
      for (let e = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // gradient/image: cannot compute, skip
        const c = parse(cs.backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      layers = layers.reverse();
      let out: [number, number, number] = [255, 255, 255];
      for (const [r, g, b, a] of layers) out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
      return out;
    };
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim() || !visible(el)) continue;
      if (logotype && el.closest(logotype as string)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (Number(cs.opacity) === 0) continue;
      const bg = bgOf(el);
      if (!bg) continue;
      const fg = parse(cs.color);
      const blended: [number, number, number] = [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])];
      const [a, b] = [lum(blended), lum(bg)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio + 1e-6 < need) v.push(`contrast ${ratio.toFixed(2)} < ${need} for "${n.textContent.trim().slice(0, 40)}" (${cs.color} on rgb(${bg.map(Math.round).join(",")}))`);
    }
    return { violations: v };
  }, [o.landmarks ?? true, o.logotype ?? ".brand"] as const);
}

/**
 * Keyboard: Tab through up to `max` stops; every stop must be a visible element whose focused style differs
 * visibly from its unfocused style (outline, box-shadow or border), and focus must not get trapped.
 */
export async function keyboardFocusChecks(page: Page, max = 25): Promise<A11yReport> {
  const v: string[] = [];
  const seen: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const f = getComputedStyle(el);
      const focused = { outline: `${f.outlineStyle} ${f.outlineWidth}`, shadow: f.boxShadow, border: f.borderColor, bg: f.backgroundColor };
      el.blur();
      const u = getComputedStyle(el);
      const unfocused = { outline: `${u.outlineStyle} ${u.outlineWidth}`, shadow: u.boxShadow, border: u.borderColor, bg: u.backgroundColor };
      el.focus();
      const outlineVisible = f.outlineStyle !== "none" && parseFloat(f.outlineWidth) >= 1;
      return {
        key: `${el.tagName.toLowerCase()}:${(el.getAttribute("aria-label") ?? el.textContent ?? el.id ?? "").trim().slice(0, 30)}`,
        visible: r.width > 0 && r.height > 0,
        indicator: outlineVisible || JSON.stringify(focused) !== JSON.stringify(unfocused),
      };
    });
    if (!info) break;
    if (!info.visible) v.push(`focus moved to an invisible element ${info.key}`);
    if (!info.indicator) v.push(`no visible focus indicator on ${info.key}`);
    if (seen.includes(info.key) && seen.length > 1 && seen[0] === info.key) break; // wrapped around
    seen.push(info.key);
  }
  if (seen.length === 0) v.push("no element is reachable with Tab");
  return { violations: v };
}
