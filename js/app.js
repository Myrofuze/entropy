/* ==========================================================================
   PUBLICATION — app.js
   Architecture : découverte → parsing YAML → parsing Markdown → sanitisation
                  → indexation → affichage
   Modules internes séparés ci-dessous (IIFE unique pour rester "un fichier").
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------
     0. CONFIG
     ------------------------------------------------------------------ */

  const CONFIG = {
    etudeDir: "etude/",
    imageDir: "etude/image/",
    // Fichier listant les études publiées. GitHub Pages (et le web statique
    // en général) ne permet pas de lister le contenu d'un dossier depuis le
    // navigateur — ce fichier doit donc être tenu à jour à la main :
    // ajouter le nom du .md dans "files" à chaque nouvelle étude.
    // Format : { "files": ["etude-1.md", "etude-2.md", ...] }
    manifestPath: "etude/index.json",
  };

  /* ------------------------------------------------------------------
     1. DÉCOUVERTE DES FICHIERS
     ------------------------------------------------------------------
     GitHub Pages (et le web statique en général) ne permet pas de lister
     le contenu d'un dossier depuis le navigateur. La source de vérité est
     donc etude/index.json, tenu à jour à la main :

       { "files": ["etude-1.md", "etude-2.md"] }

     Ajouter une étude = déposer le .md dans etude/ + ajouter son nom dans
     ce tableau. Rien d'autre à toucher dans le code.
  */

  async function discoverStudyFiles() {
    let res;
    try {
      res = await fetch(CONFIG.manifestPath, { cache: "no-store" });
    } catch (err) {
      console.error(
        `Impossible de récupérer ${CONFIG.manifestPath} (erreur réseau). ` +
          `Vérifiez que le fichier existe bien à la racine du dossier etude/.`,
        err
      );
      return [];
    }

    if (!res.ok) {
      console.error(
        `${CONFIG.manifestPath} introuvable (HTTP ${res.status}). ` +
          `Créez etude/index.json avec la liste des fichiers .md publiés.`
      );
      return [];
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      console.error(
        `${CONFIG.manifestPath} n'est pas un JSON valide. ` +
          `Vérifiez la syntaxe (virgules, guillemets).`,
        err
      );
      return [];
    }

    if (!Array.isArray(data.files)) {
      console.error(
        `${CONFIG.manifestPath} doit contenir un tableau "files". Reçu :`,
        data
      );
      return [];
    }

    // Accepter soit des strings simples soit des objets avec métadonnées
    const files = data.files.map((item) => {
      if (typeof item === "string") return item;
      return item.filename || item;
    }).filter((f) => {
      const name = String(f).toLowerCase();
      return name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".quartz");
    });
    
    if (!files.length) {
      console.warn(`${CONFIG.manifestPath} ne liste aucun fichier .md, .txt ou .quartz.`);
    }
    
    // Stocker aussi les données enrichies pour usage ultérieur
    store.manifestData = data;
    return files;
  }

  /* ------------------------------------------------------------------
     2. CHARGEMENT D'UNE ÉTUDE (fichier brut)
     ------------------------------------------------------------------ */

  async function loadStudyRaw(filename) {
    const res = await fetch(CONFIG.etudeDir + filename, { cache: "no-store" });
    if (!res.ok) throw new Error(`Impossible de charger ${filename}`);
    return res.text();
  }

  /* ------------------------------------------------------------------
     3. PARSING DU FRONT MATTER YAML
     ------------------------------------------------------------------ */

  function parseFrontMatter(raw) {
    // Regex flexible pour les différents sauts de ligne (CRLF, LF).
    // L'absence de front matter est un cas normal (les métadonnées peuvent
    // venir entièrement de etude/index.json) — pas de warning ici.
    const match = raw.match(/^---[\r\n]+([\s\S]*?)[\r\n]+---[\r\n]*/);
    if (!match) {
      return { meta: {}, body: raw };
    }
    let meta = {};
    try {
      meta = jsyaml.load(match[1]) || {};
    } catch (err) {
      console.warn("Front matter YAML invalide :", err, "\nContenu :", match[1]);
      meta = {};
    }
    const body = raw.slice(match[0].length);
    return { meta, body };
  }

  function normalizeMeta(meta, filename) {
    // Retirer l'extension .md, .txt ou .quartz pour le slug
    const slug = filename.replace(/\.(md|txt|quartz)$/i, "");
    
    // Chercher les métadonnées du JSON si disponibles (priorité sur celles du fichier)
    let jsonMeta = {};
    if (store.manifestData && store.manifestData.files) {
      const entry = store.manifestData.files.find((item) => {
        const itemFilename = typeof item === "string" ? item : item.filename;
        return itemFilename === filename;
      });
      if (entry && typeof entry === "object") {
        jsonMeta = entry;
      }
    }
    
    return {
      slug,
      filename,
      title: (jsonMeta.title || meta.title) && String(jsonMeta.title || meta.title).trim() || slug,
      author: (jsonMeta.author || meta.author) && String(jsonMeta.author || meta.author).trim() || "Auteur inconnu",
      date: (jsonMeta.date || meta.date) && String(jsonMeta.date || meta.date).trim() || null,
      updated: (jsonMeta.updated || meta.updated) && String(jsonMeta.updated || meta.updated).trim() || (meta.modified && String(meta.modified).trim()) || null,
      category: (jsonMeta.category || meta.category) && String(jsonMeta.category || meta.category).trim() || "",
      description: (jsonMeta.description || meta.description) && String(jsonMeta.description || meta.description).trim() || "",
    };
  }

  /* ------------------------------------------------------------------
     4. MARKDOWN → HTML
     ------------------------------------------------------------------
     - markdown-it pour la conversion de base (titres, gras, italique,
       listes, liens, citations, tableaux, code, séparateurs, images)
     - résolution des chemins d'image relatifs vers etude/image/
     - protection des blocs $$...$$ et $...$ avant le parsing Markdown
       pour que KaTeX les rende ensuite sans interférence
  */

  let mdParser = null;
  function getMarkdownParser() {
    if (mdParser) return mdParser;
    mdParser = window.markdownit({
      html: false, // pas de HTML brut dans le Markdown — sécurité
      linkify: true,
      typographer: true,
      breaks: false,
    });

    // Résolution des chemins d'image relatifs vers etude/image/, puis
    // wrapper <figure> autour de l'image avec l'alt en légende.
    const defaultImageRender = mdParser.renderer.rules.image;
    mdParser.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const srcIndex = token.attrIndex("src");
      if (srcIndex >= 0) {
        const src = token.attrs[srcIndex][1];
        token.attrs[srcIndex][1] = resolveImagePath(src);
      }
      token.attrSet("loading", "lazy");

      const altText = token.content || "";
      const imgHtml = defaultImageRender
        ? defaultImageRender(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
      const caption = altText
        ? `<figcaption>${mdParser.utils.escapeHtml(altText)}</figcaption>`
        : "";
      return `<figure>${imgHtml}${caption}</figure>`;
    };

    // Wrap tableaux pour scroll horizontal mobile
    const defaultTableOpen = mdParser.renderer.rules.table_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
    const defaultTableClose = mdParser.renderer.rules.table_close || ((t, i, o, e, s) => s.renderToken(t, i, o));
    mdParser.renderer.rules.table_open = (tokens, idx, options, env, self) =>
      `<div class="table-scroll">${defaultTableOpen(tokens, idx, options, env, self)}`;
    mdParser.renderer.rules.table_close = (tokens, idx, options, env, self) =>
      `${defaultTableClose(tokens, idx, options, env, self)}</div>`;

    // Fenced code blocks : laisser markdown-it générer <pre><code class="language-x">
    // (la coloration syntaxique est appliquée après coup par highlight.js)

    return mdParser;
  }

  function resolveImagePath(src) {
    if (!src) return src;
    // Ne pas toucher aux URLs absolues (http(s), data:, //cdn...)
    if (/^([a-z]+:)?\/\//i.test(src) || src.startsWith("data:")) return src;
    if (src.startsWith("image/")) return CONFIG.etudeDir + src;
    if (src.startsWith("/")) return src;
    return CONFIG.etudeDir + src;
  }

  // Protège $$...$$ et $...$ avant le rendu Markdown, les restitue après
  // sanitisation pour que KaTeX les trouve intacts.
  function extractMathPlaceholders(source) {
    const store = [];
    let i = 0;

    let out = source.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
      const token = `@@MATHBLOCK${i}@@`;
      store.push({ token, expr: expr.trim(), display: true });
      i += 1;
      return `\n\n${token}\n\n`;
    });

    out = out.replace(/(^|[^\\$])\$([^\n$]+?)\$(?!\$)/g, (m, pre, expr) => {
      const token = `@@MATHINLINE${i}@@`;
      store.push({ token, expr: expr.trim(), display: false });
      i += 1;
      return `${pre}${token}`;
    });

    return { out, store };
  }

  function restoreMathPlaceholders(html, store) {
    let result = html;
    for (const { token, expr, display } of store) {
      let rendered;
      try {
        rendered = katex.renderToString(expr, {
          throwOnError: false,
          displayMode: display,
        });
      } catch (err) {
        rendered = `<code>${mdParser.utils.escapeHtml(expr)}</code>`;
      }
      // Le token peut apparaître entouré de <p> si isolé sur sa ligne
      const wrapped = new RegExp(`<p>\\s*${token}\\s*</p>`, "g");
      result = result.replace(wrapped, rendered);
      result = result.split(token).join(rendered);
    }
    return result;
  }

  function markdownToHtml(markdownSource) {
    const parser = getMarkdownParser();
    const { out, store } = extractMathPlaceholders(markdownSource);
    const rawHtml = parser.render(out);
    const withMath = restoreMathPlaceholders(rawHtml, store);
    return withMath;
  }

  /* ------------------------------------------------------------------
     5. SANITISATION
     ------------------------------------------------------------------ */

  function sanitizeHtml(html) {
    return DOMPurify.sanitize(html, {
      ADD_TAGS: ["figure", "figcaption"],
      ADD_ATTR: ["loading", "target", "rel"],
      FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    });
  }

  /* ------------------------------------------------------------------
     6. INDEXATION / CHARGEMENT COMPLET DU CATALOGUE
     ------------------------------------------------------------------ */

  const store = {
    studies: [],       // [{ meta..., html, plainText }]
    loaded: false,
    categories: [],
  };

  function stripHtmlToText(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || "").replace(/\s+/g, " ").trim();
  }

  async function buildCatalog() {
    const files = await discoverStudyFiles();
    const results = [];

    for (const filename of files) {
      try {
        const raw = await loadStudyRaw(filename);
        const { meta, body } = parseFrontMatter(raw);
        const normalized = normalizeMeta(meta, filename);
        const html = sanitizeHtml(markdownToHtml(body));
        const plainText = stripHtmlToText(html);
        results.push({
          ...normalized,
          html,
          searchBlob: [
            normalized.title,
            normalized.author,
            normalized.category,
            normalized.description,
            plainText,
          ]
            .join(" ")
            .toLowerCase(),
        });
      } catch (err) {
        console.warn(`Étude ignorée (${filename}) :`, err);
      }
    }

    // Tri par défaut : plus récent → plus ancien
    results.sort((a, b) => {
      const da = a.date ? Date.parse(a.date) : 0;
      const db = b.date ? Date.parse(b.date) : 0;
      return db - da;
    });

    store.studies = results;
    store.categories = Array.from(
      new Set(results.map((s) => s.category).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, "fr"));
    store.loaded = true;
  }

  /* ------------------------------------------------------------------
     7. RECHERCHE
     ------------------------------------------------------------------ */

  function searchStudies(query, activeCategory) {
    const q = query.trim().toLowerCase();
    return store.studies.filter((s) => {
      const matchesCategory = !activeCategory || s.category === activeCategory;
      const matchesQuery = !q || s.searchBlob.includes(q);
      return matchesCategory && matchesQuery;
    });
  }

  function highlight(text, query) {
    if (!query) return escapeHtml(text);
    const q = query.trim();
    if (!q) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const escapedQuery = escapeRegExp(escapeHtml(q));
    return escaped.replace(new RegExp(`(${escapedQuery})`, "ig"), "<mark>$1</mark>");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /* ------------------------------------------------------------------
     8. AFFICHAGE — LISTE DES ÉTUDES
     ------------------------------------------------------------------ */

  const el = {
    viewList: document.getElementById("view-list"),
    viewStudy: document.getElementById("view-study"),
    viewNotFound: document.getElementById("view-notfound"),
    studyList: document.getElementById("study-list"),
    searchInput: document.getElementById("search-input"),
    searchClear: document.getElementById("search-clear"),
    searchMeta: document.getElementById("search-meta"),
    filterRow: document.getElementById("filter-row"),
    studyHeader: document.getElementById("study-header"),
    studyBody: document.getElementById("study-body"),
    versionInfo: document.getElementById("version-info"),
    btnDownloadPdf: document.getElementById("btn-download-pdf"),
    lightbox: document.getElementById("lightbox"),
    lightboxImg: document.getElementById("lightbox-img"),
    lightboxClose: document.getElementById("lightbox-close"),
    footerYear: document.getElementById("footer-year"),
    readProgressBar: document.getElementById("read-progress-bar"),
    scrollTop: document.getElementById("scroll-top"),
    tocSidebar: document.getElementById("toc-sidebar"),
    tocSidebarNav: document.getElementById("toc-sidebar-nav"),
    tocMobile: document.getElementById("toc-mobile"),
    readingModeToggle: document.getElementById("reading-mode-toggle"),
    readingModeExit: document.getElementById("reading-mode-exit"),
  };

  let uiState = { query: "", category: "" };

  function formatDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });
  }

  function renderFilterChips() {
    if (!store.categories.length) {
      el.filterRow.hidden = true;
      return;
    }
    el.filterRow.hidden = false;
    el.filterRow.innerHTML = "";

    const makeChip = (label, value) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-chip";
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(uiState.category === value));
      btn.addEventListener("click", () => {
        uiState.category = uiState.category === value ? "" : value;
        renderFilterChips();
        renderList();
      });
      return btn;
    };

    el.filterRow.appendChild(makeChip("Toutes", ""));
    for (const cat of store.categories) {
      el.filterRow.appendChild(makeChip(cat, cat));
    }
  }

  function renderList() {
    const results = searchStudies(uiState.query, uiState.category);

    el.searchClear.setAttribute("data-visible", String(!!uiState.query));

    if (uiState.query || uiState.category) {
      const n = results.length;
      el.searchMeta.textContent = `${n} résultat${n === 1 ? "" : "s"}`;
    } else {
      el.searchMeta.textContent = `${store.studies.length} étude${store.studies.length === 1 ? "" : "s"} publiée${store.studies.length === 1 ? "" : "s"}`;
    }

    el.studyList.innerHTML = "";

    if (!results.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
        <p>Aucun résultat</p>
        <p>Essayez un autre mot-clé ou effacez les filtres actifs.</p>
      `;
      el.studyList.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const study of results) {
      const li = document.createElement("li");
      li.className = "study-item";

      const dateLabel = formatDate(study.date);
      const metaParts = [study.author];
      if (dateLabel) metaParts.push(dateLabel);

      li.innerHTML = `
        <a class="study-item__link" href="#/etude/${encodeURIComponent(study.slug)}" data-route-link>
          <div class="study-item__top">
            <h2 class="study-item__title">${highlight(study.title, uiState.query)}</h2>
            ${study.category ? `<span class="study-item__category">${escapeHtml(study.category)}</span>` : ""}
          </div>
          <p class="study-item__meta">${metaParts.map((p, i) => (i === 0 ? highlight(p, uiState.query) : `<span class="dot">·</span>${escapeHtml(p)}`)).join("")}</p>
          ${study.description ? `<p class="study-item__desc">${highlight(study.description, uiState.query)}</p>` : ""}
        </a>
      `;
      frag.appendChild(li);
    }
    el.studyList.appendChild(frag);
  }

  /* ------------------------------------------------------------------
     9. AFFICHAGE — PAGE D'UNE ÉTUDE
     ------------------------------------------------------------------ */

  function renderStudy(slug) {
    const study = store.studies.find((s) => s.slug === slug);
    if (!study) {
      showView("notfound");
      return;
    }

    document.title = `${study.title} — Publication`;

    const dateLabel = formatDate(study.date);
    const updatedLabel = formatDate(study.updated);

    el.studyHeader.innerHTML = `
      ${study.category ? `<span class="study-header__category">${escapeHtml(study.category)}</span>` : ""}
      <h1>${escapeHtml(study.title)}</h1>
      <div class="study-header__byline">
        <span>${escapeHtml(study.author)}</span>
        ${dateLabel ? `<span class="dot">·</span><span>${escapeHtml(dateLabel)}</span>` : ""}
      </div>
      ${study.description ? `<p class="study-header__desc">${escapeHtml(study.description)}</p>` : ""}
    `;

    if (dateLabel) {
      el.versionInfo.hidden = false;
      el.versionInfo.innerHTML = `
        <span><strong>Publié le :</strong> ${escapeHtml(dateLabel)}</span>
        ${updatedLabel ? `<span><strong>Dernière modification :</strong> ${escapeHtml(updatedLabel)}</span>` : ""}
      `;
    } else {
      el.versionInfo.hidden = true;
    }

    el.studyBody.innerHTML = study.html;
    el.studyBody.dataset.slug = study.slug;

    // Coloration syntaxique
    el.studyBody.querySelectorAll("pre code").forEach((block) => {
      try {
        hljs.highlightElement(block);
      } catch (_) {
        /* langage non reconnu : affichage brut, sans exécution */
      }
    });

    // Rendu KaTeX de secours pour toute notation $..$ échappée du pipeline
    // (les blocs principaux sont déjà rendus via extractMathPlaceholders)
    if (window.renderMathInElement) {
      renderMathInElement(el.studyBody, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    }

    enhanceCodeBlocks();
    buildTableOfContents();
    exitReadingMode();

    showView("study");
    window.scrollTo({ top: 0, behavior: "instant" in window.scrollTo ? "instant" : "auto" });
    updateReadProgress();
  }

  /* ------------------------------------------------------------------
     9b. BLOCS DE CODE — header, copie, collapse
     ------------------------------------------------------------------ */

  const CODE_COLLAPSE_LINE_THRESHOLD = 12;

  function enhanceCodeBlocks() {
    const blocks = Array.from(el.studyBody.querySelectorAll("pre"));
    for (const pre of blocks) {
      const codeEl = pre.querySelector("code");
      if (!codeEl) continue;

      const langMatch = (codeEl.className || "").match(/language-(\S+)/);
      const lang = langMatch ? langMatch[1] : "";
      const lineCount = codeEl.textContent.split("\n").length;

      const wrapper = document.createElement("div");
      wrapper.className = "code-block";

      const header = document.createElement("div");
      header.className = "code-block__header";

      if (lang) {
        const langLabel = document.createElement("span");
        langLabel.className = "code-block__lang";
        langLabel.textContent = lang;
        header.appendChild(langLabel);
      }

      const collapsible = lineCount > CODE_COLLAPSE_LINE_THRESHOLD;
      let toggleBtn = null;
      if (collapsible) {
        toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "code-block__btn";
        toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg><span>Développer</span>`;
        header.appendChild(toggleBtn);
      }

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "code-block__btn";
      copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copier</span>`;
      header.appendChild(copyBtn);

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);

      if (collapsible) {
        wrapper.setAttribute("data-collapsed", "true");
        toggleBtn.addEventListener("click", () => {
          const isCollapsed = wrapper.getAttribute("data-collapsed") === "true";
          wrapper.setAttribute("data-collapsed", String(!isCollapsed));
          toggleBtn.querySelector("span").textContent = isCollapsed ? "Réduire" : "Développer";
          toggleBtn.querySelector("svg").style.transform = isCollapsed ? "rotate(180deg)" : "";
        });
      }

      copyBtn.addEventListener("click", async () => {
        const text = codeEl.textContent;
        try {
          await navigator.clipboard.writeText(text);
        } catch (_) {
          // Repli pour contextes sans permission clipboard
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch (_) { /* rien de plus à faire */ }
          document.body.removeChild(ta);
        }
        const span = copyBtn.querySelector("span");
        const original = span.textContent;
        span.textContent = "Copié";
        copyBtn.disabled = true;
        setTimeout(() => {
          span.textContent = original;
          copyBtn.disabled = false;
        }, 1600);
      });
    }
  }

  /* ------------------------------------------------------------------
     9c. TABLE DES MATIÈRES — génération + scroll-spy
     ------------------------------------------------------------------ */

  let tocHeadings = [];
  let tocScrollHandler = null;

  function slugifyHeading(text, usedSlugs) {
    let base = text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!base) base = "section";
    let slug = base;
    let i = 2;
    while (usedSlugs.has(slug)) {
      slug = `${base}-${i}`;
      i += 1;
    }
    usedSlugs.add(slug);
    return slug;
  }

  function buildTableOfContents() {
    const headingEls = Array.from(el.studyBody.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    const usedSlugs = new Set();

    tocHeadings = headingEls.map((h) => {
      const id = slugifyHeading(h.textContent, usedSlugs);
      h.id = id;
      return { id, text: h.textContent, level: Number(h.tagName[1]) };
    });

    if (!tocHeadings.length) {
      el.tocSidebar.hidden = true;
      el.tocMobile.hidden = true;
      el.tocSidebarNav.innerHTML = "";
      el.tocMobile.innerHTML = "";
      return;
    }

    // Normaliser les niveaux relatifs (le plus petit heading trouvé = niveau 1 visuellement)
    const minLevel = Math.min(...tocHeadings.map((h) => h.level));

    el.tocSidebarNav.innerHTML = tocHeadings
      .map(
        (h) => `<a class="toc-link" data-level="${Math.min(h.level - minLevel + 1, 4)}" data-toc-id="${h.id}" href="#${h.id}">${escapeHtml(h.text)}</a>`
      )
      .join("");

    el.tocMobile.innerHTML = tocHeadings
      .map(
        (h) => `<a class="toc-mobile__chip" data-level="${Math.min(h.level - minLevel + 1, 4)}" data-toc-id="${h.id}" href="#${h.id}">${escapeHtml(h.text)}</a>`
      )
      .join("");

    el.tocSidebar.hidden = false;
    el.tocMobile.hidden = false;

    // Navigation douce sans dépendre du hash-router (évite un conflit de route)
    const allTocLinks = [
      ...el.tocSidebarNav.querySelectorAll("[data-toc-id]"),
      ...el.tocMobile.querySelectorAll("[data-toc-id]"),
    ];
    allTocLinks.forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const target = document.getElementById(link.dataset.tocId);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    if (tocScrollHandler) window.removeEventListener("scroll", tocScrollHandler);
    tocScrollHandler = throttle(updateActiveTocLink, 100);
    window.addEventListener("scroll", tocScrollHandler, { passive: true });
    updateActiveTocLink();
  }

  function updateActiveTocLink() {
    if (!tocHeadings.length) return;
    const scrollY = window.scrollY + 90;
    let activeId = tocHeadings[0].id;
    for (const h of tocHeadings) {
      const target = document.getElementById(h.id);
      if (target && target.offsetTop <= scrollY) activeId = h.id;
    }
    document.querySelectorAll("[data-toc-id]").forEach((link) => {
      link.setAttribute("data-active", String(link.dataset.tocId === activeId));
    });
    // Centrer la puce active dans la barre mobile
    const activeChip = el.tocMobile.querySelector(`[data-toc-id="${activeId}"]`);
    if (activeChip) {
      activeChip.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }

  /* ------------------------------------------------------------------
     9d. BARRE DE PROGRESSION DE LECTURE
     ------------------------------------------------------------------ */

  function updateReadProgress() {
    if (el.viewStudy.hidden) {
      el.readProgressBar.style.width = "0%";
      return;
    }
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress = docHeight > 0 ? Math.min(100, (window.scrollY / docHeight) * 100) : 0;
    el.readProgressBar.style.width = `${progress}%`;
  }

  /* ------------------------------------------------------------------
     9e. BOUTON REMONTER EN HAUT
     ------------------------------------------------------------------ */

  function updateScrollTopVisibility() {
  el.scrollTop?.setAttribute("data-visible", String(window.scrollY > 480));
}

  el.scrollTop.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  /* ------------------------------------------------------------------
     9f. MODE LECTURE
     ------------------------------------------------------------------ */

  function enterReadingMode() {
    document.body.setAttribute("data-reading-mode", "true");
    el.readingModeToggle.setAttribute("aria-pressed", "true");
  }

  function exitReadingMode() {
    document.body.removeAttribute("data-reading-mode");
    el.readingModeToggle.setAttribute("aria-pressed", "false");
  }

  el.readingModeToggle.addEventListener("click", () => {
    const active = document.body.getAttribute("data-reading-mode") === "true";
    if (active) exitReadingMode();
    else enterReadingMode();
  });

  el.readingModeExit.addEventListener("click", exitReadingMode);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.getAttribute("data-reading-mode") === "true") {
      exitReadingMode();
    }
  });

  /* ------------------------------------------------------------------
     9g. UTILITAIRE — throttle
     ------------------------------------------------------------------ */

  function throttle(fn, wait) {
    let lastCall = 0;
    let timeout = null;
    return (...args) => {
      const now = Date.now();
      const remaining = wait - (now - lastCall);
      if (remaining <= 0) {
        lastCall = now;
        fn(...args);
      } else {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          lastCall = Date.now();
          fn(...args);
        }, remaining);
      }
    };
  }

  // Écouteur de scroll global : progress bar + bouton remonter
  window.addEventListener(
    "scroll",
    throttle(() => {
      updateReadProgress();
      updateScrollTopVisibility();
    }, 50),
    { passive: true }
  );

  /* ------------------------------------------------------------------
     10. LIGHTBOX IMAGE
     ------------------------------------------------------------------ */

  function openLightbox(src, alt) {
    el.lightboxImg.src = src;
    el.lightboxImg.alt = alt || "";
    el.lightbox.setAttribute("data-open", "true");
    el.lightboxClose.focus();
    document.body.style.overflow = "hidden";
  }

  function closeLightbox() {
    el.lightbox.setAttribute("data-open", "false");
    el.lightboxImg.src = "";
    document.body.style.overflow = "";
  }

  el.lightboxClose.addEventListener("click", closeLightbox);
  el.lightbox.addEventListener("click", (e) => {
    if (e.target === el.lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.lightbox.getAttribute("data-open") === "true") closeLightbox();
  });

  el.studyBody.addEventListener("click", (e) => {
    const img = e.target.closest("figure img, .study-body > img");
    if (img) openLightbox(img.src, img.alt);
  });

  /* ------------------------------------------------------------------
     11. THÈME (clair / sombre / système), persistance locale
     ------------------------------------------------------------------ */

  const THEME_KEY = "publication-theme";
  const themeIcons = {
    light: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
    dark: `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`,
    system: `<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>`,
  };

  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    document.getElementById("theme-icon").innerHTML = themeIcons[mode] || themeIcons.system;
    document.querySelectorAll(".theme-menu__option").forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.themeChoice === mode));
    });
    // Bascule des thèmes de coloration syntaxique clair/sombre
    const isDark =
      mode === "dark" ||
      (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.getElementById("hljs-theme-dark").disabled = !isDark;
    document.getElementById("hljs-theme-light").disabled = isDark;
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || "system";
    applyTheme(saved);

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if ((localStorage.getItem(THEME_KEY) || "system") === "system") applyTheme("system");
    });

    const toggle = document.getElementById("theme-toggle");
    const panel = document.getElementById("theme-panel");

    toggle.addEventListener("click", () => {
      const open = panel.getAttribute("data-open") === "true";
      panel.setAttribute("data-open", String(!open));
      toggle.setAttribute("aria-expanded", String(!open));
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".theme-menu")) {
        panel.setAttribute("data-open", "false");
        toggle.setAttribute("aria-expanded", "false");
      }
    });

    document.querySelectorAll(".theme-menu__option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.themeChoice;
        localStorage.setItem(THEME_KEY, mode);
        applyTheme(mode);
        panel.setAttribute("data-open", "false");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ------------------------------------------------------------------
     12. GÉNÉRATION / TÉLÉCHARGEMENT PDF
     ------------------------------------------------------------------
     Génération côté navigateur (html2pdf.js / html2canvas + jsPDF).
     Reconstruit un document isolé (titre, auteur, date, catégorie,
     contenu complet avec images/tableaux/équations déjà rendues) pour
     un résultat propre et imprimable, indépendant du thème actif.
  */

  function buildPdfDocument(study) {
    const container = document.createElement("div");
    container.style.cssText = "font-family: Georgia, 'Times New Roman', serif; color:#111; max-width: 720px; padding: 8px;";

    const dateLabel = formatDate(study.date);
    const updatedLabel = formatDate(study.updated);

    const header = document.createElement("div");
    header.style.marginBottom = "24px";
    header.innerHTML = `
      ${study.category ? `<div style="font-family: monospace; font-size:11px; letter-spacing:.05em; text-transform:uppercase; color:#555; margin-bottom:10px;">${escapeHtml(study.category)}</div>` : ""}
      <h1 style="font-size:26px; line-height:1.25; margin:0 0 10px;">${escapeHtml(study.title)}</h1>
      <div style="font-size:12px; color:#444; margin-bottom:10px;">
        ${escapeHtml(study.author)}${dateLabel ? ` · ${escapeHtml(dateLabel)}` : ""}
        ${updatedLabel ? ` · Modifié le ${escapeHtml(updatedLabel)}` : ""}
      </div>
      ${study.description ? `<p style="font-size:14px; color:#333; font-style:italic;">${escapeHtml(study.description)}</p>` : ""}
      <hr style="border:none; border-top:1px solid #ccc; margin-top:18px;">
    `;
    container.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = "font-size:14px; line-height:1.7;";
    body.innerHTML = study.html;
    // Neutraliser les styles d'arrière-plan sombre éventuels pour l'impression
    body.querySelectorAll("pre, code").forEach((elm) => {
      elm.style.background = "#f4f4f4";
      elm.style.color = "#111";
    });
    body.querySelectorAll("table").forEach((t) => {
      t.style.width = "100%";
      t.style.borderCollapse = "collapse";
    });
    body.querySelectorAll("th, td").forEach((c) => {
      c.style.border = "1px solid #ccc";
      c.style.padding = "6px 8px";
    });
    body.querySelectorAll("img").forEach((img) => {
      img.style.maxWidth = "100%";
    });
    container.appendChild(body);

    return container;
  }

  async function downloadStudyAsPdf(study) {
    const btn = el.btnDownloadPdf;
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "Génération du PDF…";

    try {
      const doc = buildPdfDocument(study);
      // Élément hors-écran pour le rendu (nécessaire pour html2canvas)
      doc.style.position = "fixed";
      doc.style.left = "-9999px";
      doc.style.top = "0";
      document.body.appendChild(doc);

      await window
        .html2pdf()
        .set({
          margin: [14, 14, 16, 14],
          filename: `${study.slug}.pdf`,
          image: { type: "jpeg", quality: 0.96 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css", "legacy"] },
        })
        .from(doc)
        .save();

      document.body.removeChild(doc);
    } catch (err) {
      console.error("Échec de la génération PDF :", err);
      // Repli : impression navigateur standard, propre grâce aux règles @media print
      window.print();
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
  }

  el.btnDownloadPdf.addEventListener("click", () => {
    const slug = el.studyBody.dataset.slug;
    const study = store.studies.find((s) => s.slug === slug);
    if (study) downloadStudyAsPdf(study);
  });

  /* ------------------------------------------------------------------
     13. ROUTAGE (hash-based, compatible hébergement statique simple)
     ------------------------------------------------------------------ */

  function showView(name) {
    el.viewList.hidden = name !== "list";
    el.viewStudy.hidden = name !== "study";
    el.viewNotFound.hidden = name !== "notfound";
    el.readingModeToggle.hidden = name !== "study";
    if (name !== "study") {
      exitReadingMode();
      el.readProgressBar.style.width = "0%";
    }
    const active = name === "list" ? el.viewList : name === "study" ? el.viewStudy : el.viewNotFound;
    active.classList.remove("fade-in");
    // force reflow pour rejouer l'animation
    void active.offsetWidth;
    active.classList.add("fade-in");
  }

  function handleRoute() {
    const hash = window.location.hash || "#/";
    const studyMatch = hash.match(/^#\/etude\/([^/]+)\/?$/);

    if (studyMatch) {
      const slug = decodeURIComponent(studyMatch[1]);
      renderStudy(slug);
      return;
    }

    document.title = "Publication — Bibliothèque d'études";
    renderList();
    showView("list");
  }

  window.addEventListener("hashchange", handleRoute);

  /* ------------------------------------------------------------------
     14. RECHERCHE — écouteurs UI
     ------------------------------------------------------------------ */

  let searchDebounce = null;
  el.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      uiState.query = el.searchInput.value;
      renderList();
    }, 80);
  });

  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = "";
    uiState.query = "";
    renderList();
    el.searchInput.focus();
  });

  /* ------------------------------------------------------------------
     15. INITIALISATION
     ------------------------------------------------------------------ */

  async function init() {
    initTheme();
    el.footerYear.textContent = new Date().getFullYear();

    // État de chargement (squelettes) pendant la découverte des études
    el.viewList.hidden = false;
    el.studyList.innerHTML = Array.from({ length: 4 })
      .map(() => '<li class="skeleton-item"></li>')
      .join("");

    await buildCatalog();
    renderFilterChips();
    handleRoute();

    if (!store.studies.length) {
      showManifestWarning();
    }
  }

  function showManifestWarning() {
    // Ne s'affiche que sur la vue liste, et seulement si aucune étude n'a
    // pu être chargée — aide au diagnostic sans ouvrir la console.
    if (el.viewList.hidden) return;
    el.studyList.innerHTML = `
      <li class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>
        <p>Aucune étude chargée</p>
        <p>
          Vérifiez que <code>etude/index.json</code> existe, qu'il liste bien
          les noms de fichiers .md publiés, et ouvrez la console du
          navigateur (F12) pour le détail de l'erreur.
        </p>
      </li>
    `;
  }

  init();
})();
