/*
 * efs-collectes-card – carte Lovelace pour l’intégration efs_dondesang (dépôt HomeAssistant_DonduSang_Card).
 * Trois vues (synthèse, agenda, carte + remplissage), entièrement paramétrables depuis l’éditeur visuel.
 *
 * Deux sources de données :
 *  - une instance de l'intégration (entité choisie, réglages de l'instance) ;
 *  - une recherche propre à la carte, dès qu'un code postal est indiqué (action
 *    efs_dondesang.rechercher_collectes, intégration 1.4.0 ou plus).
 *
 *   type: custom:efs-collectes-card
 *   entity: sensor.efs_caen_collectes_a_venir   # n'importe quelle entité de l'instance (défaut : 1re instance)
 *   # --- recherche propre à la carte (remplace l'instance) ---
 *   code_postal: "14760"   commune_depart: Bretteville-sur-Odon   # commune : si le code postal en couvre plusieurs
 *   rayon_km: 10           type_don: sang | plasma | plaquettes
 *   jours: 30              # recherche : nombre de jours couverts ; instance : filtre sur l'horizon
 *   inclure_professionnelles: false   actualisation: 30 (minutes)
 *   afficher_formulaire: true          # champs de recherche modifiables directement dans la carte
 *   vue: synthese | agenda | carte | complet
 *   commune: CAEN        # synthèse : prochaine collecte dans cette commune (défaut : auto = la plus proche dans le temps)
 *   titre: "Don du sang – Caen"
 *   filtre: toutes | rdv_ouverts
 *   distance_max: 5      max: 6
 *   couleur: "#B42318"  (ou [180, 35, 24])
 *   afficher_entete / afficher_adresse / afficher_boutons / afficher_pied /
 *   afficher_plan / afficher_jauge / afficher_remplissage : true | false
 */
