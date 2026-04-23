import "@logseq/libs";
import { logseq as PL } from "../package.json";

const pluginId = PL.id;

type FilterMode = "all" | "journal-only" | "non-journal-only";

let currentMode: FilterMode = "all";
let observer: MutationObserver | null = null;
const journalCache = new Map<string, boolean>();
let hideStyleEl: HTMLStyleElement | null = null;
let delegateAttached = false;

const SHOW_CLASS = "link-filter-show";
const FILTER_BAR_CLASS = `${pluginId}-filter-bar`;
const BTN_CLASS = "link-filter-btn";

function getDoc(): Document {
  return top?.document ?? parent.document;
}

async function isJournalPage(pageName: string): Promise<boolean> {
  const key = pageName.toLowerCase();
  const cached = journalCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const page = await logseq.Editor.getPage(pageName);
    const result = page?.["journal?"] === true;
    journalCache.set(key, result);
    return result;
  } catch {
    return false;
  }
}

function getRefGroupPageName(group: Element): string | null {
  const dataRefEl = group.querySelector("[data-ref]");
  if (dataRefEl) {
    const ref = dataRefEl.getAttribute("data-ref");
    if (ref) return ref;
  }

  const pageRef = group.querySelector(".page-ref");
  if (pageRef?.textContent) {
    return pageRef.textContent.trim();
  }

  const anchor = group.querySelector("a[data-page-name]");
  if (anchor) {
    return anchor.getAttribute("data-page-name");
  }

  return null;
}

/**
 * CSS-level hide: immediately hide all items, only show ones marked with SHOW_CLASS.
 * When mode is "all", remove the style entirely.
 */
function updateHideStyle(mode: FilterMode): void {
  const doc = getDoc();

  if (mode === "all") {
    if (hideStyleEl?.parentNode) {
      hideStyleEl.parentNode.removeChild(hideStyleEl);
    }
    hideStyleEl = null;
    doc.querySelectorAll(`.${SHOW_CLASS}`).forEach((el) => {
      el.classList.remove(SHOW_CLASS);
    });
    return;
  }

  if (!hideStyleEl) {
    hideStyleEl = doc.createElement("style");
    hideStyleEl.setAttribute("data-injected-by", pluginId);
    doc.head.appendChild(hideStyleEl);
  }

  hideStyleEl.textContent = `
    .references.page-linked .references-blocks-item {
      display: none !important;
    }
    .references.page-linked .references-blocks-item.${SHOW_CLASS} {
      display: block !important;
    }
  `;
}

async function markVisibleGroups(): Promise<void> {
  const doc = getDoc();
  const refSections = doc.querySelectorAll(".references.page-linked");
  if (refSections.length === 0) return;

  for (const refSection of refSections) {
    const groups = refSection.querySelectorAll(".references-blocks-item");
    if (groups.length === 0) continue;

    const entries: { el: HTMLElement; pageName: string | null }[] = [];
    for (const group of groups) {
      entries.push({
        el: group as HTMLElement,
        pageName: getRefGroupPageName(group),
      });
    }

    const journalResults = await Promise.all(
      entries.map(({ pageName }) =>
        pageName ? isJournalPage(pageName) : Promise.resolve(false)
      )
    );

    entries.forEach(({ el }, i) => {
      const isJournal = journalResults[i];
      const shouldShow =
        currentMode === "journal-only" ? isJournal : !isJournal;

      if (shouldShow) {
        el.classList.add(SHOW_CLASS);
      } else {
        el.classList.remove(SHOW_CLASS);
      }
    });
  }
}

async function applyFilter(mode: FilterMode): Promise<void> {
  currentMode = mode;
  updateHideStyle(mode);
  if (mode !== "all") {
    await markVisibleGroups();
  }
  // Update all button active states
  const doc = getDoc();
  doc.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
    const bEl = b as HTMLElement;
    bEl.classList.toggle("active", bEl.dataset.filterMode === mode);
  });
}

/**
 * Attach a single delegated click handler on a stable ancestor.
 * This survives DOM re-renders of the reference section.
 */