(() => {
  const VERSION = "1.3.0";
  const DOMAIN = "efs_dondesang";
  const TZ_FALLBACK = "Europe/Paris";
  const DON = { sang: "Sang total", plasma: "Plasma", plaquettes: "Plaquettes" };
  const ST = { OUVERT: "Planning ouvert", NON: "Planning non ouvert", COMPLET: "Complet" };
  const VUES = ["synthese", "agenda", "carte", "complet"];
  const AFFICHAGES = [
    "afficher_entete", "afficher_adresse", "afficher_boutons", "afficher_pied",
    "afficher_plan", "afficher_jauge", "afficher_remplissage",
  ];
  const COMMUNE_AUTO = "auto";
  const DEFAULTS = {
    vue: "complet", commune: COMMUNE_AUTO, max: 6, filtre: "toutes",
    ...Object.fromEntries(AFFICHAGES.map((k) => [k, true])),
    // Recherche propre à la carte (utilisée seulement si un code postal est indiqué
    // ou si le formulaire est affiché)
    rayon_km: 10, type_don: "sang", inclure_professionnelles: false, afficher_formulaire: false, actualisation: 30,
  };
  const SERVICE = "rechercher_collectes";
  const JOURS_RECHERCHE = 30;       // nombre de jours par défaut d'une recherche
  const MAX_RECHERCHE = 50;         // collectes demandées (la vue synthèse peut viser une commune lointaine)
  const BORNES = { rayon_km: [1, 50], jours: [1, 180] };
  const CP_RE = /^\d{5}$/;
  const borne = (v, [min, max], def) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, Math.round(n))) : def;
  };

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => {
    if (typeof u !== "string" || !u.trim()) return null;
    const v = u.trim();
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
    return "https://" + v.replace(/^\/\//, "");
  };
  const num = (v) => (v === null || v === undefined || v === "" || v === "unknown" || v === "unavailable" || isNaN(Number(v)) ? null : Number(v));
  const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
  const km = (v) => (v === null || v === undefined ? "" : `${nf.format(v)} km`);
  const pct = (v) => `${Math.round(v)} %`;
  const titre = (s) => String(s || "").toLowerCase()
    .replace(/(^|[\s\-'’(])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
  /** Clé de comparaison d'un nom de commune : « Bretteville-l’Orgueilleuse » = « BRETTEVILLE L ORGUEILLEUSE ». */
  const cle = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const horaires = (h) => String(h || "").replace(/-/g, " – ").replace(/ \/ /g, " · ");

  function couleur(c) {
    if (Array.isArray(c) && c.length === 3 && c.every((n) => Number.isFinite(Number(n)))) {
      return `rgb(${c.map((n) => Math.max(0, Math.min(255, Math.round(n)))).join(",")})`;
    }
    return typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null;
  }
  function statutDe(restantes) {
    if (restantes === null) return ST.NON;
    return restantes <= 0 ? ST.COMPLET : ST.OUVERT;
  }
  function chip(statut) {
    if (statut === ST.COMPLET) return `<span class="chip full">Complet</span>`;
    if (statut === ST.NON) return `<span class="chip neutral">Planning non ouvert</span>`;
    return `<span class="chip ok">Planning ouvert</span>`;
  }

  /** Entités d'une instance de l'intégration, retrouvées par l'appareil commun. */
  function resolveInstance(hass, cfg) {
    const reg = hass.entities || {};
    const states = hass.states || {};
    const efs = Object.values(reg).filter((e) => e.platform === DOMAIN);
    const isAgenda = (id) => Array.isArray(states[id]?.attributes?.collectes);
    const isNext = (id) => states[id]?.attributes?.type_don !== undefined && !isAgenda(id);

    let device = cfg.entity ? reg[cfg.entity]?.device_id : undefined;
    if (!device && !cfg.entity) {
      device = efs.find((e) => e.translation_key === "collectes_a_venir")?.device_id;
    }
    const sibling = (tk) => efs.find((e) => e.device_id === device && e.translation_key === tk)?.entity_id;

    let agenda = cfg.agenda_entity || (device && sibling("collectes_a_venir"));
    let next = device && sibling("prochaine_collecte");
    if (cfg.entity && !agenda && isAgenda(cfg.entity)) agenda = cfg.entity;
    if (cfg.entity && !next && isNext(cfg.entity)) next = cfg.entity;
    // Repli sans registre (anciennes versions du frontend) : recherche par attributs,
    // uniquement si aucune entité n'a été désignée (une entité inconnue est signalée).
    if (!agenda && !cfg.entity) {
      agenda = Object.keys(states).find((id) => id.startsWith("sensor.") && isAgenda(id) && states[id].attributes.centre !== undefined);
    }
    if (!next && !cfg.entity) next = "sensor.efs_prochaine_collecte";
    return { agenda, next };
  }

  const ICON_DROP = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.7c3.6 4.6 6 8 6 11.3a6 6 0 0 1-12 0c0-3.3 2.4-6.7 6-11.3z"/></svg>`;
  const ICON_PIN = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;

  const STYLE = `
    :host{--efs-accent:#B42318;--efs-accent-text:var(--efs-accent);--efs-accent-soft:rgba(180,35,24,.12);--efs-ok:#0B6E4F;--efs-ok-soft:rgba(11,110,79,.13);
      --efs-text:var(--primary-text-color,#1C1F24);--efs-muted:var(--secondary-text-color,#5A6170);
      --efs-line:var(--divider-color,rgba(0,0,0,.12));--efs-soft:var(--secondary-background-color,#F6F7F9);
      --efs-chip:rgba(127,127,127,.16);--efs-map:rgba(127,140,133,.16);--efs-grid:rgba(127,140,133,.28)}
    ha-card.dark{--efs-accent-text:#FF8A78;--efs-ok:#5FD3A6;--efs-ok-soft:rgba(95,211,166,.16);--efs-accent-soft:rgba(240,100,79,.18)}
    ha-card.custom{--efs-accent-text:var(--efs-accent)}
    ha-card{padding:16px;color:var(--efs-text);display:flex;flex-direction:column;gap:20px}
    .titre{font-size:20px;font-weight:700;margin:0}
    .bloc{display:flex;flex-direction:column;gap:16px}
    .bloc+.bloc{border-top:1px solid var(--efs-line);padding-top:20px}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .left{justify-content:flex-start}
    .muted{color:var(--efs-muted)}
    .small{font-size:13px}.xs{font-size:12px}
    .h{font-size:17px;font-weight:600}
    .icon{width:36px;height:36px;border-radius:10px;background:var(--efs-accent-soft);color:var(--efs-accent-text);display:flex;align-items:center;justify-content:center;flex:none}
    .chip{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap;display:inline-block}
    .chip.neutral{background:var(--efs-chip);color:var(--efs-muted)}
    .chip.ok{background:var(--efs-ok-soft);color:var(--efs-ok)}
    .chip.full{background:var(--efs-accent-soft);color:var(--efs-accent-text)}
    .kicker{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--efs-muted)}
    .date{font-size:28px;font-weight:700;line-height:1.15;margin:2px 0}
    .place{display:flex;gap:12px;padding:12px 14px;background:var(--efs-soft);border-radius:12px}
    .place svg{flex:none;margin-top:2px;color:var(--efs-muted)}
    .big{font-size:38px;font-weight:700;line-height:1}
    .bar{height:10px;background:var(--efs-chip);border-radius:999px;overflow:hidden}
    .bar.main{margin:10px 0 8px}
    .bar>span{display:block;height:100%;background:var(--efs-accent);border-radius:999px}
    .btns{display:flex;gap:10px;flex-wrap:wrap}
    .btn{min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:0 16px;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none;box-sizing:border-box}
    .btn.primary{flex:1;background:var(--efs-accent);color:#fff}
    .btn.secondary{border:1px solid var(--efs-line);color:var(--efs-text)}
    .btn.block{flex:1}
    .foot{border-top:1px solid var(--efs-line);padding-top:10px}
    ul{list-style:none;margin:0;padding:0}
    .agenda li{display:flex;align-items:center;gap:14px;padding:10px 0;border-top:1px solid var(--efs-line)}
    .agenda li:first-child{border-top:0;padding-top:0}
    .d{width:54px;flex:none;text-align:center;padding:5px 0;border-radius:10px;background:var(--efs-soft)}
    .d small{display:block;font-size:11px;font-weight:600;text-transform:uppercase;color:var(--efs-muted)}
    .d strong{display:block;font-size:21px;line-height:1.1}
    .d em{display:block;font-style:normal;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--efs-accent-text)}
    .who{flex:1;min-width:0}
    .who b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .who span{display:block;font-size:13px;color:var(--efs-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .st{width:120px;flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:5px;font-size:14px;font-weight:600}
    .st .bar{width:100%;height:6px}
    .st a{font-size:12px;color:var(--efs-accent-text);text-decoration:none}
    svg.map{display:block;width:100%;height:auto;border-radius:12px}
    .map-bg{fill:var(--efs-map)}.map-grid{stroke:var(--efs-grid);stroke-width:1}
    .map-circle{fill:var(--efs-accent);fill-opacity:.06;stroke:var(--efs-accent);stroke-width:1.5;stroke-dasharray:6 6}
    .map-home{fill:var(--efs-text)}.map-roof{fill:var(--ha-card-background,var(--card-background-color,#fff))}
    .mk-open{fill:var(--efs-accent);stroke:var(--ha-card-background,var(--card-background-color,#fff));stroke-width:2}
    .mk-closed{fill:var(--ha-card-background,var(--card-background-color,#fff));stroke:var(--efs-accent);stroke-width:2.5}
    .mk-full{fill:var(--efs-muted);stroke:var(--ha-card-background,var(--card-background-color,#fff));stroke-width:2}
    .map-label{font-size:12px;font-weight:600;fill:var(--efs-text)}
    .map-small{font-size:12px;fill:var(--efs-muted)}
    .legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--efs-muted)}
    .legend span{display:inline-flex;align-items:center;gap:6px}
    .legend svg{flex:none}
    .duo{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;align-items:start}
    svg.gauge{display:block;width:100%;max-width:240px;margin:4px auto 0}
    .gauge-bg{fill:none;stroke:var(--efs-chip);stroke-width:16;stroke-linecap:round}
    .gauge-fg{fill:none;stroke:var(--efs-accent);stroke-width:16;stroke-linecap:round}
    .g-strong{fill:var(--efs-text);font-weight:700}.g-muted{fill:var(--efs-muted)}
    .fill li{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;font-size:13px}
    .fill .bar{height:8px}
    .empty{color:var(--efs-muted);text-align:center;padding:12px}
    .warn{font-size:12px;color:var(--efs-muted)}
    form.search{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;align-items:end;padding:12px;background:var(--efs-soft);border-radius:12px}
    form.search label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600;color:var(--efs-muted)}
    form.search input,form.search select{font:inherit;font-size:15px;color:var(--efs-text);background:var(--ha-card-background,var(--card-background-color,#fff));border:1px solid var(--efs-line);border-radius:8px;padding:8px 10px;min-height:40px;box-sizing:border-box;width:100%}
    form.search input[aria-invalid="true"]{border-color:var(--efs-accent)}
    form.search button{min-height:40px;border:0;border-radius:8px;background:var(--efs-accent);color:#fff;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
    form.search button:disabled{opacity:.6;cursor:progress}
    form.search .full{grid-column:1/-1}
    .status{font-size:12px;color:var(--efs-muted)}
    .status.err{color:var(--efs-accent-text)}
  `;

  class EfsCollectesCard extends HTMLElement {
    static getConfigElement() {
      return document.createElement("efs-collectes-card-editor");
    }

    static getStubConfig(hass) {
      const { agenda } = resolveInstance(hass || { states: {} }, {});
      return { vue: "complet", ...(agenda ? { entity: agenda } : {}) };
    }

    setConfig(config) {
      if (config.vue && !VUES.includes(config.vue)) throw new Error(`vue doit valoir : ${VUES.join(", ")}`);
      if (config.type_don && !(config.type_don in DON)) throw new Error(`type_don doit valoir : ${Object.keys(DON).join(", ")}`);
      this._config = { ...DEFAULTS, ...config };
      this._ids = null;
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this._sig = null;
      this._formSig = null;
      // Paramètres de recherche : ceux de la configuration, que le formulaire peut ensuite modifier.
      const params = this._paramsFromConfig();
      if (JSON.stringify(params) !== JSON.stringify(this._cfgParams)) {
        this._cfgParams = params;
        this._params = { ...params };
        this._res = null;
        this._err = null;
        this._scheduleSearch(0);
      }
      this._startTimer();
      if (this._hass) this._render();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (this._isSearch()) {
        // En mode recherche, les états des entités n'influencent pas l'affichage.
        if (first) this._scheduleSearch(0);
        const sig = `R|${new Date().getDate()}|${hass.themes?.darkMode}`;
        if (sig !== this._sig) {
          this._sig = sig;
          this._render();
        }
        return;
      }
      if (!this._ids || this._entsRef !== hass.entities) {
        this._ids = resolveInstance(hass, this._config || {});
        this._entsRef = hass.entities;
      }
      const a = hass.states[this._ids.next];
      const b = hass.states[this._ids.agenda];
      const sig = `${a?.last_updated}|${b?.last_updated}|${new Date().getDate()}|${hass.themes?.darkMode}`;
      if (sig !== this._sig) {
        this._sig = sig;
        this._render();
      }
    }

    connectedCallback() {
      this._startTimer();
      // Retour sur l'onglet après une longue absence : données relancées si périmées.
      if (this._isSearch() && this._res && Date.now() - (this._resAt || 0) > this._periode()) this._scheduleSearch(0);
    }

    disconnectedCallback() {
      clearInterval(this._timer);
      this._timer = null;
      clearTimeout(this._debounce);
    }

    // ------------------------------------------------------------- recherche
    /** Mode recherche : un code postal est configuré, ou le formulaire est affiché. */
    _isSearch() {
      const c = this._config || {};
      return Boolean(c.code_postal || c.afficher_formulaire);
    }

    _paramsFromConfig() {
      const c = this._config;
      return {
        // Un code postal écrit sans guillemets en YAML (01000) arrive sous forme de nombre (1000).
        code_postal: typeof c.code_postal === "number" ? String(c.code_postal).padStart(5, "0") : String(c.code_postal ?? "").replace(/\s/g, ""),
        commune: c.commune_depart || "",
        rayon_km: borne(c.rayon_km, BORNES.rayon_km, DEFAULTS.rayon_km),
        type_don: c.type_don in DON ? c.type_don : DEFAULTS.type_don,
        jours: borne(c.jours, BORNES.jours, JOURS_RECHERCHE),
        inclure_professionnelles: Boolean(c.inclure_professionnelles),
      };
    }

    _periode() {
      return Math.max(5, Number(this._config?.actualisation) || DEFAULTS.actualisation) * 60e3;
    }

    _startTimer() {
      clearInterval(this._timer);
      this._timer = null;
      if (!this._isSearch() || !this.isConnected) return;
      this._timer = setInterval(() => this._search(), this._periode());
    }

    _scheduleSearch(delay = 400) {
      if (!this._isSearch()) return;
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this._search(), delay);
    }

    async _search() {
      const p = this._params;
      if (!this._hass || !p || !CP_RE.test(p.code_postal)) {
        if (this._hass) this._render();
        return;
      }
      const seq = (this._seq = (this._seq || 0) + 1);
      this._loading = true;
      this._render();
      const data = {
        code_postal: p.code_postal,
        rayon_km: p.rayon_km,
        type_don: p.type_don,
        jours: p.jours,
        inclure_professionnelles: p.inclure_professionnelles,
        max_collectes: MAX_RECHERCHE,
      };
      if (p.commune) data.commune = p.commune;
      try {
        const res = await this._hass.callWS({
          type: "call_service", domain: DOMAIN, service: SERVICE, service_data: data, return_response: true,
        });
        if (seq !== this._seq) return; // une recherche plus récente a été lancée
        this._res = res?.response || null;
        this._resAt = Date.now();
        this._err = null;
        // La commune retenue devient le choix courant (liste déroulante du formulaire).
        if (this._res?.centre?.code_insee && (this._res.communes || []).length > 1) {
          this._params.commune = this._res.centre.code_insee;
        }
      } catch (e) {
        if (seq !== this._seq) return;
        this._res = null; // pas de résultats d'une recherche précédente sous le message d'erreur
        const code = e?.code || e?.error?.code;
        this._err = code === "service_not_found" || code === "not_found"
          ? "Recherche indisponible : mettez l’intégration EFS en version 1.4.0 ou plus (au moins une instance installée), puis redémarrez Home Assistant."
          : `Recherche impossible : ${e?.message || e?.error?.message || e}`;
      } finally {
        if (seq === this._seq) {
          this._loading = false;
          this._render();
        }
      }
    }

    /** Formulaire de recherche affiché en tête de carte (afficher_formulaire: true). */
    _formHtml() {
      const p = this._params;
      const communes = this._res?.centre?.code_postal === p.code_postal ? this._res.communes || [] : [];
      const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(l)}</option>`;
      const choixCommune = communes.length > 1
        ? `<label class="full">Commune de départ<select name="commune">${communes.map((c) =>
            opt(c.code, c.nom, c.code === p.commune || cle(c.nom) === cle(p.commune))).join("")}</select></label>`
        : "";
      const invalide = p.code_postal && !CP_RE.test(p.code_postal);
      return `<form class="search" novalidate>
        <label>Code postal<input name="code_postal" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="14000"
          value="${esc(p.code_postal)}" aria-invalid="${invalide}"></label>
        <label>Rayon (km)<input name="rayon_km" type="number" min="${BORNES.rayon_km[0]}" max="${BORNES.rayon_km[1]}" value="${esc(p.rayon_km)}"></label>
        <label>Type de collecte<select name="type_don">${Object.entries(DON).map(([k, l]) => opt(k, l, k === p.type_don)).join("")}</select></label>
        <label>Jours<input name="jours" type="number" min="${BORNES.jours[0]}" max="${BORNES.jours[1]}" value="${esc(p.jours)}"></label>
        <button type="submit"${this._loading ? " disabled" : ""}>${this._loading ? "Recherche…" : "Rechercher"}</button>
        ${choixCommune}
      </form>`;
    }

    _bindForm(form) {
      const lire = () => {
        const v = Object.fromEntries(new FormData(form).entries());
        const cp = String(v.code_postal || "").replace(/\s/g, "");
        const autreCp = cp !== this._params.code_postal;
        this._params = {
          ...this._params,
          code_postal: cp,
          // Nouveau code postal : la commune précédente ne s'y applique plus.
          commune: autreCp ? "" : v.commune ?? this._params.commune,
          rayon_km: borne(v.rayon_km, BORNES.rayon_km, this._params.rayon_km),
          type_don: v.type_don in DON ? v.type_don : this._params.type_don,
          jours: borne(v.jours, BORNES.jours, this._params.jours),
        };
        form.code_postal.setAttribute("aria-invalid", String(Boolean(cp) && !CP_RE.test(cp)));
        return CP_RE.test(cp);
      };
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        if (lire()) this._scheduleSearch(0);
        else this._render();
      });
      // Listes déroulantes et champs numériques : recherche dès la validation du champ.
      // Sortie d'un champ : on rattrape un rafraîchissement du formulaire différé pendant la saisie.
      form.addEventListener("focusout", () => setTimeout(() => this._render(), 0));
      form.addEventListener("change", (ev) => {
        if (ev.target.name === "code_postal" && !CP_RE.test(ev.target.value.replace(/\s/g, ""))) return;
        if (lire()) this._scheduleSearch(250);
      });
    }

    getCardSize() {
      return { synthese: 6, agenda: 7, carte: 9 }[this._config?.vue] || 20;
    }

    getGridOptions() {
      return { columns: 12, min_columns: 6 };
    }

    // ------------------------------------------------------------- données
    _data() {
      const hass = this._hass;
      const cfg = this._config;
      const tz = hass.config?.time_zone || TZ_FALLBACK;
      const search = this._isSearch();
      let next, ag, A, G;
      if (search) {
        // Réponse de l'action, au même format que les attributs du capteur « collectes à venir ».
        G = this._res || {};
        A = { type_don: G.type_don, derniere_mise_a_jour: G.derniere_mise_a_jour, api_disponible: G.api_disponible };
        next = ag = this._res ? { attributes: G } : null;
      } else {
        if (!this._ids) this._ids = resolveInstance(hass, cfg);
        next = hass.states[this._ids.next];
        ag = hass.states[this._ids.agenda];
        A = next?.attributes || {};
        G = ag?.attributes || {};
      }
      const now = Date.now();
      const toutes = (G.collectes || []).map((c) => {
        const restantes = num(c.places_restantes);
        return {
          ...c,
          debutDate: new Date(c.debut),
          places_restantes: restantes,
          places_totales: num(c.places_totales),
          places_reservees: num(c.places_reservees),
          distance: num(c.distance),
          taux: num(c.taux_remplissage),
          statut: c.statut || statutDe(restantes),
        };
      });
      // En recherche, le nombre de jours est déjà appliqué par l'intégration.
      const jours = search ? null : num(cfg.jours);
      const dmax = num(cfg.distance_max);
      const list = toutes.filter((c) =>
        (cfg.filtre !== "rdv_ouverts" || c.statut === ST.OUVERT)
        && (!jours || c.debutDate - now <= jours * 864e5)
        && (!dmax || c.distance === null || c.distance <= dmax));
      return {
        tz, next, ag, A, G, list, toutes, search,
        total: search ? num(G.nombre) ?? toutes.length : toutes.length,
        filtre_actif: list.length !== toutes.length,
        rayon: dmax || num(G.rayon_km) || 10,
        jours: search ? G.horizon_jours : cfg.jours || G.horizon_jours,
      };
    }

    _fmt(tz) {
      return {
        long: new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }),
        wd: new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "short" }),
        day: new Intl.DateTimeFormat("fr-FR", { timeZone: tz, day: "numeric" }),
        mon: new Intl.DateTimeFormat("fr-FR", { timeZone: tz, month: "short" }),
        short: new Intl.DateTimeFormat("fr-FR", { timeZone: tz, day: "2-digit", month: "2-digit" }),
        time: new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }),
        ymd: new Intl.DateTimeFormat("en-CA", { timeZone: tz }),
      };
    }

    _days(date, f) {
      const a = Date.parse(f.ymd.format(new Date()) + "T12:00:00Z");
      const b = Date.parse(f.ymd.format(date) + "T12:00:00Z");
      const n = Math.round((b - a) / 864e5);
      return n <= 0 ? "aujourd’hui" : n === 1 ? "demain" : `dans ${n} jours`;
    }

    _vide(d) {
      const c = this._config;
      if (d.filtre_actif) return "Aucune collecte ne correspond aux filtres de la carte.";
      const autour = d.search && d.G.centre?.libelle ? ` de ${esc(titre(d.G.centre.libelle))}` : "";
      const type = d.search ? ` (${esc((DON[d.G.type_don] || "").toLowerCase())})` : "";
      return `Aucune collecte${type} dans les ${esc(d.jours || "")} prochains jours à moins de ${esc(d.rayon)} km${autour}.`;
    }

    // -------------------------------------------------------------- rendu
    _render() {
      if (!this._config || !this._hass || !this.shadowRoot) return;
      const cfg = this._config;
      const d = this._data();
      let body;
      if (d.search && !d.ag) {
        const p = this._params || {};
        body = this._err ? ""
          : this._loading ? `<div class="empty">Recherche des collectes…</div>`
          : !p.code_postal ? `<div class="empty">Saisissez un code postal pour rechercher les collectes.</div>`
          : !CP_RE.test(p.code_postal) ? `<div class="empty">Le code postal doit comporter 5 chiffres.</div>`
          : `<div class="empty">Recherche des collectes…</div>`;
      } else if (!d.ag) {
        body = `<div class="empty">Aucune instance de l’intégration EFS trouvée${cfg.entity ? ` pour ${esc(cfg.entity)}` : ""}.<br>Vérifiez que l’intégration est installée, puis choisissez l’instance dans l’éditeur de la carte.</div>`;
      } else {
        const f = this._fmt(d.tz);
        const parts = [];
        const v = cfg.vue;
        if (v === "synthese" || v === "complet") parts.push(this._synthese(d, f));
        if (v === "agenda" || v === "complet") parts.push(this._agenda(d, f));
        if (v === "carte" || v === "complet") {
          const carte = this._carte(d, f);
          if (carte) parts.push(carte);
        }
        body = parts.map((p) => `<section class="bloc">${p}</section>`).join("");
      }
      const head = cfg.titre ? `<h2 class="titre">${esc(cfg.titre)}</h2>` : "";
      const accent = couleur(cfg.couleur);
      const classes = [this._hass.themes?.darkMode ? "dark" : "", accent ? "custom" : ""].join(" ").trim();
      const style = accent ? `--efs-accent:${accent};--efs-accent-soft:color-mix(in srgb, ${accent} 16%, transparent);` : "";

      // Squelette posé une fois : le formulaire n'est pas redessiné à chaque mise à jour,
      // pour ne pas perdre la saisie ni le focus.
      let card = this.shadowRoot.querySelector("ha-card");
      if (!card) {
        this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><div id="head"></div><div id="form"></div><div id="status"></div><div id="body"></div></ha-card>`;
        card = this.shadowRoot.querySelector("ha-card");
      }
      card.className = classes;
      card.setAttribute("style", style);
      const zone = (id, html) => {
        const el = card.querySelector(`#${id}`);
        el.style.display = html ? "contents" : "none";
        if (el._html !== html) { el.innerHTML = html; el._html = html; }
        return el;
      };
      zone("head", head);

      const formulaire = d.search && cfg.afficher_formulaire;
      const formHtml = formulaire ? this._formHtml() : "";
      const formSig = formulaire ? JSON.stringify([this._params, this._loading, this._res?.communes, this._res?.centre?.code_postal]) : "";
      const zf = card.querySelector("#form");
      const actif = this.shadowRoot.activeElement;
      const saisie = actif && zf.contains(actif) && actif.tagName === "INPUT";
      if (formSig !== this._formSig && !saisie) {
        this._formSig = formSig;
        zone("form", formHtml);
        const form = zf.querySelector("form");
        if (form) this._bindForm(form);
      } else if (!formulaire) {
        zone("form", "");
      } else {
        // Champ en cours de saisie : seul l'état du bouton est mis à jour.
        const btn = zf.querySelector("button");
        if (btn) { btn.disabled = !!this._loading; btn.textContent = this._loading ? "Recherche…" : "Rechercher"; }
      }

      let status = "";
      if (d.search && this._err) status = `<div class="status err" role="alert">${esc(this._err)}</div>`;
      else if (d.search && this._res?.centre && formulaire) {
        const c = this._res.centre;
        status = `<div class="status">Autour de ${esc(titre(c.libelle))}${c.code_postal ? ` (${esc(c.code_postal)})` : ""} · ${esc(this._res.rayon_km)} km · ${esc((DON[this._res.type_don] || "").toLowerCase())} · ${esc(this._res.horizon_jours)} jours${this._loading ? " · actualisation…" : ""}</div>`;
      }
      zone("status", status);
      zone("body", body);
    }

    _synthese(d, f) {
      const cfg = this._config;
      const A = d.A;
      const don = DON[A.type_don] || DON[d.G.type_don] || "Don du sang";
      const entete = cfg.afficher_entete
        ? `<div class="row"><div class="row left"><div class="icon">${ICON_DROP}</div><span class="h">Don du sang</span></div><span class="chip neutral">${esc(don)}</span></div>`
        : "";
      const now = Date.now();
      const aVenir = d.list.filter((x) => {
        const fin = x.fin ? new Date(x.fin) : new Date(x.debutDate.getTime() + 4 * 3600e3);
        return fin > now;
      });
      // Par défaut, la prochaine collecte du calendrier ; sinon la prochaine dans la commune choisie.
      const voulue = cfg.commune && cfg.commune !== COMMUNE_AUTO ? cfg.commune : null;
      const dansCommune = voulue ? aVenir.find((x) => cle(x.commune || x.lieu) === cle(voulue)) : null;
      const c = dansCommune || aVenir[0] || d.list[0];
      if (!c) return `${entete}<div class="empty">${this._vide(d)}</div>`;
      const remplacee = voulue && !dansCommune
        ? `<div class="muted small">Aucune collecte à venir à ${esc(titre(voulue))} ${d.filtre_actif ? "qui corresponde aux filtres de la carte" : "dans la liste reçue"} : prochaine collecte affichée.</div>`
        : "";

      const lien = c.statut === ST.OUVERT ? safeUrl(c.lien_rdv) : null;
      const centre = d.G.centre;
      const iti = centre && c.latitude !== undefined
        ? `https://www.openstreetmap.org/directions?route=${centre.latitude}%2C${centre.longitude}%3B${c.latitude}%2C${c.longitude}`
        : null;
      const autres = Math.max(0, d.list.length - 1);
      const maj = A.derniere_mise_a_jour ? `Mis à jour à ${f.time.format(new Date(A.derniere_mise_a_jour))}` : "";
      const places = c.places_restantes !== null
        ? `<div class="row" style="align-items:baseline"><div><span class="big">${c.places_restantes}</span> <span class="muted">${c.places_totales ? `places restantes sur ${c.places_totales}` : "places restantes"}</span></div>${chip(c.statut)}</div>
           ${c.taux !== null ? `<div class="bar main" role="img" aria-label="${pct(c.taux)} des places réservées"><span style="width:${Math.min(100, c.taux)}%"></span></div>
           <div class="row muted small"><span>Taux de remplissage ${pct(c.taux)}</span>${c.places_reservees !== null ? `<span>${c.places_reservees} réservées</span>` : ""}</div>` : ""}`
        : `<div class="row"><span class="muted">Les rendez-vous ne sont pas encore ouverts.</span>${chip(c.statut)}</div>`;
      const adresse = cfg.afficher_adresse
        ? `<div class="place">${ICON_PIN}<div><b>${esc([c.lieu, titre(c.commune)].filter(Boolean).join(" · "))}</b>
            <div class="muted small">${esc([c.adresse, km(c.distance)].filter(Boolean).join(" · "))}</div></div></div>`
        : "";
      const boutons = cfg.afficher_boutons
        ? `<div class="btns">
            ${lien ? `<a class="btn primary" href="${esc(lien)}" target="_blank" rel="noopener">Prendre rendez-vous</a>`
                   : `<a class="btn secondary block" href="https://dondesang.efs.sante.fr" target="_blank" rel="noopener">Site de l’EFS</a>`}
            ${iti ? `<a class="btn secondary" href="${esc(iti)}" target="_blank" rel="noopener">Itinéraire</a>` : ""}
          </div>`
        : "";
      const pied = cfg.afficher_pied && (maj || autres || A.api_disponible === false)
        ? `<div class="row muted xs foot"><span>${esc(maj)}${A.api_disponible === false ? " · API indisponible, données conservées" : ""}</span>
            <span>${autres ? `${autres} autre${autres > 1 ? "s" : ""} collecte${autres > 1 ? "s" : ""} dans ${esc(d.rayon)} km` : ""}</span></div>`
        : "";
      return `${entete}
        ${remplacee}
        <div><div class="kicker">${dansCommune ? `Prochaine collecte à ${esc(titre(c.commune || c.lieu))}` : d.filtre_actif ? "Prochaine collecte retenue" : "Prochaine collecte"} · ${this._days(c.debutDate, f)}</div>
          <div class="date">${esc(f.long.format(c.debutDate).replace(/^./, (x) => x.toUpperCase()))}</div>
          <div class="muted">${esc(horaires(c.horaires))}</div></div>
        ${adresse}<div>${places}</div>${boutons}${pied}`;
    }

    _agenda(d, f) {
      const cfg = this._config;
      const max = Math.max(1, Number(cfg.max) || 6);
      const rows = d.list.slice(0, max);
      const head = `<div class="row" style="align-items:baseline"><span class="h">Collectes à venir</span>
        <span class="muted small">${esc(d.list.length)} · ${esc(d.rayon)} km · ${esc(d.jours || "")} jours</span></div>`;
      if (!rows.length) return head + `<div class="empty">${this._vide(d)}</div>`;
      const items = rows.map((c) => {
        const lien = safeUrl(c.lien_rdv);
        let right;
        if (c.statut === ST.OUVERT) {
          right = `<span>${c.places_totales ? `${c.places_restantes} / ${c.places_totales}` : `${c.places_restantes} places`}</span>
            ${c.taux !== null ? `<div class="bar"><span style="width:${Math.min(100, c.taux)}%"></span></div>` : ""}
            ${lien && cfg.afficher_boutons ? `<a href="${esc(lien)}" target="_blank" rel="noopener">Rendez-vous</a>` : ""}`;
        } else right = chip(c.statut);
        const sous = cfg.afficher_adresse ? [c.lieu, km(c.distance)] : [km(c.distance)];
        return `<li><div class="d"><small>${esc(f.wd.format(c.debutDate))}</small><strong>${esc(f.day.format(c.debutDate))}</strong><em>${esc(f.mon.format(c.debutDate))}</em></div>
          <div class="who"><b>${esc(titre(c.commune || c.lieu))}</b><span>${esc(sous.filter(Boolean).join(" · "))}</span>
          <span>${esc(horaires(c.horaires))}</span></div>
          <div class="st">${right}</div></li>`;
      }).join("");
      const reste = d.list.length - rows.length;
      const ou = d.search ? "augmentez « Nombre de lignes »" : "calendrier « Collectes »";
      const plus = cfg.afficher_pied && reste > 0 ? `<div class="muted xs">+ ${reste} autre${reste > 1 ? "s" : ""} collecte${reste > 1 ? "s" : ""} (${ou})</div>` : "";
      return head + `<ul class="agenda">${items}</ul>` + plus;
    }

    _carte(d, f) {
      const cfg = this._config;
      const out = [];
      if (cfg.afficher_plan) out.push(this._plan(d, f));
      const duo = [];
      if (cfg.afficher_jauge) duo.push(this._jauge(d, f));
      if (cfg.afficher_remplissage) duo.push(this._remplissage(d, f));
      if (duo.length) out.push(`<div class="duo">${duo.join("")}</div>`);
      return out.join("");
    }

    _plan(d, f) {
      const centre = d.G.centre;
      const R = d.rayon;
      if (!centre) return `<div class="warn">Plan indisponible : mettez l’intégration à jour (v1.1.0 ou plus).</div>`;
      const W = 512, H = 440, CX = 256, CY = 220, RPX = 190, s = RPX / R;
      const cos = Math.cos((centre.latitude * Math.PI) / 180);
      const P = (lat, lon) => [CX + (lon - centre.longitude) * 111 * cos * s, CY - (lat - centre.latitude) * 111 * s];
      const step = [1, 2, 5, 10, 20, 25, 50].find((v) => R / v <= 3) || 50;
      let grid = "";
      for (let k = -Math.floor(R / step) * step; k <= R; k += step) {
        grid += `<line class="map-grid" x1="${CX + k * s}" y1="0" x2="${CX + k * s}" y2="${H}"/><line class="map-grid" x1="0" y1="${CY + k * s}" x2="${W}" y2="${CY + k * s}"/>`;
      }
      const lieux = new Map();
      for (const c of d.list) {
        if (c.latitude === undefined) continue;
        const k = `${c.lieu}|${c.latitude}|${c.longitude}`;
        if (!lieux.has(k)) lieux.set(k, c);
      }
      const first = d.list[0];
      const placed = [[CX - 12, CX + 12, CY - 12, CY + 12]];
      for (const c of lieux.values()) {
        const [x, y] = P(c.latitude, c.longitude);
        placed.push([x - 12, x + 12, y - 12, y + 12]);
      }
      let marks = "";
      for (const c of lieux.values()) {
        const [x, y] = P(c.latitude, c.longitude);
        const cls = c.statut === ST.OUVERT ? "mk-open" : c.statut === ST.COMPLET ? "mk-full" : "mk-closed";
        const isNext = c === first;
        const label = `${titre(c.commune || c.lieu)} · ${f.short.format(c.debutDate)}${c.statut === ST.COMPLET ? " complet" : ""}`;
        const w = label.length * 6.6;
        const box = (side, ly) => (side ? [x + 14, x + 14 + w] : [x - 14 - w, x - 14]).concat([ly - 11, ly + 3]);
        const hit = (b) => b[0] < 2 || b[1] > W - 2 || placed.some((q) => b[0] < q[1] && q[0] < b[1] && b[2] < q[3] && q[2] < b[3]);
        let right = x + 14 + w < W - 2, ly = y + 4, bx = box(right, ly);
        search: for (const off of [0, 15, -15, 30, -30, 45]) {
          for (const side of [right, !right]) {
            const cand = box(side, y + 4 + off);
            if (!hit(cand)) { right = side; ly = y + 4 + off; bx = cand; break search; }
          }
        }
        placed.push(bx);
        const osm = `https://www.openstreetmap.org/?mlat=${c.latitude}&mlon=${c.longitude}#map=16/${c.latitude}/${c.longitude}`;
        marks += `<a href="${esc(osm)}" target="_blank" rel="noopener"><title>${esc(`${c.lieu} – ${c.places_restantes === null ? "planning non ouvert" : `${c.places_restantes} places restantes`}`)}</title>
          <circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isNext ? 11 : 8}" ${isNext ? 'stroke-width="3"' : ""}/>
          <text class="map-label" x="${(right ? x + 14 : x - 14).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${right ? "start" : "end"}">${esc(label)}</text></a>`;
      }
      const dot = (cls) => `<svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" class="${cls}"/></svg>`;
      return `<div class="row" style="align-items:baseline"><span class="h">Collectes dans un rayon de ${esc(R)} km</span><span class="muted small">${lieux.size} lieu${lieux.size > 1 ? "x" : ""}</span></div>
        <svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Carte des collectes dans un rayon de ${R} km autour de ${esc(centre.libelle || "")}">
        <rect class="map-bg" x="0" y="0" width="${W}" height="${H}"/>${grid}
        <circle class="map-circle" cx="${CX}" cy="${CY}" r="${RPX}"/>
        <text class="map-small" x="${CX}" y="${CY - RPX - 8}" text-anchor="middle">${R} km</text>
        <text class="map-small" x="10" y="${H - 10}">Quadrillage : ${step} km</text>
        <circle class="map-home" cx="${CX}" cy="${CY}" r="9"/><path class="map-roof" d="M${CX - 5} ${CY + 2} L${CX} ${CY - 4} L${CX + 5} ${CY + 2} V${CY + 6} H${CX - 5} Z"/>
        ${marks}</svg>
        <div class="legend"><span>${dot("mk-open")}Planning ouvert</span><span>${dot("mk-closed")}Non ouvert</span><span>${dot("mk-full")}Complet</span></div>`;
    }

    _jauge(d, f) {
      const cible = d.list.find((c) => c.taux !== null);
      if (!cible) return `<div><span class="h">Remplissage</span><div class="empty">Aucune collecte au planning ouvert.</div></div>`;
      const p = Math.max(0, Math.min(100, cible.taux)) / 100;
      const a = Math.PI - p * Math.PI;
      const gx = (100 + 80 * Math.cos(a)).toFixed(1), gy = (100 - 80 * Math.sin(a)).toFixed(1);
      return `<div><span class="h">Remplissage · ${esc(titre(cible.commune || cible.lieu))}</span>
        <div class="muted small">${esc(f.long.format(cible.debutDate))} · prochaine collecte aux rendez-vous ouverts</div>
        <svg class="gauge" viewBox="0 0 200 116" role="img" aria-label="${pct(cible.taux)} des places réservées">
          <path class="gauge-bg" d="M20 100 A80 80 0 0 1 180 100"/>${p > 0 ? `<path class="gauge-fg" d="M20 100 A80 80 0 0 1 ${gx} ${gy}"/>` : ""}
          <text x="100" y="92" text-anchor="middle" font-size="30" class="g-strong">${pct(cible.taux)}</text>
          <text x="100" y="112" text-anchor="middle" font-size="11" class="g-muted">${cible.places_totales ? `${cible.places_totales - cible.places_restantes} réservées / ${cible.places_totales}` : ""}</text></svg></div>`;
    }

    _remplissage(d, f) {
      const remplies = d.list.filter((c) => c.taux !== null).slice(0, Math.max(1, Number(this._config.max) || 6));
      return `<div><div class="row" style="align-items:baseline"><span class="h">Places réservées par collecte</span></div>
        ${remplies.length ? `<ul class="fill" style="margin-top:10px">${remplies.map((c) => `<li>
          <div class="row"><span>${esc(f.short.format(c.debutDate))} · ${esc(titre(c.commune || c.lieu))}</span><span class="muted">${c.places_totales ? `${c.places_restantes} / ${c.places_totales} libres` : pct(c.taux)}</span></div>
          <div class="bar"><span style="width:${Math.min(100, c.taux)}%"></span></div></li>`).join("")}</ul>`
          : `<div class="empty">Les compteurs apparaîtront à l’ouverture des plannings.</div>`}</div>`;
    }
  }

  // ---------------------------------------------------------------- éditeur
  const LABELS = {
    entity: "Instance (zone surveillée)",
    vue: "Vue",
    commune: "Collecte présentée (vue « prochaine collecte »)",
    titre: "Titre de la carte (facultatif)",
    filtre: "Collectes affichées",
    jours: "Limiter aux prochains jours",
    distance_max: "Limiter à une distance (km)",
    max: "Nombre de lignes (agenda, remplissage)",
    couleur: "Couleur d’accent",
    afficher_entete: "En-tête « Don du sang »",
    afficher_adresse: "Lieu et adresse",
    afficher_boutons: "Boutons et liens de rendez-vous",
    afficher_pied: "Pied de carte (mise à jour, compteurs)",
    afficher_plan: "Plan des lieux",
    afficher_jauge: "Jauge de remplissage",
    afficher_remplissage: "Places réservées par collecte",
    code_postal: "Code postal du point de départ",
    commune_depart: "Commune de départ (facultatif)",
    rayon_km: "Rayon d’action",
    type_don: "Type de collecte",
    inclure_professionnelles: "Inclure les collectes en entreprise / établissement scolaire",
    afficher_formulaire: "Champs de recherche modifiables dans la carte",
    actualisation: "Actualisation (minutes)",
  };
  // Libellés qui changent de sens en mode recherche.
  const LABELS_RECHERCHE = { jours: "Nombre de jours (à partir d’aujourd’hui)" };
  const HELPERS = {
    entity: "N’importe quelle entité de l’instance ; vide = première instance trouvée.",
    commune: "Choisissez une commune pour présenter sa prochaine collecte plutôt que la plus proche dans le temps. Vous pouvez aussi saisir un nom.",
    jours: "Vide = horizon de l’intégration.",
    distance_max: "Vide = rayon de l’intégration ; ne peut pas l’élargir.",
    max: "La liste reçue de l’intégration est plafonnée par son réglage « Nombre maximum de collectes listées ».",
    code_postal: "Renseigné, la carte fait sa propre recherche (rayon, type, jours ci-dessous) et n’utilise plus d’instance. Vide = instance choisie plus haut.",
    commune_depart: "Nom ou code INSEE, si le code postal couvre plusieurs communes (défaut : la première par ordre alphabétique).",
    afficher_formulaire: "Permet de changer le code postal, le rayon, le type et le nombre de jours depuis la carte, sans modifier sa configuration.",
    actualisation: "Les réponses sont mises en cache 15 min par l’intégration.",
  };
  const HELPERS_RECHERCHE = { jours: "Défaut : 30 jours." };

  /** Communes des collectes à venir de l'instance, avec leurs dates, pour la liste de l'éditeur. */
  function communesDe(hass, cfg) {
    if (!hass) return [];
    const choisie0 = cfg.commune && cfg.commune !== COMMUNE_AUTO ? cfg.commune : null;
    if (cfg.code_postal || cfg.afficher_formulaire) {
      // Recherche propre à la carte : les communes dépendent de la réponse, saisie libre.
      return [{ value: COMMUNE_AUTO, label: "Prochaine collecte (la plus proche dans le temps)" },
        ...(choisie0 ? [{ value: choisie0, label: titre(choisie0) }] : [])];
    }
    const { agenda } = resolveInstance(hass, cfg);
    const list = hass.states?.[agenda]?.attributes?.collectes || [];
    const fmt = new Intl.DateTimeFormat("fr-FR", { timeZone: hass.config?.time_zone || TZ_FALLBACK, day: "2-digit", month: "2-digit" });
    const groupes = new Map();
    for (const c of list) {
      const nom = c.commune || c.lieu;
      if (!nom) continue;
      const k = cle(nom);
      if (!groupes.has(k)) groupes.set(k, { value: nom, dates: [] });
      const g = groupes.get(k);
      if (c.debut) g.dates.push(fmt.format(new Date(c.debut)));
    }
    const options = [...groupes.values()].map((g) => ({
      value: g.value,
      label: `${titre(g.value)} · ${g.dates.slice(0, 4).join(", ")}${g.dates.length > 4 ? "…" : ""}`,
    }));
    const choisie = cfg.commune && cfg.commune !== COMMUNE_AUTO ? cfg.commune : null;
    if (choisie && !groupes.has(cle(choisie))) {
      options.push({ value: choisie, label: `${titre(choisie)} · aucune collecte à venir dans la liste` });
    }
    return [{ value: COMMUNE_AUTO, label: "Prochaine collecte (la plus proche dans le temps)" }, ...options];
  }

  function editorSchema(vue, communes, recherche) {
    const syn = vue === "synthese" || vue === "complet";
    const ag = vue === "agenda" || vue === "complet";
    const ca = vue === "carte" || vue === "complet";
    const affichage = [
      syn && { name: "afficher_entete", selector: { boolean: {} } },
      (syn || ag) && { name: "afficher_adresse", selector: { boolean: {} } },
      (syn || ag) && { name: "afficher_boutons", selector: { boolean: {} } },
      (syn || ag) && { name: "afficher_pied", selector: { boolean: {} } },
      ca && { name: "afficher_plan", selector: { boolean: {} } },
      ca && { name: "afficher_jauge", selector: { boolean: {} } },
      ca && { name: "afficher_remplissage", selector: { boolean: {} } },
    ].filter(Boolean);
    const jours = { name: "jours", selector: { number: { min: 1, max: 180, mode: "box", unit_of_measurement: "j" } } };
    const sectionRecherche = {
      type: "expandable", name: "", title: "Recherche (point de départ, rayon, type, jours)", icon: "mdi:map-search-outline",
      flatten: true, expanded: recherche,
      schema: [
        { type: "grid", name: "", schema: [
          { name: "code_postal", selector: { text: {} } },
          recherche && { name: "commune_depart", selector: { text: {} } },
        ].filter(Boolean) },
        recherche && { type: "grid", name: "", schema: [
          { name: "rayon_km", selector: { number: { min: 1, max: 50, mode: "box", unit_of_measurement: "km" } } },
          jours,
        ] },
        recherche && { name: "type_don", selector: { select: { mode: "dropdown", options: Object.entries(DON).map(([value, label]) => ({ value, label })) } } },
        recherche && { name: "inclure_professionnelles", selector: { boolean: {} } },
        { name: "afficher_formulaire", selector: { boolean: {} } },
        recherche && { name: "actualisation", selector: { number: { min: 5, max: 360, mode: "box", unit_of_measurement: "min" } } },
      ].filter(Boolean),
    };
    return [
      !recherche && { name: "entity", selector: { entity: { filter: [{ integration: DOMAIN, domain: "sensor" }] } } },
      {
        name: "vue", required: true,
        selector: { select: { mode: "dropdown", options: [
          { value: "complet", label: "Complète (les trois)" },
          { value: "synthese", label: "Prochaine collecte" },
          { value: "agenda", label: "Agenda des collectes" },
          { value: "carte", label: "Plan et remplissage" },
        ] } },
      },
      syn && {
        name: "commune",
        selector: { select: { mode: "dropdown", custom_value: true, options: communes } },
      },
      { name: "titre", selector: { text: {} } },
      sectionRecherche,
      {
        type: "expandable", name: "", title: "Filtres", icon: "mdi:filter-variant", flatten: true,
        schema: [
          { name: "filtre", selector: { select: { mode: "list", options: [
            { value: "toutes", label: "Toutes les collectes" },
            { value: "rdv_ouverts", label: "Seulement celles où l’on peut prendre rendez-vous" },
          ] } } },
          { type: "grid", name: "", schema: [
            !recherche && jours,
            { name: "distance_max", selector: { number: { min: 1, max: 50, mode: "box", unit_of_measurement: "km" } } },
          ].filter(Boolean) },
          { name: "max", selector: { number: { min: 1, max: 30, mode: "slider" } } },
        ],
      },
      {
        type: "expandable", name: "", title: "Affichage", icon: "mdi:eye-outline", flatten: true,
        schema: [
          { type: "grid", name: "", schema: affichage },
          { name: "couleur", selector: { color_rgb: {} } },
        ],
      },
    ].filter(Boolean);
  }

  class EfsCollectesCardEditor extends HTMLElement {
    setConfig(config) {
      this._config = { ...config };
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._form) return;
      this._form.hass = hass;
      const sig = JSON.stringify(communesDe(hass, this._config || {}));
      if (sig !== this._communesSig) this._render();
    }

    connectedCallback() {
      this._ensureComponents().then(() => this._render());
    }

    async _ensureComponents() {
      // ha-form est chargé à la demande par Home Assistant : on force son chargement.
      if (customElements.get("ha-form") || !window.loadCardHelpers) return;
      try {
        const helpers = await window.loadCardHelpers();
        const card = await helpers.createCardElement({ type: "entities", entities: [] });
        await card.constructor.getConfigElement();
      } catch (e) {
        /* l'éditeur YAML reste disponible */
      }
    }

    _render() {
      if (!this._config) return;
      if (!this._form) {
        this._form = document.createElement("ha-form");
        const rech = () => Boolean(this._config?.code_postal || this._config?.afficher_formulaire);
        this._form.computeLabel = (s) => (rech() && LABELS_RECHERCHE[s.name]) || LABELS[s.name] || s.title || s.name;
        this._form.computeHelper = (s) => (rech() && HELPERS_RECHERCHE[s.name]) || HELPERS[s.name];
        this._form.addEventListener("value-changed", (ev) => this._changed(ev.detail.value));
        this.replaceChildren(this._form);
      }
      const data = { ...DEFAULTS, ...this._config };
      if (typeof data.couleur === "string" && /^#[0-9a-f]{6}$/i.test(data.couleur)) {
        data.couleur = [1, 3, 5].map((i) => parseInt(data.couleur.slice(i, i + 2), 16));
      }
      this._form.hass = this._hass;
      this._form.data = data;
      const communes = communesDe(this._hass, this._config);
      this._communesSig = JSON.stringify(communes);
      this._form.schema = editorSchema(data.vue, communes, Boolean(data.code_postal || data.afficher_formulaire));
    }

    _changed(value) {
      const config = { type: this._config.type || "custom:efs-collectes-card" };
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined || v === null || v === "") continue;
        if (k !== "vue" && k in DEFAULTS && DEFAULTS[k] === v) continue; // n'écrit que ce qui diffère du défaut
        config[k] = v;
      }
      config.vue = value.vue || "complet";
      this._config = config;
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      this._render();
    }
  }

  if (!customElements.get("efs-collectes-card-editor")) {
    customElements.define("efs-collectes-card-editor", EfsCollectesCardEditor);
  }
  if (!customElements.get("efs-collectes-card")) {
    customElements.define("efs-collectes-card", EfsCollectesCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
      type: "efs-collectes-card",
      name: "EFS – Collectes de don du sang",
      description: "Prochaine collecte, agenda, plan et remplissage, pour une instance ou une recherche propre à la carte (code postal, rayon, type de collecte, nombre de jours).",
      preview: true,
      documentationURL: "https://github.com/Laurent14760/HomeAssistant_DonduSang_Card",
    });
    console.info(`%c EFS-COLLECTES-CARD %c v${VERSION} `, "background:#B42318;color:#fff", "");
  }
})();