function attachDelegate(): void {
  if (delegateAttached) return;

  const doc = getDoc();
  doc.addEventListener(
    "click",
    (e) => {
      const btn = (e.target as HTMLElement).closest(`.${BTN_CLASS}`);
      if (!btn) return;

      e.stopPropagation();
      e.preventDefault();

      const mode = (btn as HTMLElement).dataset.filterMode as
        | FilterMode
        | undefined;
      if (mode) {
        applyFilter(mode);
      }
    },
    true // capture phase, so we intercept before Logseq's handlers
  );

  delegateAttached = true;
}

function injectFilterBar(): void {
  const doc = getDoc();
  doc.querySelectorAll(`.${FILTER_BAR_CLASS}`).forEach((el) => el.remove());

  const refSections = doc.querySelectorAll(".references.page-linked");

  refSections.forEach((refSection) => {
    // The DOM structure is:
    //   .references.page-linked > .content > .flex.flex-col > .content
    //     > .foldable-title.cursor   <-- clicking this folds/unfolds
    //       > .flex.flex-row.items-center
    //         > h2 "N Linked References"
    //     > .hidden (the collapsed content)
    //
    // We must insert OUTSIDE .foldable-title to avoid its click handler.
    const foldableTitle = refSection.querySelector(".foldable-title");

    const bar = doc.createElement("div");
    bar.className = FILTER_BAR_CLASS;

    const modes: { mode: FilterMode; label: string; title: string }[] = [
      { mode: "all", label: "All", title: "显示全部 linked references" },
      { mode: "journal-only", label: "Journals", title: "仅显示 Journal 页面的引用" },
      { mode: "non-journal-only", label: "Pages", title: "仅显示非 Journal 页面的引用" },
    ];

    modes.forEach(({ mode, label, title }) => {
      const btn = doc.createElement("button");
      btn.textContent = label;
      btn.title = title;
      btn.dataset.filterMode = mode;
      btn.className = `${BTN_CLASS}${mode === currentMode ? " active" : ""}`;
      bar.appendChild(btn);
    });

    // Insert AFTER .foldable-title as a sibling, so clicks on our bar
    // never bubble through the fold/unfold handler.
    if (foldableTitle) {
      foldableTitle.insertAdjacentElement("afterend", bar);
    } else {
      refSection.insertBefore(bar, refSection.firstChild);
    }
  });
}

function setupObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  const doc = getDoc();
  const mainContent =
    doc.getElementById("main-content-container") ||
    doc.getElementById("app-container") ||
    doc.querySelector("#main-container");
  if (!mainContent) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const refSections = getDoc().querySelectorAll(".references.page-linked");
      if (refSections.length > 0) {
        let needsInject = false;
        refSections.forEach((section) => {
          if (!section.querySelector(`.${FILTER_BAR_CLASS}`)) {
            needsInject = true;
          }
        });
        if (needsInject) {
          injectFilterBar();
        }
        if (currentMode !== "all") {
          markVisibleGroups();
        }
      }
    }, 200);
  });

  observer.observe(mainContent, {
    childList: true,
    subtree: true,
  });
}

function main() {
  console.info(`#${pluginId}: MAIN`);

  logseq.provideStyle(`
    .${FILTER_BAR_CLASS} {
      display: flex;
      gap: 4px;
      padding: 4px 0;
    }
    .${BTN_CLASS} {
      padding: 1px 8px;
      border-radius: 4px;
      border: 1px solid var(--ls-border-color, #d1d5db);
      background: transparent;
      color: var(--ls-primary-text-color, #374151);
      font-size: 12px;
      cursor: pointer;
      line-height: 1.5;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .${BTN_CLASS}:hover {
      background: var(--ls-quaternary-background-color, #f3f4f6);
    }
    .${BTN_CLASS}.active {
      background: var(--ls-active-primary-color, #4f46e5);
      color: #fff;
      border-color: var(--ls-active-primary-color, #4f46e5);
    }
  `);

  // Single delegated click handler — never lost to DOM re-renders
  attachDelegate();

  logseq.App.onRouteChanged(() => {
    currentMode = "all";
    updateHideStyle("all");
    setTimeout(() => {
      injectFilterBar();
      setupObserver();
    }, 800);
  });

  setTimeout(() => {
    injectFilterBar();
    setupObserver();
  }, 1500);
}

logseq.ready(main).catch(console.error);
